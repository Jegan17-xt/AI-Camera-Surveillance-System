import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import axios from "axios";
import "./index.css";
import App from "./App.jsx";
import { AuthProvider } from "./context/AuthContext.jsx";
import { APP_NAME } from "./constants/branding";

// Session auth relies on the signed cookie set by the Flask backend.
axios.defaults.withCredentials = true;

// CSRF protection (Phase 2, backend: auth/csrf.py + api/app.py's
// before_request check). The backend mints a `csrf_token` cookie on
// login (readable by JS — unlike the session cookie itself) and requires
// it echoed back as X-CSRF-Token on every state-changing request from an
// authenticated session. Registered once, globally, here — since every
// page in this app calls axios directly (no shared axios instance) —
// rather than needing to touch each of those call sites individually.
function readCookie(name) {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

axios.interceptors.request.use((config) => {
  const method = (config.method || "get").toUpperCase();
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    const token = readCookie("csrf_token");
    if (token) {
      config.headers = config.headers || {};
      config.headers["X-CSRF-Token"] = token;
    }
  }
  return config;
});

// index.html's <title> is only the pre-JS fallback (raw HTML can't
// import this constant) — this keeps the actual browser tab title in
// sync with the single source of truth once React takes over. Admin
// Portal routes then layer their own DB-driven title on top via
// AdminBrandingContext, which saves/restores whatever title is already
// set here, so ordering between the two never matters.
document.title = `${APP_NAME} — Surveillance Dashboard`;

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
);
