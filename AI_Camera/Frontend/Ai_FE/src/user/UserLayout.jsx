import { useState } from "react";
import { Outlet } from "react-router-dom";
import Sidebar from "../components/Sidebar";
import Navbar from "../components/Navbar";
import { SelectedUserProvider } from "../context/SelectedUserContext";

// User portal layout (/user/*). Still wrapped in SelectedUserProvider
// (even though a User has no "view as" selector of their own) so the
// shared pages' useSelectedUser() hook never needs to special-case which
// portal it's mounted under — for a User session the provider simply
// exposes selectedUserId=null and an empty users list.
export default function UserLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <SelectedUserProvider>
      <div className="app-shell flex min-h-screen">
        <Sidebar basePath="/user" open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
        <div className="flex min-h-screen min-w-0 flex-1 flex-col">
          <Navbar basePath="/user" onMenuClick={() => setSidebarOpen(true)} />
          <main className="custom-scroll flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
            <Outlet />
          </main>
        </div>
      </div>
    </SelectedUserProvider>
  );
}
