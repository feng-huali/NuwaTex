# TexLite 论文写作 API（单人操作）

本文整理 TexLite 当前可供第三方平台或自动化程序使用的论文写作 HTTP API，覆盖创建项目、管理文件、设置编译器、编译和下载 PDF。范围限定为项目拥有者单人操作，不包括项目成员、批注和实时协作 API。

## 约定

- 所有路径都以 `/api` 开头，并受配置项 `basePath` 影响。例如 `basePath` 为 `/texlite` 时，`/api/projects` 的完整路径是 `/texlite/api/projects`。
- 以下用 `BASE` 表示站点 origin（如 `https://texlite.example.com`），用 `API` 表示 `BASE + basePath + /api`，用 `PROJECT_ID` 表示项目 UUID。
- 后台自动化使用 Nuwax 的 `SANDBOX_ACCESS_KEY`，通过 `Authorization: Bearer ...` 鉴权；浏览器继续使用 Nuwax OAuth 登录后建立的 TexLite 会话 Cookie。
- JSON 请求需设置 `Content-Type: application/json`。文件上传使用 `multipart/form-data`，表单字段名为 `file`。
- 项目内路径均为相对路径，使用 `/` 分隔，例如 `chapters/intro.tex`；不要传操作系统绝对路径。带中文或空格的 query 参数要进行 URL 编码。
- 成功响应通常为 JSON；文件、PDF、ZIP 下载是二进制响应。错误响应为 `{ "code": "...", "error": "...", ... }`，客户端应优先依据 `code` 处理错误。
- 如果启用了 iframe 登录支持，Cookie 认证的写操作还必须带 `X-TexLite-Request: 1` 请求头。沙箱 Bearer 认证成功的请求不需要这个头。
- 创建项目和写文件等操作受用户配额、文件大小及站点配置约束。先读取 `/api/config`，不要在客户端硬编码站点上限。

## 后台自动化：Nuwax 沙箱凭证认证

Nuwax 自动化环境为每次请求提供 `SANDBOX_ACCESS_KEY`。调用 TexLite 时直接设置请求头：

```http
Authorization: Bearer <SANDBOX_ACCESS_KEY>
```

TexLite 在服务端把同一个凭证发送到管理员配置的 Nuwax 用户信息接口。成功响应的顶层 `id` 字段应与该用户 OAuth 返回的 `sub` 一致；TexLite 按 `nuwax_subject` 查找关联用户，并继续检查账号状态、项目权限和存储配额。不会创建 Cookie 会话，也不会保存该沙箱凭证；每个 Bearer 请求都会重新查询 Nuwax。

### 验证地址配置

在 `texlite.config.json` 中设置：

```json
{
  "sandboxAuth": {
    "userInfoUrl": "https://testagent.xspaceagi.com/api/v1/4sandbox/user/info"
  }
}
```

上述 URL 也是默认值。此地址独立于浏览器 OAuth 的 `OAuth.baseURL`；生产环境可改为 `https://agent.nuwax.com/api/v1/4sandbox/user/info`。环境变量 `TEXLITE_SANDBOX_USER_INFO_URL` 可以覆盖文件配置。验证地址须使用 HTTPS；本地 mock 测试可使用 localhost/127.0.0.1 的 HTTP 地址。地址只能由管理员配置，不从调用方请求中读取；请求不跟随重定向。

### 调用方式与适用范围

例如，直接在 Nuwax 自动化环境执行：

```bash
API='https://texlite.example.com/api'
curl -sS -H "Authorization: Bearer $SANDBOX_ACCESS_KEY" "$API/me"
curl -sS -H "Authorization: Bearer $SANDBOX_ACCESS_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"论文标题"}' "$API/projects"
```

本章后续项目、文件、编译和下载 API 均支持此认证方式。凭证只用于本文列出的论文操作 API 和 `GET /api/me`、`GET /api/config`、`GET /api/health`；用户管理、改密码、成员管理和实时协作等接口不接受沙箱凭证。后台 HTTP 请求不受浏览器同源或 CORS 限制，无需取得浏览器 Cookie。

第一版要求该 Nuwax 用户已经在 TexLite 有关联账号，可先通过浏览器 Nuwax OAuth 登录一次。未关联账号不自动注册。沙箱凭证由 Nuwax 管理，TexLite 不替调用方刷新它；存在 Authorization 头但验证失败时，也不会回退到 Cookie。

### 认证错误

| HTTP 状态 | code | 含义 |
|---|---|---|
| 401 | `SANDBOX_AUTH_INVALID` | Bearer 格式错误，或 Nuwax 拒绝凭证。 |
| 403 | `SANDBOX_ACCOUNT_NOT_LINKED` | 用户尚未关联 TexLite 账号。 |
| 403 | `AUTH_DISABLED` | TexLite 账号已禁用。 |
| 403 | `SANDBOX_API_FORBIDDEN` | 此接口不接受沙箱凭证。 |
| 502 | `SANDBOX_AUTH_RESPONSE_INVALID` | 上游响应不是有效 JSON 或未包含有效的顶层 id。 |
| 502/503 | `SANDBOX_AUTH_UNAVAILABLE` | 上游服务失败、限流或无法连接。 |
| 504 | `SANDBOX_AUTH_TIMEOUT` | 验证请求（含读取响应体）超过 10 秒。 |

## 浏览器登录：Nuwax OAuth

用户访问 TexLite 网页时，通过 Nuwax OAuth 建立浏览器会话。这个流程也用于首次关联 TexLite 账号。需要区分两种凭证：

- **Nuwax OAuth access token**：TexLite 后端用它获取用户资料，必要时在服务端刷新；凭证加密保存在 TexLite 服务端，不会返回给浏览器或第三方 API 调用方。它不是 TexLite API 的 Bearer token。
- **TexLite 会话 Cookie**：OAuth 成功后，TexLite 在回调响应中设置 HttpOnly 会话 Cookie。后续 TexLite API 请求使用这个 Cookie 鉴权。浏览器会自动携带同站 Cookie；页面 JavaScript 不能读取 HttpOnly Cookie 的值，这是预期的安全设计。

### 浏览器 OAuth 流程

1. 让用户在浏览器中导航到 `BASE + basePath + /api/auth/nuwax`。TexLite 会跳转到 Nuwax 授权页，并申请配置好的 `profile,user:search` scope。
2. 用户在 Nuwax 完成授权后，Nuwax 将浏览器重定向到管理员登记的 `redirectUri`，即 TexLite 的 `/auth/nuwax/callback`。
3. TexLite 服务端校验一次性 `state` 和 OAuth 状态 Cookie，用授权码在服务端交换 Nuwax token、读取用户资料，并设置 TexLite 会话 Cookie。
4. 登录成功后浏览器回到发起登录时指定的安全站内地址（默认回到站点）。调用 `GET API/me` 确认会话已建立，再使用同一浏览器会话调用项目 API。

OAuth 回调不会在 JSON 响应中交付可保存并用于 TexLite API 的 token；凭证通过 HttpOnly Cookie 设置。这是浏览器交互式登录，不是面向后台脚本的 OAuth token 换取接口。不要把授权码、Nuwax access/refresh token 或 Client Secret 交给第三方 AI 服务。

### 后续 API 请求如何携带会话

同源网页中的 `fetch` 可这样调用，浏览器会自动携带 TexLite Cookie：

```js
const response = await fetch(`${API}/projects`, {
  credentials: "same-origin"
});
```

若调用代码运行在另一个 origin，通常需要 `credentials: "include"`，并且 TexLite 部署必须允许该 origin 的凭证式 CORS。第三方 iframe 还会受浏览器第三方 Cookie 策略影响；不要假设跨站 Cookie 一定可用。最稳妥的方式是让 API 请求由 TexLite 页面或同源后端发出。启用 iframe 登录时，写操作还必须添加 `X-TexLite-Request: 1`。

`GET API/me` 返回 `{ "user": ... }`，用于检查当前会话身份；`POST API/auth/logout` 注销当前 TexLite 会话。

### 本地账号登录（兼容方式）

`POST API/auth/login` 接收 `{ "username": "...", "password": "..." }`，成功后同样设置 TexLite HttpOnly 会话 Cookie。它只是本地兼容登录方式，不是 Nuwax OAuth 流程，也不应作为第三方集成的首选凭证获取方式。

### 读取站点能力

`GET API/config` 无需登录，返回运行配置中适合客户端使用的部分，包括 `basePath`、`maxUploadSizeMB`、`maxCollaborativeFileSizeMB`、`allowedEngines`、`nuwaxOAuthEnabled` 和 `iframeLoginEnabled`。

## 论文项目工作流

推荐顺序：读取能力配置 → 登录 → 创建项目或导入 ZIP → 创建/上传/写入文件 → 选择主文档和编译器 → 编译 → 下载 PDF。

### 创建空项目

```http
POST API/projects
Content-Type: application/json

{"name":"论文标题"}
```

成功为 `201`，返回 `{ "project": { "id": "...", "name": "...", "mainFile": "main.tex", "engine": "xelatex", ... } }`。项目会自动包含初始 `main.tex`；响应中的 `project.id` 用于后续请求。

### 从 ZIP 导入项目

```http
POST API/projects/import
Content-Type: multipart/form-data

file=<项目压缩包.zip>
```

表单字段必须为 `file`，文件名须以 `.zip` 结尾。成功为 `201` 并返回 `{ "project": ... }`。压缩包会经过校验后解压；大小上限由站点配置决定，ZIP 内的路径也会做安全校验。可在 `GET API/config` 查看上传上限。

### 查看项目与文件树

| 操作 | 请求 | 说明 |
|---|---|---|
| 列出当前用户项目 | `GET API/projects` | 支持 `page`、`pageSize`、`search`、`sort` 等查询参数；返回 `projects` 和 `pagination`。 |
| 查看项目详情 | `GET API/projects/PROJECT_ID` | 包含当前主文件、编译器和项目权限等信息。 |
| 列出文件/文件夹 | `GET API/projects/PROJECT_ID/files` | 返回 `{ "files": [{"path":"...","type":"file"|"directory","size":...}] }`。 |
| 找出可选主文档 | `GET API/projects/PROJECT_ID/main-files` | 返回 `{ "texFiles": [...], "mainFiles": [...] }`。只有 `.tex` 文件可作主文档。 |

### 创建文件夹

```http
POST API/projects/PROJECT_ID/folders
Content-Type: application/json

{"path":"chapters"}
```

成功为 `201`，返回 `{ "ok": true, "path": "chapters" }`。`path` 是项目内相对目录路径；目标已存在时返回冲突错误。

### 创建新文件（不覆盖）

```http
POST API/projects/PROJECT_ID/file
Content-Type: application/json

{"path":"chapters/intro.tex","content":"\\section{Introduction}\n"}
```

成功为 `201`，返回文件信息。该接口专用于新建；路径已存在时不会覆盖，返回冲突错误。

### 读取/更新文件

读取文本：

```http
GET API/projects/PROJECT_ID/file?path=chapters%2Fintro.tex
```

返回 `{ "path": "chapters/intro.tex", "content": "..." }`。获取原始文件（例如图片）：

```http
GET API/projects/PROJECT_ID/file/raw?path=figures%2Fplot.png
```

写入或完整覆盖文本文件：

```http
PUT API/projects/PROJECT_ID/file
Content-Type: application/json

{"path":"chapters/intro.tex","content":"\\section{Introduction}\nUpdated text.\n"}
```

成功返回 `{ "ok": true, ... }`。自动化客户端应在 PUT 前 GET 并基于最新内容修改，避免覆盖其他来源刚写入的版本。对于普通论文写作自动化，建议按文件串行执行写操作。

### 上传单个文件

```http
POST API/projects/PROJECT_ID/upload?directory=figures
Content-Type: multipart/form-data

file=<plot.png>
```

`directory` 可省略（省略时放在项目根目录）。默认不覆盖同名文件；明确要覆盖时使用 `?overwrite=1`。成功返回 `{ "ok": true, "path": "figures/plot.png" }`。文本协作文件与普通附件可能有不同大小限制，以 `/api/config` 为准。

### 移动或重命名文件/文件夹

```http
PATCH API/projects/PROJECT_ID/path
Content-Type: application/json

{"source":"chapters/draft.tex","destinationDirectory":"chapters","destinationName":"intro.tex"}
```

`destinationDirectory` 使用项目内相对目录；空字符串表示项目根目录。`destinationName` 可省略，省略时保留原名。目标已存在会报冲突。若移动的是文件夹，不能把它移入自身或其子目录。主文档不能被改名为非 `.tex` 文件；如需调整主文档，先更新项目设置。

### 删除文件或文件夹

```http
DELETE API/projects/PROJECT_ID/file?path=chapters%2Fintro.tex
```

该接口也可删除整个文件夹树。当前主文档及其上级目录不能删除；删除操作不可通过此 API 撤销，自动化调用前应确认路径。

### 设置项目名称、主文档和编译器

```http
PATCH API/projects/PROJECT_ID
Content-Type: application/json

{"name":"论文标题","mainFile":"main.tex","engine":"xelatex"}
```

字段可单独提供。`mainFile` 必须指向项目内存在且符合主文档候选条件的 `.tex` 文件。编译器以 `/api/config` 返回的 `allowedEngines` 为准；当前通常为 `pdflatex`、`xelatex`、`lualatex`。注意 API 的 pdfTeX 编译器标识是 `pdflatex`，不是 `pdftex`。成功响应为 `{ "project": ... }`。

## 编译与 PDF

### 编译

```http
POST API/projects/PROJECT_ID/compile
Content-Type: application/json

{"mainFile":"main.tex"}
```

请求体可省略或省略 `mainFile`，此时编译项目当前配置的主文档。该请求会等待本次编译结束后返回结果，包括 `runId`、`ok`、`log`、`diagnostics`、`pdfUrl`、`pdfCompiledAt`、`pdfSizeBytes` 等字段；不要把它当作立即返回的后台任务接口。编译失败时也应检查 `ok`、`diagnostics` 和 `log`，而不只看 HTTP 状态码。

若服务返回 `409`，例如协作/文件快照仍在变化，应稍后重试；`POST API/projects/PROJECT_ID/compile/cancel` 可尝试取消正在运行的编译，JSON 请求体可指定 `{"mainFile":"main.tex"}`。

### 查询最近编译状态

```http
GET API/projects/PROJECT_ID/compile/latest?mainFile=main.tex
```

返回指定主文档的 `latestRun`、诊断、`hasPdf`、`pdfUrl`、编译时间和 PDF 大小等信息。`mainFile` 可省略，默认取项目当前主文档。

### 下载 PDF

编译响应中的 `pdfUrl` 可直接请求；也可使用：

```http
GET API/projects/PROJECT_ID/pdf?mainFile=main.tex&download=1
```

该接口返回 `application/pdf`。加 `download=1` 时响应按附件下载；如果从某次特定成功编译下载，可把该次 `runId` 放入 `run` 参数，避免拿到之后更新的 PDF。下载请求同样需要沙箱 Bearer 凭证或有效的 TexLite 会话 Cookie。

### 获取编译产物或打包项目

- `GET API/projects/PROJECT_ID/compile/artifacts?mainFile=main.tex` 列出最近一次已发布编译的产物；加 `path=main.log` 获取具体产物，加 `download=1` 下载二进制产物。
- `GET API/projects/PROJECT_ID/download` 下载整个项目 ZIP（源码及项目文件，不等同于 PDF）。

## 外部 AI 操作流程

AI 推理和提示词管理由外部平台完成，TexLite 提供项目文件和编译 API。Nuwax 自动化可使用沙箱 Bearer 凭证依次执行：

1. 查看项目、文件树，并读取目标文件及所需上下文文件。
2. 在外部 AI 平台生成或修改 LaTeX 内容，再通过文件 PUT 接口写入完整内容。
3. 调用编译接口，根据返回的诊断和日志继续修改，直到编译成功。
4. 下载成功编译的 PDF，或打包下载整个项目。

这些操作不依赖浏览器编辑器、选区或光标。TexLite 不提供内置 AI 生成、流式预览、确认写入接口，也无需配置 AI 服务地址或密钥。

## curl 调用骨架（Nuwax 自动化环境）

以下直接使用 Nuwax 注入的 `SANDBOX_ACCESS_KEY`，无需本地账号密码或 Cookie 文件。替换站点、项目 ID；如果站点配置了 basePath，也要包含在 API 地址里。

```bash
API='https://texlite.example.com/api'

# 确认沙箱凭证对应的 TexLite 用户
curl -sS -H "Authorization: Bearer $SANDBOX_ACCESS_KEY" "$API/me"

# 创建项目
curl -sS -H "Authorization: Bearer $SANDBOX_ACCESS_KEY" -H 'Content-Type: application/json' \
  -d '{"name":"自动化论文"}' "$API/projects"

# 写入文件（先替换 PROJECT_ID）
curl -sS -H "Authorization: Bearer $SANDBOX_ACCESS_KEY" -X PUT -H 'Content-Type: application/json' \
  -d '{"path":"main.tex","content":"\\documentclass{article}\n\\begin{document}\nHello\\end{document}\n"}' \
  "$API/projects/PROJECT_ID/file"

# 编译并下载 PDF
curl -sS -H "Authorization: Bearer $SANDBOX_ACCESS_KEY" -H 'Content-Type: application/json' \
  -d '{"mainFile":"main.tex"}' "$API/projects/PROJECT_ID/compile"
curl -sS -H "Authorization: Bearer $SANDBOX_ACCESS_KEY" -o paper.pdf \
  "$API/projects/PROJECT_ID/pdf?mainFile=main.tex&download=1"
```

## 当前边界

后台自动化可直接使用 Nuwax 沙箱凭证操作已关联用户有权访问的项目。此凭证与 Nuwax OAuth access token 是不同的认证机制，不应混用；TexLite 不另外签发服务令牌。浏览器继续使用 OAuth 和 Cookie。实时 Yjs/WebSocket 协议不在本文范围内。
