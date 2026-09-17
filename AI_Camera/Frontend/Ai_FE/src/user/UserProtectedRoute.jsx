import { Navigate, Outlet, useLocation } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { isSuperAdmin, isCompanyAdmin } from "../lib/permissions";
import { routeLog } from "../debugLog";

// Guards the User portal (/user/*).
export default function UserProtectedRoute() {
  const { isAuthenticated, isLoading, user } = useAuth();
  const location = useLocation();

  routeLog(`UserProtectedRoute RENDER: path=${location.pathname} isLoading=${isLoading} isAuthenticated=${isAuthenticated} role=${user?.role ?? "null"}`);

  if (isLoading) {
    routeLog("UserProtectedRoute: isLoading=true -> showing spinner, NOT redirecting");
    return (
      <div className="flex min-h-screen items-center justify-center bg-base-950">
        <div className="flex flex-col items-center gap-3 text-ink-500">
          <Loader2 size={24} className="animate-spin" />
          <p className="text-xs">Checking session…</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    routeLog(`UserProtectedRoute: REDIRECT -> /user/login (from path=${location.pathname})`);
    return <Navigate to="/user/login" replace state={{ from: location }} />;
  }

  if (isSuperAdmin(user)) {
    routeLog("UserProtectedRoute: REDIRECT -> /super-admin/dashboard (role=\"Super Admin\" on User portal)");
    return <Navigate to="/super-admin/dashboard" replace />;
  }

  if (isCompanyAdmin(user)) {
    routeLog("UserProtectedRoute: REDIRECT -> /admin/user-management (role=\"Company Admin\" on User portal)");
    return <Navigate to="/admin/user-management" replace />;
  }

  routeLog(`UserProtectedRoute: authenticated, rendering Outlet for path=${location.pathname}`);
  return <Outlet />;
}
