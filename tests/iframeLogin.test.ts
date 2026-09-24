import { describe, expect, it, vi } from "vitest";
import type { Config } from "../src/server/config.js";
import {
  authenticationCookieOptions,
  IframeLoginTickets,
  sessionCookieTokens,
  hasOwnRequestOrigin,
  iframeFrameAncestorsPolicy,
  iframeLoginEnabled
} from "../src/server/iframeLogin.js";

function config(origins: string[] = []): Config {
  return { basePath: "/tools/texlite", allowedIframeOrigins: origins } as Config;
}

describe("iframe login policy", () => {
  it("keeps the original first-party cookie policy without an allow-list", () => {
    const current = config();
    expect(iframeLoginEnabled(current)).toBe(false);
    expect(authenticationCookieOptions(current, { protocol: "http" }, "session")).toMatchObject({
      path: "/tools/texlite/", sameSite: "strict", secure: false, httpOnly: true
    });
    expect(authenticationCookieOptions(current, { protocol: "https" }, "oauthState")).toMatchObject({
      sameSite: "lax", secure: true
    });
    expect(iframeFrameAncestorsPolicy(current)).toBeNull();
  });

  it("separates first-party and embedded partitioned cookies", () => {
    const current = config(["https://portal.example.test"]);
    expect(iframeLoginEnabled(current)).toBe(true);
    expect(authenticationCookieOptions(current, { protocol: "https" }, "session")).toMatchObject({
      path: "/tools/texlite/", sameSite: "strict", secure: true, partitioned: false, httpOnly: true
    });
    expect(authenticationCookieOptions(current, { protocol: "https" }, "embeddedSession")).toMatchObject({
      path: "/tools/texlite/", sameSite: "none", secure: true, partitioned: true, httpOnly: true
    });
    expect(sessionCookieTokens({ texlite_session: "first-party", texlite_embedded_session: "embedded" }))
      .toEqual(["embedded", "first-party"]);
    expect(iframeFrameAncestorsPolicy(current)).toBe("frame-ancestors 'self' https://portal.example.test");
  });

  it("accepts collaboration sockets only from the TexLite document origin", () => {
    const request = {
      protocol: "https",
      host: "texlite.example.test",
      headers: { origin: "https://texlite.example.test" }
    } as Parameters<typeof hasOwnRequestOrigin>[0];
    expect(hasOwnRequestOrigin(request)).toBe(true);
    expect(hasOwnRequestOrigin({ ...request, headers: { origin: "https://portal.example.test" } })).toBe(false);
  });

  it("hands off a popup session once and expires unused tickets", () => {
    const tickets = new IframeLoginTickets();
    const ticket = tickets.issue("popup-session");
    expect(tickets.consume(ticket)).toBe("popup-session");
    expect(tickets.consume(ticket)).toBeNull();
    const clock = vi.spyOn(Date, "now");
    try {
      const issuedAt = Date.now();
      clock.mockReturnValue(issuedAt);
      const stale = tickets.issue("expired-session");
      clock.mockReturnValue(issuedAt + 90_001);
      expect(tickets.consume(stale)).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });
});
