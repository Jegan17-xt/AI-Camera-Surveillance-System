import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// `no-store` on the served document is what actually stops a browser from
// keeping a protected page (e.g. /dashboard) eligible for the back-forward
// cache — without it, a hard-reload logout still lets Back restore the
// previous page's frozen DOM/JS state instead of forcing a fresh load that
// would re-run the /me check and redirect to /login.
const noStoreHeaders = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  Pragma: "no-cache",
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    headers: noStoreHeaders,
  },
  preview: {
    headers: noStoreHeaders,
  },
})
