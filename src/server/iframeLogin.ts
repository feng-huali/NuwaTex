import type { FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import type { Config } from "./config.js";
import { basePathHref } from "../shared/basePath.js";
import { digestToken } from "./security.js";

/**
 * A browser cannot set this header from a cross-site form. The bundled client
 * adds it to every state-changing API request when iframe sessions are enabled.
 */
export const IFRAME_CSRF_HEADER = "x-texlite-request";

export const OAUTH_POPUP_COOKIE = "texlite_oauth_popup";
export const EMBEDDED_SESSION_COOKIE = "texlite_embedded_session";
export const EMBEDDED_SHARE_COOKIE = "texlite_embedded_share_token";
const HANDOFF_TTL_MS = 90_000;

type CookieKind = "session" | "embeddedSession" | "oauthState" | "oauthPopup" | "shareToken" | "embeddedShareToken";

type CookieRequest = { protocol: string };

/**
 * An explicit parent-origin allow-list is the opt-in for third-party iframe
 * login. Without it, NuwaTex retains its original first-party-only policy.
 */
export function iframeLoginEnabled(config: Config): boolean {
  return Boolean(config.allowedIframeOrigins?.length);
}

/**
 * Embedded cookies are set from a response made inside the iframe. Their
 * partition key is therefore the outer site's schemeful origin rather than
 * NuwaTex's top-level popup origin.
 */
export function authenticationCookieOptions(
  config: Config,
  request: CookieRequest,
  kind: CookieKind
): {
  path: string;
  httpOnly: true;
  sameSite: "strict" | "lax" | "none";
  secure: boolean;
  partitioned: boolean;
} {
  const partitioned = kind === "embeddedSession" || kind === "embeddedShareToken";
  return {
    path: basePathHref(config.basePath),
    httpOnly: true,
    sameSite: partitioned ? "none" : kind === "session" ? "strict" : "lax",
    secure: partitioned || request.protocol === "https",
    partitioned
  };
}

export function sessionCookieTokens(cookies: Record<string, string | undefined>): string[] {
  return [...new Set([cookies[EMBEDDED_SESSION_COOKIE], cookies.texlite_session].filter((token): token is string => Boolean(token)))];
}

/** A short-lived, single-use bridge between the first-party popup and iframe. */
export class IframeLoginTickets {
  private readonly pending = new Map<string, { sourceSessionId: string; expiresAt: number }>();

  issue(sourceSessionId: string): string {
    const ticket = randomBytes(32).toString("base64url");
    const id = digestToken(ticket);
    this.pending.set(id, { sourceSessionId, expiresAt: Date.now() + HANDOFF_TTL_MS });
    setTimeout(() => this.pending.delete(id), HANDOFF_TTL_MS).unref();
    return ticket;
  }

  consume(ticket: string): string | null {
    const id = digestToken(ticket);
    const entry = this.pending.get(id);
    this.pending.delete(id);
    return entry && entry.expiresAt > Date.now() ? entry.sourceSessionId : null;
  }
}

export function hasIframeCsrfHeader(request: Pick<FastifyRequest, "headers">): boolean {
  return request.headers[IFRAME_CSRF_HEADER] === "1";
}

/**
 * Browser WebSockets carry cookies but cannot attach the request header above.
 * In iframe mode, accept them only from the NuwaTex document's own origin;
 * the parent page never needs to open the collaboration socket directly.
 */
export function hasOwnRequestOrigin(request: Pick<FastifyRequest, "headers" | "host" | "protocol">): boolean {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || !origin) return false;
  try {
    const received = new URL(origin).origin;
    const expected = new URL(`${request.protocol}://${request.host}`).origin;
    return received === expected;
  } catch {
    return false;
  }
}

export function iframeFrameAncestorsPolicy(config: Config): string | null {
  if (!iframeLoginEnabled(config)) return null;
  return `frame-ancestors 'self' ${(config.allowedIframeOrigins ?? []).join(" ")}`;
}
