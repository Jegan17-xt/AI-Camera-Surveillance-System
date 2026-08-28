import { createContext, useContext, useEffect, useState } from "react";
import axios from "axios";
import { API_BASE_URL } from "../../lib/apiBase";

const DEFAULT_APP_NAME = "Sentinel Admin";
const AdminBrandingContext = createContext(null);

// Loaded once per authenticated Super Admin session (this provider only
// ever mounts inside AdminLayout, i.e. behind AdminProtectedRoute) and
// shared by every consumer — the Sidebar, the browser tab title, and the
// System Settings page itself all read the exact same value, so saving a
// new Application Name/Logo updates all of them the instant the save
// resolves, with no page refresh.
export function AdminBrandingProvider({ children }) {
  const [branding, setBranding] = useState({ app_name: DEFAULT_APP_NAME, logo_url: null });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    axios
      .get(`${API_BASE_URL}/branding`)
      .then((res) => {
        if (!cancelled) setBranding(res.data);
      })
      .catch(() => {
        // Keep the default — the Settings page surfaces its own error
        // toast if this was a real failure; the Sidebar/tab title simply
        // fall back rather than showing nothing.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Restores the document title on unmount (leaving the Admin Portal for
  // the User Portal) so the branding never bleeds into an unrelated tab.
  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${branding.app_name} — Super Admin Console`;

    return () => {
      document.title = previousTitle;
    };
  }, [branding.app_name]);

  return (
    <AdminBrandingContext.Provider value={{ branding, setBranding, loading }}>
      {children}
    </AdminBrandingContext.Provider>
  );
}

export function useAdminBranding() {
  const ctx = useContext(AdminBrandingContext);

  if (!ctx) {
    throw new Error("useAdminBranding must be used within an AdminBrandingProvider");
  }

  return ctx;
}
