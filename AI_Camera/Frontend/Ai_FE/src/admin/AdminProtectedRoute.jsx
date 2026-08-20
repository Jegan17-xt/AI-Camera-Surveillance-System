import { Navigate, Outlet, useLocation } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { isSuperAdmin, isCompanyAdmin } from "../lib/permissions";
import { routeLog } from "../debugLog";

// Guards the Company Admin portal (/admin/*).
export default function AdminProtectedRoute() {
  const { isAuthenticated, isLoading, user } = useAuth();
  const location = useLocation();

  routeLog(`AdminProtectedRoute RENDER: path=${location.pathname} isLoading=${isLoading} isAuthenticated=${isAuthenticated} role=${user?.role ?? "null"}`);

  if (isLoading) {
    routeLog("AdminProtectedRoute: isLoading=true -> showing spinner, NOT redirecting");
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
    routeLog(`AdminProtectedRoute: REDIRECT -> /admin/login (from path=${location.pathname})`);
    return <Navigate to="/admin/login" replace state={{ from: location }} />;
  }

  if (isSuperAdmin(user)) {
    routeLog("AdminProtectedRoute: REDIRECT -> /super-admin/dashboard (role=\"Super Admin\" on Company Admin portal)");
    return <Navigate to="/super-admin/dashboard" replace />;
  }

  if (!isCompanyAdmin(user)) {
    routeLog("AdminProtectedRoute: REDIRECT -> /user/dashboard (role is not Company Admin)");
    return <Navigate to="/user/dashboard" replace />;
  }

  routeLog(`AdminProtectedRoute: authenticated, rendering Outlet for path=${location.pathname}`);
  return <Outlet />;
}
