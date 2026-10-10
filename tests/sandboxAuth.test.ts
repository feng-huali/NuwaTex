import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticateSandboxRequest, NuwaxSandboxAuthService, SANDBOX_AUTH_MAX_RESPONSE_BYTES, SANDBOX_AUTH_TIMEOUT_MS } from "../src/server/sandboxAuth.js";
import { publicUser, requireUser } from "../src/server/auth.js";
import { CONFIG_DEFAULTS } from "../src/server/config.js";
import type { DatabaseConnection, UserRow } from "../src/server/db.js";
import { apiError, HttpError } from "../src/server/http.js";
import { hasIframeCsrfHeader } from "../src/server/iframeLogin.js";
import { requireEditableProject } from "../src/server/routes/projectShared.js";

afterEach(() => vi.useRealTimers());

const user: UserRow = {
  id: "texlite-user-id", nuwax_subject: "nuwax-123", username: "writer",
  display_name: "Writer", password_hash: "", email: null, avatar_url: null,
  role: "user", disabled: 0, must_change_password: 0, can_create_projects: 1,
  created_at: "2026-10-10T00:00:00Z"
};

async function fixture(options: { basePath?: string; iframe?: boolean } = {}) {
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ id: user.nuwax_subject }));
  const identity = {
    findUserByNuwaxSubject: vi.fn(async (_subject: string): Promise<UserRow | null> => ({ ...user })),
    findActiveSessionUser: vi.fn(async (): Promise<UserRow | null> => ({ ...user })),
    findUserById: vi.fn(async () => ({ ...user }))
  };
  const projects = {
    findAccessibleProject: vi.fn(async (id: string, account: UserRow) => id === "owned-project" ? {
      id, owner_id: account.id, permission: "owner"
    } : null)
  };
  const db = { identity, projects } as unknown as DatabaseConnection;
  const service = new NuwaxSandboxAuthService(CONFIG_DEFAULTS.sandboxUserInfoUrl, fetchImpl);
  const app = Fastify({ logger: false });
  await app.register(cookie);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) return apiError(reply, error.statusCode, error.code);
    throw error;
  });
  const basePath = options.basePath ?? "/";
  await app.register(async (routes) => {
    routes.addHook("onRequest", async (request, reply) => {
      const bearer = await authenticateSandboxRequest(request, db, service, basePath);
      if (options.iframe && !["GET", "HEAD", "OPTIONS"].includes(request.method)
        && !bearer && !hasIframeCsrfHeader(request)) {
        return apiError(reply, 403, "CSRF_INVALID");
      }
    });
    routes.get("/api/me", async (request, reply) => {
      const account = await requireUser(request, reply, db);
      return account ? { user: publicUser(account) } : undefined;
    });
    routes.put("/api/projects/:id/file", async (request, reply) => {
      const account = await requireUser(request, reply, db);
      if (!account) return;
      const { id } = request.params as { id: string };
      await requireEditableProject(db, id, account);
      return { ok: true, userId: account.id };
    });
    routes.get("/api/users", async () => ({ forbidden: "must not be reached" }));
    routes.put("/api/me/password", async () => ({ forbidden: "must not be reached" }));
  }, { prefix: basePath === "/" ? "" : basePath });
  await app.ready();
  return { app, fetchImpl, identity, projects };
}

describe("Nuwax sandbox request authentication", () => {
  it("maps the upstream id to an existing user on every request without cookies", async () => {
    const { app, fetchImpl, identity } = await fixture({ basePath: "/texlite" });
    try {
      for (let index = 0; index < 2; index++) {
        const response = await app.inject({
          method: "GET", url: "/texlite/api/me",
          headers: { authorization: "Bearer sandbox-key" }
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().user.id).toBe(user.id);
        expect(response.headers["set-cookie"]).toBeUndefined();
      }
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchImpl).toHaveBeenCalledWith(CONFIG_DEFAULTS.sandboxUserInfoUrl, expect.objectContaining({
        headers: { Accept: "application/json", Authorization: "Bearer sandbox-key" },
        redirect: "error"
      }));
      expect(identity.findUserByNuwaxSubject).toHaveBeenCalledWith(user.nuwax_subject);
      expect(identity.findActiveSessionUser).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("preserves project permissions and exempts only authenticated Bearer writes from iframe CSRF", async () => {
    const { app } = await fixture({ iframe: true });
    try {
      const allowed = await app.inject({
        method: "PUT", url: "/api/projects/owned-project/file",
        headers: { authorization: "Bearer sandbox-key" }
      });
      expect(allowed.statusCode).toBe(200);
      const denied = await app.inject({
        method: "PUT", url: "/api/projects/other-project/file",
        headers: { authorization: "Bearer sandbox-key" }
      });
      expect(denied.statusCode).toBe(404);
      const cookieOnly = await app.inject({
        method: "PUT", url: "/api/projects/owned-project/file",
        headers: { cookie: "texlite_session=valid-cookie" }
      });
      expect(cookieOnly.statusCode).toBe(403);
      expect(cookieOnly.json().code).toBe("CSRF_INVALID");
    } finally { await app.close(); }
  });

  it("never falls back to a valid cookie after Bearer rejection", async () => {
    const { app, fetchImpl, identity } = await fixture();
    fetchImpl.mockResolvedValue(Response.json({ error: "invalid_key" }, { status: 401 }));
    try {
      const response = await app.inject({
        method: "GET", url: "/api/me",
        headers: { authorization: "Bearer bad-key", cookie: "texlite_session=valid-cookie" }
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("SANDBOX_AUTH_INVALID");
      expect(identity.findActiveSessionUser).not.toHaveBeenCalled();
      expect(identity.findUserByNuwaxSubject).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("keeps cookie authentication working without an Authorization header", async () => {
    const { app, fetchImpl } = await fixture();
    try {
      const response = await app.inject({
        method: "GET", url: "/api/me", headers: { cookie: "texlite_session=valid-cookie" }
      });
      expect(response.statusCode).toBe(200);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("rejects unregistered and disabled local users", async () => {
    const { app, identity } = await fixture();
    try {
      identity.findUserByNuwaxSubject.mockResolvedValueOnce(null);
      const unknown = await app.inject({ url: "/api/me", headers: { authorization: "Bearer key" } });
      expect(unknown.statusCode).toBe(403);
      expect(unknown.json().code).toBe("SANDBOX_ACCOUNT_NOT_LINKED");
      identity.findUserByNuwaxSubject.mockResolvedValueOnce({ ...user, disabled: 1 });
      const disabled = await app.inject({ url: "/api/me", headers: { authorization: "Bearer key" } });
      expect(disabled.statusCode).toBe(403);
      expect(disabled.json().code).toBe("AUTH_DISABLED");
    } finally { await app.close(); }
  });

  it("does not grant access to account administration and rejects malformed headers", async () => {
    const { app, fetchImpl } = await fixture();
    try {
      for (const [method, url] of [["GET", "/api/users"], ["PUT", "/api/me/password"]] as const) {
        const response = await app.inject({ method, url, headers: { authorization: "Bearer key" } });
        expect(response.statusCode).toBe(403);
        expect(response.json().code).toBe("SANDBOX_API_FORBIDDEN");
      }
      for (const authorization of ["Bearer", "Basic key", "Bearer key other", "Bearer " + "x".repeat(4_097)]) {
        const response = await app.inject({ url: "/api/me", headers: { authorization } });
        expect(response.statusCode).toBe(401);
      }
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});

describe("sandbox identity endpoint failures", () => {
  it("accepts exact string ids and safe numeric ids, and rejects ambiguous identities", async () => {
    for (const id of ["nuwax-123", "000123", 123]) {
      const service = new NuwaxSandboxAuthService(undefined, async () => Response.json({ id }));
      expect(await service.subjectForKey("key")).toBe(String(id));
    }
    for (const payload of [{}, { id: "" }, { id: 1.5 }, { id: Number.MAX_SAFE_INTEGER + 1 }, { sub: "wrong-field" }, { id: ["wrong"] }]) {
      const service = new NuwaxSandboxAuthService(undefined, async () => Response.json(payload));
      await expect(service.subjectForKey("key")).rejects.toMatchObject({
        statusCode: 502, code: "SANDBOX_AUTH_RESPONSE_INVALID"
      });
    }
  });

  it("fails closed for transport failures and malformed or oversized responses", async () => {
    const failed = new NuwaxSandboxAuthService(undefined, async () => { throw new Error("secret-key"); });
    await expect(failed.subjectForKey("secret-key")).rejects.toMatchObject({
      statusCode: 503, code: "SANDBOX_AUTH_UNAVAILABLE"
    });
    for (const body of ["not json", JSON.stringify({ id: "x".repeat(SANDBOX_AUTH_MAX_RESPONSE_BYTES) })]) {
      const service = new NuwaxSandboxAuthService(undefined, async () => new Response(body));
      await expect(service.subjectForKey("key")).rejects.toMatchObject({
        statusCode: 502, code: "SANDBOX_AUTH_RESPONSE_INVALID"
      });
    }
  });

  it("times out while waiting for either response headers or response body", async () => {
    vi.useFakeTimers();
    for (const fetchImpl of [
      async () => new Promise<Response>(() => undefined),
      async () => new Response(new ReadableStream<Uint8Array>({ start() {} }))
    ]) {
      const service = new NuwaxSandboxAuthService(undefined, fetchImpl);
      const pending = expect(service.subjectForKey("key")).rejects.toMatchObject({
        statusCode: 504, code: "SANDBOX_AUTH_TIMEOUT"
      });
      await vi.advanceTimersByTimeAsync(SANDBOX_AUTH_TIMEOUT_MS);
      await pending;
    }
  });
});
