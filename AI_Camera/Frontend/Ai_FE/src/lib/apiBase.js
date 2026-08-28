// Backend API origin. Set via VITE_API_BASE_URL (see .env.production /
// .env.development) so builds point at the right backend without code
// changes; falls back to the local dev backend if the env var is unset.
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:5000";
