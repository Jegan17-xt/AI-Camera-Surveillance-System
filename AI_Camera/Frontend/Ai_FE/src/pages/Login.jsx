import { useState } from "react";
import { Navigate, Link, useLocation } from "react-router-dom";
import { Mail, Lock, Eye, EyeOff, Loader2, AlertTriangle } from "lucide-react";
import GlassCard from "../components/ui/GlassCard";
import Button from "../components/ui/Button";
import { useAuth } from "../context/AuthContext";
import { isSuperAdmin, isCompanyAdmin } from "../lib/permissions";
import { routeLog, authLog } from "../debugLog";
import { validateEmail, INVALID_INPUT_CLASS } from "../lib/validation";

const inputClass =
  "w-full rounded-xl glass py-2.5 pl-10 pr-4 text-sm text-ink-100 placeholder:text-ink-500 outline-none focus:border-accent-cyan/50 focus:ring-2 focus:ring-accent-cyan/20 transition";

// Same public Zynez brand/logo the landing page (pages/Landing.jsx) uses
// — deliberately NOT constants/branding.js's APP_NAME/APP_SUBTITLE
// ("AI Sentinel" / "Surveillance OS"), which is also read by main.jsx's
// browser-tab title and Sidebar.jsx; changing that file would change
// those too, and this task is scoped to the Login page only. Local
// constants here instead, matching Landing.jsx's own BRAND/LOGO_SRC
// exactly (same bundled asset, no new logo). mixBlendMode is applied
// inline rather than via Landing's `.zynez-landing .zx-logo` CSS rule —
// that selector only fires inside the landing page's own root wrapper —
// same effect (the asset's near-black ground drops out against this
// page's identical near-black background), no CSS file changes needed.
const BRAND = "Zynez";
const LOGO_SRC = "/70809498-2132-47b6-8216-785890a4f833.png";

export default function Login() {
  const { login, user, isAuthenticated, isLoading } = useAuth();
  const location = useLocation();
  // Login.jsx is mounted at both /user/login and /admin/login (see the
  // isAuthenticated redirect below) — the only things that differ
  // between them are the heading text and which role-switch link shows
  // below the form (User Login -> "Admin Sign In", Admin Login -> "User
  // Sign In"); the form itself, handleSubmit, and login() are identical
  // either way.
  const isAdminLoginPage = location.pathname === "/admin/login";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [touched, setTouched] = useState({});

  const emailError = validateEmail(email);
  // .trim() — a whitespace-only password (spaces typed in, nothing
  // meaningful entered) must count as "not provided", same as truly
  // empty; the raw `password` value is still what's sent to login()
  // below, since a real password could legitimately contain whitespace.
  const passwordError = password.trim() ? "" : "Password is required.";
  const isFormValid = !emailError && !passwordError;

  routeLog(`Login.jsx RENDER: isLoading=${isLoading} isAuthenticated=${isAuthenticated} role=${user?.role ?? "null"}`);

  if (!isLoading && isAuthenticated) {
    // This same page is mounted at both /admin/login and /user/login —
    // which portal you land in is always determined by who you actually
    // are (role), never by which of the two URLs was used to sign in.
    if (isSuperAdmin(user)) {
      routeLog("Login.jsx: already authenticated as Super Admin -> REDIRECT -> /super-admin/dashboard");
      return <Navigate to="/super-admin/dashboard" replace />;
    }

    const home = isCompanyAdmin(user) ? "/admin/user-management" : "/user/dashboard";
    const redirectTo = location.state?.from?.pathname || home;
    routeLog(`Login.jsx: already authenticated -> REDIRECT -> ${redirectTo}`);
    return <Navigate to={redirectTo} replace />;
  }

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setTouched({ email: true, password: true });
    if (!isFormValid) return;
    authLog("Login.jsx: handleSubmit called");
    setError(null);
    setSubmitting(true);

    const result = await login(email.trim().toLowerCase(), password, remember);
    authLog("Login.jsx: login() returned", result);

    if (!result.success) {
      setSubmitting(false);
      setError(result.message);
      return;
    }

    // Do not navigate imperatively, and do not log out based on role.
    // login() has already dispatched the new auth state, which
    // re-renders this component — the isAuthenticated check above then
    // redirects to the correct portal (Super Admin -> /super-admin/dashboard,
    // Company Admin -> /admin/user-management, User -> /user/dashboard) on
    // that next render, keeping the session alive either way.
    authLog("Login.jsx: handleSubmit done, waiting for re-render to redirect declaratively");
    setSubmitting(false);
  };

  return (
    <div className="app-shell flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <img
            src={LOGO_SRC}
            alt={`${BRAND} — AI Camera Surveillance`}
            style={{ mixBlendMode: "screen" }}
            className="h-14 w-auto select-none object-contain"
            draggable={false}
          />
          <p className="mt-4 font-display text-lg font-semibold text-white">{BRAND}</p>
          <p className="font-mono text-[11px] uppercase tracking-widest text-ink-500">AI Camera Surveillance</p>
        </div>

        <GlassCard className="p-6">
          <p className="mb-1 font-mono text-xs uppercase tracking-[0.2em] text-accent-cyan/80">Access Control</p>
          <h1 className="mb-5 font-display text-xl font-semibold text-white">
            {isAdminLoginPage ? "Admin Sign In" : "User Sign In"}
          </h1>

          <form className="space-y-4" onSubmit={handleSubmit}>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink-400">Email</label>
              <div className="relative">
                <Mail size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-500" />
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onBlur={() => setTouched((t) => ({ ...t, email: true }))}
                  placeholder="you@example.com"
                  className={`${inputClass} ${touched.email && emailError ? INVALID_INPUT_CLASS : ""}`}
                />
              </div>
              {touched.email && emailError && <p className="mt-1.5 text-xs text-red-400">{emailError}</p>}
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink-400">Password</label>
              <div className="relative">
                <Lock size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-500" />
                <input
                  type={showPassword ? "text" : "password"}
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onBlur={() => setTouched((t) => ({ ...t, password: true }))}
                  placeholder="••••••••"
                  className={`${inputClass} pr-10 ${touched.password && passwordError ? INVALID_INPUT_CLASS : ""}`}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-ink-500 hover:text-ink-200"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              {touched.password && passwordError && <p className="mt-1.5 text-xs text-red-400">{passwordError}</p>}
            </div>

            <label className="flex items-center gap-2 text-xs text-ink-400">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-white/20 bg-transparent accent-accent-cyan"
              />
              Remember me
            </label>

            {error && (
              <div className="flex items-start gap-2 rounded-xl border border-signal-red/30 bg-signal-red/10 px-3.5 py-2.5 text-xs text-signal-red">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <Button type="submit" className="w-full" disabled={submitting || !isFormValid}>
              {submitting ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Signing in…
                </>
              ) : (
                "Sign In"
              )}
            </Button>
          </form>
        </GlassCard>

        <p className="mt-6 text-center font-mono text-[10px] text-ink-700">
          Authorized personnel only. All access is logged.
        </p>

        {/* This same page is mounted at both /user/login and /admin/login
            (see comment above on the isAuthenticated redirect) — each
            side links to the other, reciprocally, so either role can
            reach its own login screen from the other's. Super Admin
            keeps its own separate entry point at /super-admin/login and
            isn't surfaced here — a plain route Link, never an
            auto-login or a shortcut around the real login form below. */}
        <p className="mt-3 text-center text-xs text-ink-400">
          {isAdminLoginPage ? (
            <>
              Are you a User?{" "}
              <Link to="/user/login" className="font-semibold text-accent-cyan hover:underline">
                User Sign In →
              </Link>
            </>
          ) : (
            <>
              Are you an Admin?{" "}
              <Link to="/admin/login" className="font-semibold text-accent-cyan hover:underline">
                Admin Sign In →
              </Link>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
