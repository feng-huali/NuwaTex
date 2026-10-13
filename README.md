# TexLite

TexLite 是女娲（Nuwax）生态中的在线 LaTeX 写作与协作工作台，面向论文、报告和技术文档。
用户可以通过 Nuwax 账号登录，在浏览器中管理项目、编辑源码、编译和预览 PDF，并邀请协作者共同写作。

TexLite 提供写作工作区和编译服务，Nuwax 智能体与自动化应用通过 API 读写项目、触发编译并获取成果，
将人工编辑、团队协作和 AI 辅助写作连接到同一套项目文件中。平台支持独立部署、开放注册，
也可以嵌入 Nuwax 或其他应用的页面。

## 核心能力

- **LaTeX 写作**：在线编辑、项目文件管理、PDF 预览和源码与 PDF 双向定位；
  支持 pdfLaTeX、XeLaTeX 和 LuaLaTeX，编译引擎由管理员配置。
- **Nuwax 账号**：通过 OAuth 登录并建立账号关联，注册用户默认可以创建项目。
  用户名和显示名可在个人页面修改，长度上限均为 50；邮箱为可选信息。
- **团队协作**：支持实时共同编辑、成员权限、批注、`@` 提及和协作者状态展示。
  按手机号精确检索 Nuwax 用户并发送邀请，被邀请者接受后加入项目；手机号只用于检索，不写入 TexLite。
- **只读分享**：项目所有者可生成和撤销只读链接。通过链接访问的用户可以查看项目，
  编辑、批注和提及需要明确加入项目并获得相应权限；撤销链接不会移除已有成员。
- **智能体与自动化**：Nuwax 自动化应用可使用沙箱凭证管理项目、读写文件、编译和下载 PDF。
  AI 推理与任务编排由外部平台完成，TexLite 提供受项目权限和配额约束的 API。
- **部署与集成**：使用 PostgreSQL 保存业务数据，项目文件存储在部署实例中；
  提供用户配额、反向代理配置和基于来源白名单的 iframe 嵌入支持。

## 快速开始

### 环境要求

- Node.js 24 或更新版本，以及 npm。
- 已运行的 PostgreSQL 服务和一个空数据库；数据库用户需具备连接、创建表和修改表结构的权限。
- LaTeX 工具链（如 TeX Live）和 `latexmk`，相关命令需在 `PATH` 中可用。
  默认启用 `pdflatex`、`xelatex`、`lualatex`，启动时会检查所有已启用引擎；
  若只安装部分引擎，请相应设置 `latex.allowedEngines` 和 `latex.defaultEngine`。
  文档使用参考文献或索引时，还需安装对应的 BibTeX、Biber 或 MakeIndex。
- 用于账号登录与用户检索的 Nuwax OAuth 应用，登记回调地址和 `user:search` scope。

编译参数由服务端管理，不加载项目中的 `latexmkrc` 文件。

### 源码部署

获取源码、安装依赖并准备配置文件：

```bash
git clone https://github.com/feng-huali/nuwax-texlite.git
cd nuwax-texlite
npm ci
cp texlite.postgres.config.example.json texlite.config.json
export TEXLITE_CONFIG="$PWD/texlite.config.json"
```

编辑 `texlite.config.json`，配置文件存储目录和 Nuwax OAuth 信息，详见下文。
示例数据库名为 `texlite-demo`，请先在 PostgreSQL 中创建它，并通过环境变量提供真实连接串：

```bash
export TEXLITE_DATABASE_URL='postgresql://postgres:CHANGE_ME@127.0.0.1:5432/texlite-demo'
```

将用户名、密码、主机和数据库名替换为实际值。OAuth 回调地址必须与 Nuwax 应用后台登记的地址一致；
本地按默认端口启动时可使用 `http://localhost:3000/auth/nuwax/callback`。

完成配置后，构建、初始化首个管理员并启动服务：

```bash
npm run build
npm run init
npm start
```

初始化会自动执行数据库迁移，并提示输入管理员信息。默认访问地址为 `http://localhost:3000`，
普通用户通过“使用 Nuwax 登录”建立账号。后续启动会自动执行尚未完成的迁移，无需重复初始化管理员。
公网部署应配置 HTTPS 反向代理；完整初始化、进程管理和升级步骤参见
[生产部署文档](docs/production-postgresql-deployment.md)。

### 本地开发

完成依赖安装与配置后，首次使用开发环境执行：

```bash
npm run dev:init
```

如果所连接的数据库已有有效管理员，可直接启动。在两个终端分别运行：

```bash
npm run dev
```

```bash
npm run dev:web
```

前端地址为 `http://localhost:5173`，后端端口为 `3001`；开发环境 OAuth 回调可配置为
`http://localhost:3001/auth/nuwax/callback`。开发脚本固定使用源码目录中的 `texlite.config.json`
和 `data/`，数据库仍由该配置或 `TEXLITE_DATABASE_URL` 决定，建议使用专门的开发数据库。

提交代码前可运行 `npm run typecheck` 和 `npm test`。PostgreSQL 并发集成测试的配置见下文。

## Nuwax OAuth 配置

在配置文件中填写管理员登记的 Nuwax OAuth 信息。示例中的 `redirectUri` 故意留空，必须由管理员
根据 Nuwax 应用后台登记的地址显式填写；本地测试时通常是
`http://localhost:3001/auth/nuwax/callback`。

```json
{
  "OAuth": {
    "baseURL": "https://testagent.xspaceagi.com",
    "clientId": "",
    "clientSecret": "",
    "redirectUri": ""
  }
}
```

应用需要登记 `user:search` scope。TexLite 按 Nuwax 的既有约定使用逗号分隔的
`profile,user:search`，不是空格分隔。Client Secret 只放在服务端配置或环境变量中，不要提交到 Git。
项目所有者首次使用手机号邀请前，需要先通过 Nuwax 登录一次，以便服务端取得带有该用户租户上下文的访问令牌。

## Nuwax 自动化 API 认证

Nuwax 自动化请求可携带 `Authorization: Bearer <SANDBOX_ACCESS_KEY>`。
TexLite 用该凭证查询 Nuwax 用户信息接口，将返回的 `id` 对应到已关联账号的 OAuth `sub`，
然后执行现有项目权限和配额检查。用户需已在 TexLite 注册；不会自动新建账号。

验证地址独立于 OAuth 登录地址，配置为：

```json
{
  "sandboxAuth": {
    "userInfoUrl": "https://testagent.xspaceagi.com/api/v1/4sandbox/user/info"
  }
}
```

上述地址也是默认值，可通过 `TEXLITE_SANDBOX_USER_INFO_URL` 覆盖。
接口范围、论文写作流程和完整调用示例参见 [论文写作 API 文档](docs/third-party-writing-api.md)。

## PostgreSQL（全新部署）

先在 PostgreSQL 中创建一个空数据库（例如 `texlite-demo`），
然后以 [texlite.postgres.config.example.json](texlite.postgres.config.example.json) 为基础配置；
表结构由 TexLite 的版本化迁移自动创建。

```json
{
  "storage": {
    "dataDir": "./data-postgres"
  },
  "database": {
    "driver": "postgresql",
    "url": "postgresql://postgres:CHANGE_ME@127.0.0.1:5432/texlite-demo",
    "sslMode": "disable"
  }
}
```

连接串格式为：

```text
postgresql://<用户名>:<密码>@<主机>:<端口>/<数据库名>
postgresql://postgres:CHANGE_ME@127.0.0.1:5432/texlite-demo
             └用户名┘ └──密码──┘ └─主机──┘ └端口┘ └数据库名┘
```

因此，对本地已创建的 `texlite-demo`、用户为 `postgres` 的数据库，只需将示例中的
`CHANGE_ME` 替换为 PostgreSQL 用户密码。不要把带密码的连接串提交到 Git；公网部署建议将完整
连接串放在 `TEXLITE_DATABASE_URL` 环境变量中，配置文件可保留占位值以说明连接目标。若数据库
要求 TLS，将 `sslMode` 设为 `require`。

TexLite 使用 PostgreSQL。`drizzle/postgres/` 中的版本化迁移会在初始化和应用启动时自动执行；
首次部署先创建空数据库，再运行 `npm run init` 创建首个管理员。

可选的 PostgreSQL 并发集成测试使用 `TEXLITE_TEST_DATABASE_URL` 指向一个控制数据库；测试会为
每个用例创建并删除独立临时数据库，不会写入该控制数据库。该连接账号需具备 `CREATEDB` 权限：

```bash
TEXLITE_TEST_DATABASE_URL='postgresql://postgres:密码@127.0.0.1:5432/postgres' npm test
```

`storage.dataDir` 只保存项目文件、编译产物、回收站和实例锁，数据库表由 PostgreSQL 服务管理。
备份时需同时保存数据库和项目文件。切换数据库时建议使用新的 `dataDir`，
避免文件目录与数据库中的项目记录不一致；开发脚本固定使用的 `data/` 也需与开发数据库对应。

## 公网部署配额

默认配置会限制每个账户最多拥有 100 个项目，且所有项目的源码、上传附件总量最多为
2048 MB（2 GB）。限制会在新建、导入、复制、上传、编辑、批量替换、历史恢复和协作自动保存时
执行；可在 `projects.maxProjectsPerUser` 和 `projects.maxSourceStorageMBPerUser` 调整。
也可分别通过 `TEXLITE_MAX_PROJECTS_PER_USER` 和
`TEXLITE_MAX_PROJECT_SOURCE_STORAGE_MB` 环境变量覆盖。
这两项限制的是用户可控制的项目源码。编译缓存、PDF 产物和编译进程资源仍应结合
`history`、`editHistory` 配置及宿主机/容器资源限制单独管理。

## 反向代理与真实客户端 IP

本地密码登录的限流会使用 `X-Forwarded-For` 中的客户端 IP，但仅当 TexLite 的
TCP 直连对端属于 `server.trustedProxyIps` 时才会信任该请求头。默认值为
`["127.0.0.1", "::1"]`，适用于代理与 TexLite 运行在同一台主机的情形。

### Caddy（同机部署）

将 TexLite 保持在 `127.0.0.1:3000`，Caddyfile 只需：

```caddyfile
tex.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Caddy 的 `reverse_proxy` 会自动设置安全的 `X-Forwarded-For`、
`X-Forwarded-Proto` 和 `X-Forwarded-Host`，无需额外 `header_up` 配置。
因此上述默认 `trustedProxyIps` 即可让 TexLite 获取客户端 IP，并正确识别 HTTPS。

若 Caddy 与 TexLite 位于不同容器或不同主机，将 `trustedProxyIps` 改为 Caddy
连接 TexLite 时使用的实际 IP 或 CIDR，例如：

```json
{
  "server": {
    "trustedProxyIps": ["172.20.0.0/16"]
  }
}
```

不要使用 `0.0.0.0/0`。若 Caddy 前还有 CDN、负载均衡器或另一层代理，应在 Caddy
中仅信任该上游服务公布的 CIDR，并启用严格的从右至左解析：

```caddyfile
{
    servers {
        trusted_proxies static <上游代理的CIDR>
        trusted_proxies_strict
    }
}
```

详见 [Caddy reverse_proxy 文档](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
和 [Caddy trusted_proxies 文档](https://caddyserver.com/docs/caddyfile/options)。

## 嵌入 Nuwax 或其他网站

默认 Cookie 仅用于第一方访问。若需要让外层网站中的 TexLite iframe 登录，在
`server.allowedIframeOrigins` 中列出外层页面的精确 **HTTPS origin**：

```json
{
  "server": {
    "allowedIframeOrigins": [
      "https://portal.example.com"
    ]
  }
}
```

启用后，TexLite 会只允许这些来源嵌入页面。普通登录仍使用第一方会话 Cookie；OAuth 弹窗
完成授权后，向 iframe 传递短时一次性票据，由 iframe 兑换自己的
`HttpOnly; Secure; SameSite=None; Partitioned` 会话 Cookie。写操作仍要求由 TexLite 前端自动添加的请求头，协作 WebSocket 也只接受
TexLite 自身 origin，以避免跨站请求伪造。不支持通配符、路径或非 HTTPS 地址；每个外层站点须
显式列出。此模式下 TexLite 自身和 `OAuth.redirectUri` 也必须使用 HTTPS；例如回调地址应为
`https://texlite.example.com/auth/nuwax/callback`，并在 Nuwax 应用后台登记同一精确地址。

Nuwax 授权页可能拒绝被 iframe 直接加载。因此嵌入模式下点击“使用 Nuwax 登录”会打开一个小弹窗；
授权完成后弹窗会通知 iframe 兑换票据。外层 iframe 若设置了 `sandbox`，至少需要包含
`allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox`。公网部署必须由 HTTPS
反向代理提供服务，并正确配置 `server.trustedProxyIps`。每个外层站点拥有独立的分区会话；浏览器
若不支持分区 Cookie 或禁用了所有 Cookie，嵌入登录仍不可用。

一次性票据只保存在当前 TexLite 进程内，无需新增数据库表；服务重启时尚未兑换的票据失效。
若将来部署多个 TexLite 进程，需要为弹窗回调和票据兑换配置同一进程的路由亲和性，或改用共享票据存储。

## 许可证

TexLite 使用 GNU Affero General Public License v3.0，详见
[LICENSE](LICENSE) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
