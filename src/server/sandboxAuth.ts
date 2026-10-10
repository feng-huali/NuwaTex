import type { FastifyRequest } from "fastify";
import { cacheCurrentUser } from "./auth.js";
import { CONFIG_DEFAULTS } from "./config.js";
import type { DatabaseConnection } from "./db.js";
import { httpError } from "./http.js";
import { withoutBasePath } from "../shared/basePath.js";

export const SANDBOX_AUTH_TIMEOUT_MS = 10_000;
export const SANDBOX_AUTH_MAX_RESPONSE_BYTES = 64 * 1024;

// Sandbox credentials authorize the documented paper-writing workflow.
// Account administration, browser-session operations and live collaboration
// routes have different authentication requirements and are not included.
const sandboxRoutes = new Set([
  "GET /api/me", "GET /api/config", "GET /api/health",
  "GET /api/projects", "POST /api/projects", "POST /api/projects/import",
  "POST /api/projects/:id/duplicate",
  "GET /api/projects/:id", "PATCH /api/projects/:id", "DELETE /api/projects/:id",
  "GET /api/projects/:id/files", "GET /api/projects/:id/main-files",
  "GET /api/projects/:id/outline", "GET /api/projects/:id/search",
  "POST /api/projects/:id/search/replace",
  "GET /api/projects/:id/file", "GET /api/projects/:id/file/raw",
  "POST /api/projects/:id/file", "PUT /api/projects/:id/file",
  "DELETE /api/projects/:id/file", "POST /api/projects/:id/folders",
  "PATCH /api/projects/:id/path", "POST /api/projects/:id/upload",
  "POST /api/projects/:id/compile", "POST /api/projects/:id/compile/cancel",
  "GET /api/projects/:id/compile/latest", "GET /api/projects/:id/compile/artifacts",
  "POST /api/projects/:id/compile/clean",
  "GET /api/projects/:id/pdf", "GET /api/projects/:id/download"
]);

/** Verify a sandbox key with the administrator-configured Nuwax endpoint. */
export class NuwaxSandboxAuthService {
  constructor(
    private readonly userInfoUrl: string = CONFIG_DEFAULTS.sandboxUserInfoUrl,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async subjectForKey(key: string): Promise<string> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(httpError(504, "SANDBOX_AUTH_TIMEOUT"));
      }, SANDBOX_AUTH_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.lookup(key, controller.signal), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }

  private async lookup(key: string, signal: AbortSignal): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.userInfoUrl, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: "Bearer " + key },
        // A redirect must never send the sandbox key to another destination.
        redirect: "error",
        signal
      });
    } catch {
      throw httpError(503, "SANDBOX_AUTH_UNAVAILABLE");
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw httpError(401, "SANDBOX_AUTH_INVALID");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw httpError(response.status === 429 ? 503 : 502, "SANDBOX_AUTH_UNAVAILABLE");
    }
    let payload: unknown;
    const reader = response.body?.getReader();
    if (!reader) throw httpError(502, "SANDBOX_AUTH_RESPONSE_INVALID");
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > SANDBOX_AUTH_MAX_RESPONSE_BYTES) {
          throw new Error("User info response too large");
        }
        chunks.push(value);
      }
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw httpError(502, "SANDBOX_AUTH_RESPONSE_INVALID");
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw httpError(502, "SANDBOX_AUTH_RESPONSE_INVALID");
    }
    const info = payload as Record<string, unknown>;
    if (info.error || info.success === false
      || (typeof info.code === "string" && info.code !== "0000")) {
      throw httpError(401, "SANDBOX_AUTH_INVALID");
    }
    if (info.success !== true || info.code !== "0000"
      || typeof info.data !== "object" || info.data === null || Array.isArray(info.data)) {
      throw httpError(502, "SANDBOX_AUTH_RESPONSE_INVALID");
    }
    const id = (info.data as Record<string, unknown>).id;
    const subject = typeof id === "string" ? id.trim()
      : typeof id === "number" && Number.isSafeInteger(id) ? String(id) : "";
    if (!subject || subject.length > 256) {
      throw httpError(502, "SANDBOX_AUTH_RESPONSE_INVALID");
    }
    return subject;
  }
}

/**
 * Populate the request identity used by requireUser(). A supplied invalid
 * Bearer credential fails closed even when a browser cookie is valid.
 * No bearer key or upstream profile is persisted.
 */
export async function authenticateSandboxRequest(
  request: FastifyRequest,
  db: DatabaseConnection,
  service: NuwaxSandboxAuthService,
  basePath: string
): Promise<boolean> {
  const header = request.headers.authorization;
  if (header === undefined) return false;
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(header);
  if (!match || match[1].length > 4_096) throw httpError(401, "SANDBOX_AUTH_INVALID");
  const route = withoutBasePath(basePath, request.routeOptions.url ?? "");
  if (!route || !sandboxRoutes.has(request.method + " " + route)) {
    throw httpError(403, "SANDBOX_API_FORBIDDEN");
  }
  const subject = await service.subjectForKey(match[1]);
  const user = await db.identity.findUserByNuwaxSubject(subject);
  if (!user) throw httpError(403, "SANDBOX_ACCOUNT_NOT_LINKED");
  if (user.disabled) throw httpError(403, "AUTH_DISABLED");
  cacheCurrentUser(request, user);
  return true;
}
