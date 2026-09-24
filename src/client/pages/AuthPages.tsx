import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, api } from "../api";
import { errorMessage } from "../errors";
import type { SiteConfig, User } from "../types";
import { LanguageSwitcher } from "../LanguageSwitcher";
import { SiteFooter, SiteLogo } from "./SiteChrome";
import { appPath } from "../basePath";
import { LogIn } from "lucide-react";

export function ChangePassword({ site, user, onChanged }: { site: SiteConfig; user: User; onChanged: (user: User) => void }) {
  const { t } = useTranslation();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (newPassword !== confirm) return setError(t("auth.mismatch"));
    if (newPassword.length < site.minPasswordLength) return setError(t("auth.passwordMinimum", { count: site.minPasswordLength }));
    try {
      const result = await api<{ user: User }>("/api/me/password", { method: "PUT", body: JSON.stringify({ currentPassword, newPassword }) });
      onChanged(result.user);
    } catch (e) { setError(errorMessage(e)); }
  };
  return <main className="login-page"><LanguageSwitcher /><form className="login-card" onSubmit={submit}>
    <SiteLogo siteName={site.siteName} auth /><h1 className="sr-only">{site.siteName}</h1><p className="muted">{t("auth.firstLogin")}</p>
    <label>{t("auth.currentPassword")}<input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} /></label>
    <label>{t("auth.newPassword")}<input type="password" minLength={site.minPasswordLength} autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} /><small className="field-hint">{t("auth.passwordMinimum", { count: site.minPasswordLength })}</small></label>
    <label>{t("auth.confirmPassword")}<input type="password" minLength={site.minPasswordLength} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
    {error && <p className="error">{error}</p>}<button className="primary">{t("auth.updatePassword")}</button>
  </form><SiteFooter /></main>;
}
export function Login({ site, onLogin }: { site: SiteConfig; onLogin: (user: User) => void }) {
  const { t } = useTranslation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const oauthPopupRef = useRef<Window | null>(null);
  const returnPath = typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("return") ?? "";
  const nuwaxLoginPath = returnPath
    ? `${appPath("/api/auth/nuwax", site.basePath)}?return=${encodeURIComponent(returnPath)}`
    : appPath("/api/auth/nuwax", site.basePath);
  const useNuwaxPopup = typeof window !== "undefined"
    && site.iframeLoginEnabled
    && window.top !== window.self;
  useEffect(() => {
    if (!useNuwaxPopup) return;
    const receivePopupResult = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin || event.source !== oauthPopupRef.current
        || !event.data || typeof event.data !== "object") return;
      const message = event.data as { type?: unknown; ticket?: unknown };
      if (message.type !== "texlite:nuwax-oauth-complete"
        || typeof message.ticket !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(message.ticket)) return;
      oauthPopupRef.current = null;
      void api<{ ok: true }>("/api/auth/iframe/redeem", {
        method: "POST", body: JSON.stringify({ ticket: message.ticket }), suppressSessionExpired: true
      })
        .then(() => api<{ user: User }>("/api/me", { suppressSessionExpired: true }))
        .then(({ user }) => onLogin(user))
        .catch((reason) => setError(reason instanceof ApiError && reason.status === 401
          ? t("auth.iframeCookieUnavailable") : errorMessage(reason)));
    };
    window.addEventListener("message", receivePopupResult);
    return () => window.removeEventListener("message", receivePopupResult);
  }, [onLogin, t, useNuwaxPopup]);
  const beginNuwaxLogin = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!useNuwaxPopup) return;
    event.preventDefault();
    setError("");
    const separator = nuwaxLoginPath.includes("?") ? "&" : "?";
    const popup = window.open(`${nuwaxLoginPath}${separator}popup=1`, "texlite-nuwax-oauth", "popup,width=520,height=720");
    oauthPopupRef.current = popup;
    if (!popup) setError(t("auth.popupBlocked"));
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      const result = await api<{ user: User }>("/api/auth/login", {
        method: "POST", body: JSON.stringify({ username, password }), suppressSessionExpired: true,
        headers: useNuwaxPopup ? { "X-TexLite-Embedded": "1" } : undefined
      });
      if (useNuwaxPopup) await api<{ user: User }>("/api/me", { suppressSessionExpired: true });
      onLogin(result.user);
    } catch (err) { setError(err instanceof ApiError && err.status === 401 && useNuwaxPopup
      ? t("auth.iframeCookieUnavailable") : errorMessage(err)); }
  };
  return <main className="login-page"><LanguageSwitcher />
    <form className="login-card login-auth-card" onSubmit={submit}>
      <SiteLogo siteName={site.siteName} auth />
      <h1 className="login-title">{t("auth.loginTitle", { site: site.siteName })}</h1>
      <p className="muted login-subtitle">{t("auth.tagline")}</p>
      {site.nuwaxOAuthEnabled && <>
        <a className="oauth-login-button" href={nuwaxLoginPath} onClick={beginNuwaxLogin}><LogIn aria-hidden size={18} /><span>{t("auth.nuwaxLogin")}</span></a>
        <div className="auth-divider"><span>{t("auth.or")}</span></div>
      </>}
      <div className="login-password-form">
        {site.nuwaxOAuthEnabled && <p className="login-method-label">{t("auth.passwordLogin")}</p>}
        <label>{t("auth.username")}<input autoFocus={!site.nuwaxOAuthEnabled} value={username} onChange={(e) => setUsername(e.target.value)} /></label>
        <label>{t("auth.password")}<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <button className="primary" type="submit">{t("auth.login")}</button>
      </div>
      {site.adminEmail && <small className="support">{t("auth.contact", { email: site.adminEmail })}</small>}
    </form><SiteFooter />
  </main>;
}
