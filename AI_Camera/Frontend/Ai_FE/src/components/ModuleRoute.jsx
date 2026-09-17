import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { PATH_TO_MODULE_KEYS } from "../constants/modules";
import { hasAnyModule } from "../lib/permissions";
import { routeLog } from "../debugLog";

export default function ModuleRoute() {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  const moduleKeys = PATH_TO_MODULE_KEYS[location.pathname];

  routeLog(`ModuleRoute RENDER: path=${location.pathname} moduleKeys=${JSON.stringify(moduleKeys)} userModules=${JSON.stringify(user?.modules)}`);

  // Never decide "forbidden" before the user's module list is actually
  // loaded. The portal ProtectedRoute above already holds rendering
  // until the session is settled, so in practice `user.modules` is
  // always an array here — this is belt-and-suspenders against any
  // transient render (a redirect chain, a bfcache restore) where auth
  // is still resolving. Returning null briefly is fine: the parent
  // route already showed a spinner for the loading state.
  if (moduleKeys && (isLoading || !Array.isArray(user?.modules))) {
    routeLog("ModuleRoute: auth/modules not resolved yet -> waiting, NOT redirecting");
    return null;
  }

  if (moduleKeys && !hasAnyModule(user, ...moduleKeys)) {
    const target = location.pathname.startsWith("/admin") ? "/admin/403" : "/user/403";
    routeLog(`ModuleRoute: REDIRECT -> ${target} (none of moduleKeys=${JSON.stringify(moduleKeys)} in user's modules)`);
    return <Navigate to={target} replace />;
  }

  routeLog(`ModuleRoute: permitted, rendering Outlet for path=${location.pathname}`);
  return <Outlet />;
}
