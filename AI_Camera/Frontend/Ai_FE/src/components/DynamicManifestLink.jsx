import { useEffect } from "react";
import { useLocation } from "react-router-dom";

// Chrome's "Install app" prompt/menu-item only ever appears for a page
// that has BOTH a linked <link rel="manifest"> and a registered service
// worker (public/sw.js, registered site-wide in main.jsx — unrelated to
// installability by itself, and left untouched here). This is one SPA
// with a single static index.html (no full page reload between routes),
// so a manifest link placed there directly — the old behavior — applies
// to EVERY route, which is exactly why the public Landing page used to
// offer to install the app. This component swaps a single dynamic
// manifest <link> in and out of <head> on every navigation instead:
//   - /admin/*       -> /manifest-admin.webmanifest        (Admin TWA)
//   - /super-admin/* -> /manifest-super-admin.webmanifest  (Super Admin TWA)
//   - anything else (/, /user/*, ...) -> no manifest link at all
// so only the two role portals are ever installable — never the public
// site or the User portal. Scoped to the whole /admin and /super-admin
// trees (not just their literal /login pages) so an already-authenticated
// Company Admin/Super Admin browsing deeper pages can still install, not
// only while sitting on the login screen.
const MANIFEST_BY_PREFIX = [
  { prefix: "/super-admin", href: "/manifest-super-admin.webmanifest" },
  { prefix: "/admin", href: "/manifest-admin.webmanifest" },
];
const MANIFEST_LINK_ID = "zx-dynamic-manifest";

export default function DynamicManifestLink() {
  const { pathname } = useLocation();

  useEffect(() => {
    const match = MANIFEST_BY_PREFIX.find((m) => pathname === m.prefix || pathname.startsWith(`${m.prefix}/`));
    const existing = document.getElementById(MANIFEST_LINK_ID);

    if (!match) {
      existing?.remove();
      return;
    }

    if (existing) {
      existing.setAttribute("href", match.href);
    } else {
      const link = document.createElement("link");
      link.id = MANIFEST_LINK_ID;
      link.rel = "manifest";
      link.href = match.href;
      document.head.appendChild(link);
    }
  }, [pathname]);

  return null;
}
