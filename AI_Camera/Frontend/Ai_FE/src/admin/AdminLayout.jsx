import { useState } from "react";
import { Outlet } from "react-router-dom";

import Sidebar from "../components/Sidebar";
import Navbar from "../components/Navbar";
import { SelectedUserProvider } from "../context/SelectedUserContext";

// Company Admin portal layout (/admin/*).
//
// The full 7-module accordion nav — including the Company-Admin-only
// entries (Subscription & Payment, Sites / VPN, User & Camera Overview) —
// is now defined once in constants/modules.js SIDEBAR_GROUPS and rendered
// by Sidebar.jsx from `basePath` + `showLocked` alone. `showLocked` keeps
// every ungranted module visible as a locked row (the Super Admin ->
// Company Admin module-access system), instead of hiding it.
export default function AdminLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <SelectedUserProvider>
      <div className="app-shell flex min-h-screen">
        <Sidebar
          basePath="/admin"
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
