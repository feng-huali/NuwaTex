import i18n from "./i18n";
import { appPath } from "./basePath";

/** Required for state-changing requests when iframe login is enabled. */
export const TEXLITE_REQUEST_HEADER = "X-TexLite-Request";

export interface ApiRequestInit extends RequestInit {
  /**
   * Requests used to discover the initial route must not redirect an
   * unauthenticated deep link to the dashboard. The caller can retry them
   * after login instead.
   */
  suppressSessionExpired?: boolean;
}

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string | null = null) {
    super(message);
  }
}

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === "AbortError";
}

/** Normalize raw fetch failures for the few endpoints that stream non-JSON. */
export function normalizeNetworkError(error: unknown): Error {
  if (isAbortError(error) || error instanceof ApiError) return error;
  return new ApiError(i18n.t("network.requestFailed"), 0, "NETWORK_ERROR");
}

function isFormData(body: BodyInit | null | undefined): boolean {
  return typeof FormData !== "undefined" && body instanceof FormData;
}

function isStateChangingMethod(method: string | undefined): boolean {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method?.toUpperCase() ?? "GET");
}

export async function api<T>(url: string, options: ApiRequestInit = {}): Promise<T> {
  const { suppressSessionExpired = false, ...requestOptions } = options;
  const headers = new Headers(requestOptions.headers);
  if (!headers.has("Accept-Language")) {
    headers.set("Accept-Language", i18n.resolvedLanguage?.startsWith("zh") ? "zh" : "en");
  }
  if (isStateChangingMethod(requestOptions.method) && !headers.has(TEXLITE_REQUEST_HEADER)) {
    headers.set(TEXLITE_REQUEST_HEADER, "1");
  }
  if (requestOptions.body && !isFormData(requestOptions.body) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(appPath(url), {
      ...requestOptions,
      headers
    });
  } catch (error) {
    // Route changes intentionally abort outstanding requests. Preserve that
    // signal for callers; every other transport exception becomes a friendly,
    // localized API error instead of exposing raw browser text.
    throw normalizeNetworkError(error);
  }
  const contentType = response.headers.get("content-type") ?? "";
  let body: unknown = null;
  if (contentType.includes("application/json")) {
    try {
      body = await response.json();
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new ApiError(i18n.t("network.invalidResponse"), response.status, "INVALID_RESPONSE");
    }
  } else if (response.ok) {
    // Every endpoint routed through api<T> is JSON. Treat an HTML proxy page
    // or truncated text response as a recoverable transport failure here,
    // rather than letting a later property access leak a raw TypeError.
    throw new ApiError(i18n.t("network.invalidResponse"), response.status, "INVALID_RESPONSE");
  }
  if (!response.ok) {
    if (response.status === 401 && !suppressSessionExpired && typeof window !== "undefined") {
      window.dispatchEvent(new Event("texlite:session-expired"));
    }
    throw new ApiError(localizedResponseError(body, response.status), response.status, responseErrorCode(body));
  }
  return body as T;
}

/** XHR is used only for ZIP imports because fetch does not expose upload progress. */
export function uploadProjectZip<T>(url: string, data: FormData, onProgress: (percent: number | null) => void, onProcessing: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", appPath(url));
    request.responseType = "json";
    request.withCredentials = true;
    request.setRequestHeader("Accept-Language", i18n.resolvedLanguage?.startsWith("zh") ? "zh" : "en");
    request.setRequestHeader(TEXLITE_REQUEST_HEADER, "1");
    let processing = false;
    const markProcessing = () => {
      if (processing) return;
      processing = true;
      onProcessing();
    };
    request.upload.onprogress = (event) => {
      if (processing) return;
      if (event.lengthComputable && event.total > 0 && event.loaded >= event.total) {
        markProcessing();
      } else {
        onProgress(event.lengthComputable && event.total > 0 ? Math.min(99, Math.floor(event.loaded / event.total * 100)) : null);
      }
    };
    request.upload.onload = markProcessing;
    request.onerror = () => reject(new ApiError(i18n.t("network.requestFailed"), 0, "NETWORK_ERROR"));
    request.onabort = () => reject(new DOMException("Upload aborted", "AbortError"));
    request.onload = () => {
      const body: unknown = request.response;
      if (request.status === 401) window.dispatchEvent(new Event("texlite:session-expired"));
      if (request.status < 200 || request.status >= 300) {
        reject(new ApiError(localizedResponseError(body, request.status), request.status, responseErrorCode(body)));
      } else if (!body || typeof body !== "object") {
        reject(new ApiError(i18n.t("network.invalidResponse"), request.status, "INVALID_RESPONSE"));
      } else resolve(body as T);
    };
    request.send(data);
  });
}

export function localizedResponseError(body: unknown, status: number, fallbackKey = "errors.request"): string {
  const serverMessage = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
    ? body.error : "";
  const code = responseErrorCode(body);
  if (code) {
    const key = ({
      AUTH_REQUIRED: "auth.sessionExpired",
      CSRF_INVALID: "errors.codes.CSRF_INVALID",
      AUTH_DISABLED: "errors.codes.AUTH_DISABLED",
      EMAIL_ALREADY_IN_USE: "auth.emailAlreadyInUse",
      USERNAME_INVALID: "auth.usernameInvalid",
      OAUTH_ACCESS_DENIED: "errors.codes.OAUTH_ACCESS_DENIED",
      OAUTH_CALLBACK_INVALID: "errors.codes.OAUTH_CALLBACK_INVALID",
      OAUTH_IDENTITY_ALREADY_LINKED: "auth.oauthIdentityAlreadyLinked",
      OAUTH_NOT_CONFIGURED: "auth.oauthNotConfigured",
      OAUTH_PROVIDER_FAILED: "errors.codes.OAUTH_PROVIDER_FAILED",
      OAUTH_STATE_INVALID: "errors.codes.OAUTH_STATE_INVALID",
      INVITATION_PHONE_INVALID: "projectSettings.invitePhoneInvalid",
      INVITATION_RECIPIENT_NOT_FOUND: "projectSettings.recipientNotFound",
      NUWAX_SEARCH_FAILED: "projectSettings.nuwaxSearchFailed",
      NUWAX_SEARCH_RATE_LIMITED: "projectSettings.nuwaxSearchRateLimited",
      NUWAX_SEARCH_REAUTH_REQUIRED: "projectSettings.nuwaxSearchReauthRequired",
      NUWAX_SEARCH_SCOPE_REQUIRED: "projectSettings.nuwaxSearchScopeRequired",
      NUWAX_SEARCH_TIMEOUT: "projectSettings.nuwaxSearchTimeout",
      NUWAX_SEARCH_UNAVAILABLE: "projectSettings.nuwaxSearchUnavailable",
      INVITATION_MEMBER_EXISTS: "projectSettings.inviteMemberExists",
      INVITATION_NOT_FOUND: "projectSettings.inviteNotFound",
      INVITATION_OWNER_FORBIDDEN: "projectSettings.inviteOwnerForbidden",
      SHARE_LINK_NOT_FOUND: "projectSettings.shareLinkNotFound",
      SHARE_LINK_READ_ONLY: "projectSettings.shareLinkReadOnly",
      ADMIN_REQUIRED: "users.adminRequired",
      HISTORY_VERSION_NOT_FOUND: "apiErrors.historyVersionNotFound",
      HISTORY_FILE_NOT_FOUND: "apiErrors.historyFileNotFound",
      HISTORY_OBJECT_MISSING: "apiErrors.historyObjectMissing",
      HISTORY_TARGET_CONFLICT: "apiErrors.historyTargetConflict",
      HISTORY_FILE_PREVIEW_UNSUPPORTED: "apiErrors.historyPreviewUnsupported",
      SEARCH_QUERY_INVALID: "apiErrors.searchInvalid",
      FORMAT_FAILED: "apiErrors.formatFailed",
      MAIN_DOCUMENT_INVALID: "apiErrors.mainDocumentInvalid",
      COMPILE_SNAPSHOT_BUSY: "apiErrors.compileSnapshotBusy",
      COMPILE_CLEAN_BUSY: "editor.cleanBusy",
      CITATION_INVALID: "citationErrors.invalid",
      CITATION_TOO_LARGE: "citationErrors.tooLarge",
      CITATION_NOT_FOUND: "citationErrors.notFound",
      CITATION_KEY_EXISTS: "citationErrors.keyExists",
      CITATION_TAG_NOT_FOUND: "citationErrors.tagNotFound",
      CITATION_CONFLICT: "citationErrors.conflict",
      WORD_COUNT_FAILED: "editor.wordCountFailed",
      WORD_COUNT_SOURCE_INVALID: "editor.wordCountSourceInvalid",
      WORD_COUNT_SOURCE_TOO_LARGE: "editor.wordCountSourceTooLarge",
      WORD_COUNT_UNAVAILABLE: "editor.wordCountUnavailable",
    } as Record<string, string>)[code] ?? `errors.codes.${code}`;
    if (i18n.exists(key)) return i18n.t(key, { status, ...(typeof body === "object" && body !== null ? body : {}) });
  }
  if (serverMessage) return serverMessage;
  return i18n.t(fallbackKey, { status });
}

export function responseErrorCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("code" in body) || typeof body.code !== "string") return null;
  return body.code;
}
