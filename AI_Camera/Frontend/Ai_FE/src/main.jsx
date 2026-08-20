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
