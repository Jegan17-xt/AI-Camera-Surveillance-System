import { useState } from "react";
import { Outlet } from "react-router-dom";
import SuperAdminSidebar from "../components/SuperAdminSidebar";
import SuperAdminNavbar from "../components/SuperAdminNavbar";
import PushNotificationManager from "../components/PushNotificationManager";
import { AdminBrandingProvider } from "../context/AdminBrandingContext";

export default function SuperAdminLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <AdminBrandingProvider>
      <div className="admin-shell flex min-h-screen">
        <SuperAdminSidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
        <div className="flex min-h-screen min-w-0 flex-1 flex-col">
          <SuperAdminNavbar onMenuClick={() => setSidebarOpen(true)} />
          <main className="custom-scroll flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
            <Outlet />
          </main>
        </div>
        <PushNotificationManager />
      </div>
    </AdminBrandingProvider>
  );
}
