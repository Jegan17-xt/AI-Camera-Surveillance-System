import { useState } from "react";
import { Navigate } from "react-router-dom";
import { KeySquare, Mail, Lock, Eye, EyeOff, Loader2, AlertTriangle } from "lucide-react";
import AdminCard from "../ui/AdminCard";
import AdminButton from "../ui/AdminButton";
import { useAuth } from "../../context/AuthContext";
import { isCompanyAdmin } from "../../lib/permissions";
import { validateEmail, INVALID_INPUT_CLASS } from "../../lib/validation";

const inputClass =
  "w-full rounded-md admin-panel py-2.5 pl-10 pr-4 text-sm text-ink-100 placeholder:text-ink-500 outline-none focus:border-admin-accent/50 focus:ring-2 focus:ring-admin-accent/20 transition";

export default function SuperAdminLogin() {
  const { login, user, isAuthenticated, isLoading } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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

  if (!isLoading && isAuthenticated) {
    // Never reject a valid session because of which portal was used to
    // sign in — just route each role to where it belongs.
    if (user.role === "Super Admin") {
      return <Navigate to="/super-admin/dashboard" replace />;
    }

    return <Navigate to={isCompanyAdmin(user) ? "/admin/user-management" : "/user/dashboard"} replace />;
  }

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;
    setTouched({ email: true, password: true });
    if (!isFormValid) return;
    setError(null);
    setSubmitting(true);

    // `remember=false` — a session-only cookie, same default as the
    // Company Admin/User login's unchecked "Remember me" (Login.jsx).
    // This was hardcoded `true` before, which forced session.permanent=True
    // (api/routes.py's /login) on every Super Admin sign-in regardless of
    // intent, issuing a 7-day-lived cookie (PERMANENT_SESSION_LIFETIME,
    // api/app.py) that silently re-authenticated the dashboard on every
    // later app open with no credentials entered.
    const result = await login(email.trim().toLowerCase(), password, false);

    if (!result.success) {
      setSubmitting(false);
      setError(result.message);
      return;
    }

    // Do not navigate imperatively, and do not log out based on role.
    // login() has already dispatched the new auth state — the
    // isAuthenticated check above then redirects to the correct portal
    // on the next render, keeping the session alive either way.
    setSubmitting(false);
  };

  return (
    <div className="admin-shell flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-lg bg-gradient-to-br from-admin-accent to-admin-accent-deep shadow-[0_0_28px_rgba(168,85,247,0.4)]">
            {/* Fixed literal white — sits on a permanently-vivid gradient badge in both themes. */}
            <KeySquare size={26} className="text-[#fff]" strokeWidth={2.4} />
          </div>
          <p className="mt-4 font-display text-lg font-semibold text-white">Sentinel Admin</p>
          <p className="font-mono text-[11px] uppercase tracking-widest text-admin-gold">Control Console</p>
        </div>

        <AdminCard strong className="p-6">
          <p className="mb-1 font-mono text-xs uppercase tracking-[0.2em] text-admin-gold/80">Restricted Access</p>
          <h1 className="mb-5 font-display text-xl font-semibold text-white">Super Admin Sign-In</h1>

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
                  placeholder="admin@example.com"
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

            {error && (
              <div className="flex items-start gap-2 rounded-md border border-signal-red/30 bg-signal-red/10 px-3.5 py-2.5 text-xs text-signal-red">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <AdminButton type="submit" className="w-full" disabled={submitting || !isFormValid}>
              {submitting ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Verifying…
                </>
              ) : (
                "Enter Console"
              )}
            </AdminButton>
          </form>
        </AdminCard>

        <p className="mt-6 text-center font-mono text-[10px] text-ink-700">
          Super Admin access only. Every action is logged.
        </p>
      </div>
    </div>
  );
}
