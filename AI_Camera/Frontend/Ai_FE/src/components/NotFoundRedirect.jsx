import { Navigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { isSuperAdmin, isCompanyAdmin } from "../lib/permissions";
import { routeLog } from "../debugLog";

// Catch-all for any URL that doesn't match a real route — typos, stale
// bookmarks, hand-typed paths that were never real routes. Without this,
// React Router renders nothing for an unmatched path, which is the blank
// screen + "No routes matched location" console warning. Sends the
// visitor to wherever they actually belong instead.
export default function NotFoundRedirect() {
  const { isAuthenticated, isLoading, user } = useAuth();

  routeLog(`NotFoundRedirect RENDER: isLoading=${isLoading} isAuthenticated=${isAuthenticated} role=${user?.role ?? "null"}`);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-base-950">
        <Loader2 size={24} className="animate-spin text-ink-500" />
      </div>
    );
  }

  if (!isAuthenticated) {
    routeLog("NotFoundRedirect: REDIRECT -> /user/login (not authenticated)");
    return <Navigate to="/user/login" replace />;
  }

  const target = isSuperAdmin(user)
    ? "/super-admin/dashboard"
    : isCompanyAdmin(user)
      ? "/admin/user-management"
      : "/user/dashboard";
  routeLog(`NotFoundRedirect: REDIRECT -> ${target} (role="${user.role}")`);
  return <Navigate to={target} replace />;
}
