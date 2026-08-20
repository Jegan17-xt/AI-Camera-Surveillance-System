import { createContext, useContext, useEffect, useState } from "react";
import { Outlet } from "react-router-dom";

const STORAGE_KEY = "admin_theme";
const AdminThemeContext = createContext(null);

function readStoredTheme() {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "light" ? "light" : "dark";
}

export function AdminThemeProvider() {
  const [theme, setTheme] = useState(readStoredTheme);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  return (
    <AdminThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      <div data-admin-theme={theme}>
        <Outlet />
      </div>
    </AdminThemeContext.Provider>
  );
}

export function useAdminTheme() {
  const ctx = useContext(AdminThemeContext);

  if (!ctx) {
    throw new Error("useAdminTheme must be used within AdminThemeProvider");
  }

  return ctx;
}
