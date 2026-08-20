import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { PATH_TO_MODULE_KEYS } from "../constants/modules";
import { hasAnyModule } from "../lib/permissions";
import { routeLog } from "../debugLog";

export default function ModuleRoute() {
  const { user } = useAuth();
  const location = useLocation();

  const moduleKeys = PATH_TO_MODULE_KEYS[location.pathname];

  routeLog(`ModuleRoute RENDER: path=${location.pathname} moduleKeys=${JSON.stringify(moduleKeys)} userModules=${JSON.stringify(user?.modules)}`);

  if (moduleKeys && !hasAnyModule(user, ...moduleKeys)) {
    const target = location.pathname.startsWith("/admin") ? "/admin/403" : "/user/403";
    routeLog(`ModuleRoute: REDIRECT -> ${target} (none of moduleKeys=${JSON.stringify(moduleKeys)} in user's modules)`);
    return <Navigate to={target} replace />;
  }

  routeLog(`ModuleRoute: permitted, rendering Outlet for path=${location.pathname}`);
  return <Outlet />;
}
