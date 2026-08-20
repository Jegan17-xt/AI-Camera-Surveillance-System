import { useState } from "react";
import { Outlet } from "react-router-dom";
import { Users } from "lucide-react";

import Sidebar from "../components/Sidebar";
import Navbar from "../components/Navbar";
import { companyAdminOnlyModulesForAdmin } from "../constants/modules";
import { SelectedUserProvider } from "../context/SelectedUserContext";

// Company Admin portal layout (/admin/*). Subscription & Payment is the
// one remaining Company-Admin-exclusive page (never mounted under
// /user/*, see constants/modules.js COMPANY_ADMIN_ONLY_MODULES), passed
// to Sidebar as extraItems — it still carries its own module `key`, so
// Sidebar checks it against the Super Admin's actual grant exactly like
// every other module. Order here + the module-driven items Sidebar
// appends after it is what produces the full menu order.
const EXTRA_ITEMS = companyAdminOnlyModulesForAdmin();

// "User & Camera Overview" — the one nav item that must render ABOVE
// Dashboard (see Sidebar.jsx's leadingItems). Not part of the module
// grant/lock system at all (no `key`/Super-Admin toggle involved) — every
// Company Admin can always reach it, matching its route in App.jsx
// (guarded purely by AdminProtectedRoute's role check, same as Profile/
// Subscription/Notifications) and the backend's company_admin_required
// gate on GET /dashboard/user-camera-overview.
const LEADING_ITEMS = [
  { to: "/admin/user-camera-overview", label: "User & Camera Overview", icon: Users },
];

export default function AdminLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <SelectedUserProvider>
      <div className="app-shell flex min-h-screen">
        {/* showLocked: every module (incl. Payment) stays visible in the
            Admin sidebar even when ungranted — rendered locked/disabled
            with a lock icon rather than hidden, per the Super Admin ->
            Admin module access system. */}
        <Sidebar
          basePath="/admin"
          extraItems={EXTRA_ITEMS}
          leadingItems={LEADING_ITEMS}
          showLocked
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
        />
        <div className="flex min-h-screen min-w-0 flex-1 flex-col">
          <Navbar basePath="/admin" onMenuClick={() => setSidebarOpen(true)} />
          <main className="custom-scroll flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
            <Outlet />
          </main>
        </div>
      </div>
    </SelectedUserProvider>
  );
}
