// Single source of truth for the User Portal's displayed application
// name/subtitle — change it here and it updates everywhere (browser tab
// title via main.jsx, Login page, Sidebar). Unrelated to the Admin
// Portal's own DB-driven branding (Backend/api/branding.py,
// AdminBrandingContext.jsx), which is a separate, already-centralized
// system with its own name.
export const APP_NAME = "AI Sentinel";
export const APP_SUBTITLE = "Surveillance OS";
