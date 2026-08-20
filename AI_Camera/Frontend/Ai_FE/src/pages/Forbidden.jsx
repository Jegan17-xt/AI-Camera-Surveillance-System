import { Link, useLocation } from "react-router-dom";
import { ShieldAlert } from "lucide-react";
import GlassCard from "../components/ui/GlassCard";
import Button from "../components/ui/Button";

// Mounted at both /admin/403 and /user/403 — the "back to dashboard"
// link stays within whichever portal it was reached from.
export default function Forbidden() {
  const location = useLocation();
  const basePath = location.pathname.startsWith("/admin") ? "/admin" : "/user";

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <GlassCard className="w-full max-w-sm p-6 text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-signal-red/10 text-signal-red">
          <ShieldAlert size={26} />
        </div>
        <p className="mb-1 font-mono text-xs uppercase tracking-[0.2em] text-signal-red/80">403 — Forbidden</p>
        <h1 className="mb-2 font-display text-xl font-semibold text-white">Access Denied</h1>
        <p className="mb-6 text-sm text-ink-400">
          You don't have permission to view this module. Contact your Super Admin if you believe this is a mistake.
        </p>
        <Link to={`${basePath}/dashboard`}>
          <Button className="w-full">Back to Dashboard</Button>
        </Link>
      </GlassCard>
    </div>
  );
}
