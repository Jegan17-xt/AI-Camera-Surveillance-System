import { defineConfig } from 'vite'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const __dirname = dirname(fileURLToPath(import.meta.url))

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
  build: {
    rollupOptions: {
      // Three static HTML shells, ONE shared app (all three load the same
      // /src/main.jsx — Rollup dedupes it into shared chunks, not three
      // copies of the bundle). admin.html / super-admin.html exist ONLY
      // so each has its own manifest <link> present in the page's actual
      // served HTML, which Android Chrome's "Install app" installability
      // check requires — see admin.html's comment. .htaccess routes
      // /admin/* and /super-admin/* to their own shell; every other route
      // keeps using plain index.html, unchanged.
      input: {
        main: resolve(__dirname, 'index.html'),
        admin: resolve(__dirname, 'admin.html'),
        superAdmin: resolve(__dirname, 'super-admin.html'),
      },
    },
  },
})
