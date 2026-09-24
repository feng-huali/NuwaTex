import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/server/config.js";
import type { DatabaseConnection, UserRow } from "../src/server/db.js";
import type { CollaborationService } from "../src/server/collaboration.js";
import { LoginRateLimiter } from "../src/server/security.js";
import { registerAuthRoutes } from "../src/server/routes/auth.js";
import type { NuwaxOAuthService } from "../src/server/nuwaxOAuth.js";

const baseUrl = "https://texlite.example.test";
const host = { host: "texlite.example.test", "x-forwarded-proto": "https" };
const user: UserRow = {
  id: "iframe-user-id", username: "iframe-user", display_name: "Iframe User",
  password_hash: "", email: null, nuwax_subject: "iframe-user",
  avatar_url: null, role: "user", disabled: 0, must_change_password: 0,
  can_create_projects: 1, created_at: new Date().toISOString()
};

function namedCookie(value: unknown, name: string): string {
  const cookies = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const found = cookies.find((item): item is string => typeof item === "string" && item.startsWith(`${name}=`));
  if (!found) throw new Error(`Missing ${name} cookie`);
  return found.split(";")[0]!;
}

describe("iframe OAuth handoff", () => {
  it("redeems one popup ticket into a partitioned cookie and revokes it on logout", async () => {
    const states = new Map<string, { returnPath: string; redirectUri: string; expiresAt: string }>();
    const sessions = new Map<string, { userId: string; expiresAt: string }>();
    const db = {
      identity: {
        createOAuthState: async (input: { id: string; returnPath: string; redirectUri: string; expiresAt: string }) => {
          states.set(input.id, input);
        },
        consumeOAuthState: async (id: string, asOf: string) => {
          const state = states.get(id);
          states.delete(id);
          return state && state.expiresAt > asOf ? { id, ...state } : null;
        },
        upsertNuwaxUser: async () => user,
        createSession: async (input: { id: string; userId: string; expiresAt: string }) => {
          sessions.set(input.id, input);
        },
        findActiveSessionUser: async (id: string, asOf: string) => {
          const session = sessions.get(id);
          return session && session.expiresAt > asOf
            ? { ...user, session_id: id, session_expires_at: session.expiresAt } : null;
        },
        deleteSession: async (id: string) => sessions.delete(id)
      }
    } as unknown as DatabaseConnection;
    const config = {
      basePath: "/", sessionDays: 7,
      allowedIframeOrigins: ["https://portal.example.test"],
      oauth: { clientId: "test", clientSecret: "test", baseUrl: "https://nuwax.example.test",
        redirectUri: `${baseUrl}/auth/nuwax/callback` }
    } as Config;
    const nuwaxOAuth = {
      enabled: true,
      authorizationUrl: (state: string) => `https://nuwax.example.test/authorize?state=${state}`,
      exchangeAuthorizationCode: async () => ({ accessToken: "access", refreshToken: "refresh", expiresInSeconds: 3600, scope: "profile" }),
      fetchProfile: async () => ({ subject: "iframe-user", name: "Iframe User", avatarUrl: null, tenantId: null }),
      storeTokens: async () => undefined
    } as unknown as NuwaxOAuthService;
    const app = Fastify({ logger: false, trustProxy: true });
    await app.register(cookie);
    registerAuthRoutes(app, {
      config, db, nuwaxOAuth, loginLimiter: new LoginRateLimiter(),
      collaboration: { disconnectSession: () => undefined } as unknown as CollaborationService
    });
    await app.ready();
    try {
      const authorize = await app.inject({ method: "GET", url: "/api/auth/nuwax?popup=1", headers: host });
      const state = new URL(String(authorize.headers.location)).searchParams.get("state");
      expect(authorize.statusCode).toBe(302);
      expect(state).toBeTruthy();
      const stateCookie = namedCookie(authorize.headers["set-cookie"], "texlite_oauth_state");
      const popupCookie = namedCookie(authorize.headers["set-cookie"], "texlite_oauth_popup");
      const callback = await app.inject({
        method: "GET", url: `/auth/nuwax/callback?code=ok&state=${state}`,
        headers: { ...host, cookie: `${stateCookie}; ${popupCookie}` }
      });
      expect(callback.statusCode).toBe(200);
      expect(namedCookie(callback.headers["set-cookie"], "texlite_session")).toBeTruthy();
      const ticket = callback.body.match(/"ticket":"([A-Za-z0-9_-]{43})"/)?.[1];
      expect(ticket).toBeTruthy();

      const denied = await app.inject({
        method: "POST", url: "/api/auth/iframe/redeem",
        headers: { ...host, origin: "https://portal.example.test" }, payload: { ticket }
      });
      expect(denied.statusCode).toBe(403);
      const redeem = await app.inject({
        method: "POST", url: "/api/auth/iframe/redeem",
        headers: { ...host, origin: baseUrl }, payload: { ticket }
      });
      expect(redeem.statusCode).toBe(200);
      const embeddedCookie = namedCookie(redeem.headers["set-cookie"], "texlite_embedded_session");
      const cookies = Array.isArray(redeem.headers["set-cookie"])
        ? redeem.headers["set-cookie"] : [redeem.headers["set-cookie"]];
      expect(cookies.find((item) => item?.startsWith("texlite_embedded_session=")))
        .toContain("Partitioned");
      expect(cookies.find((item) => item?.startsWith("texlite_embedded_session=")))
        .toContain("SameSite=None");
      const me = await app.inject({ method: "GET", url: "/api/me", headers: { ...host, cookie: embeddedCookie } });
      expect(me.statusCode).toBe(200);
      expect(me.json().user.username).toBe("iframe-user");
      const replay = await app.inject({
        method: "POST", url: "/api/auth/iframe/redeem",
        headers: { ...host, origin: baseUrl }, payload: { ticket }
      });
      expect(replay.statusCode).toBe(400);
      const logout = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { ...host, cookie: embeddedCookie } });
      expect(logout.statusCode).toBe(200);
      const afterLogout = await app.inject({ method: "GET", url: "/api/me", headers: { ...host, cookie: embeddedCookie } });
      expect(afterLogout.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
