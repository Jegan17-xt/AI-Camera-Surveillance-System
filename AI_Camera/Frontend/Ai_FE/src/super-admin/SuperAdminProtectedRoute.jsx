import { Navigate, Outlet } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { isCompanyAdmin } from "../lib/permissions";
import { routeLog } from "../debugLog";

export default function SuperAdminProtectedRoute() {
  const { isAuthenticated, isLoading, user } = useAuth();

  routeLog(`SuperAdminProtectedRoute RENDER: isLoading=${isLoading} isAuthenticated=${isAuthenticated} role=${user?.role ?? "null"}`);

  if (isLoading) {
    routeLog("SuperAdminProtectedRoute: isLoading=true -> showing spinner, NOT redirecting");
    return (
      <div className="admin-shell flex min-h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-ink-500">
          <Loader2 size={24} className="animate-spin text-admin-accent" />
          <p className="text-xs">Checking session…</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    routeLog("SuperAdminProtectedRoute: REDIRECT -> /super-admin/login (not authenticated)");
    return <Navigate to="/super-admin/login" replace />;
  }

  // An authenticated Company Admin or User is not Super Admin — send
  // them to their own portal instead of a login screen their credentials
  // could never pass.
  if (user?.role !== "Super Admin") {
    const target = isCompanyAdmin(user) ? "/admin/user-management" : "/user/dashboard";
    routeLog(`SuperAdminProtectedRoute: REDIRECT -> ${target} (role="${user?.role}" is not Super Admin)`);
    return <Navigate to={target} replace />;
  }

  routeLog("SuperAdminProtectedRoute: authenticated as Super Admin, rendering Outlet");
  return <Outlet />;
}
