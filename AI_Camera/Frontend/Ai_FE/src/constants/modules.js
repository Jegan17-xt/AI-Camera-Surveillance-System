import {
  LayoutDashboard,
  LineChart,
  Camera,
  Cctv,
  UserCog,
  CreditCard,
  Video,
  Users,
  ScanFace,
  ClipboardList,
  FileBarChart2,
  Settings as SettingsIcon,
  Network,
  Flame,
  ShieldAlert,
  PieChart,
} from "lucide-react";

// Mirrors the module_key values seeded in Backend/auth/database.py (MODULES).
// `altKeys` lists other module keys that also satisfy access to the same
// route/nav item (e.g. "registered_persons_view" is a legacy read-only
// stand-in for "registered_persons", still honored server-side for
// whichever User already held it — see company_users.py's
// _LEGACY_PRESERVED_MODULE_KEYS — but no longer its own grantable
// checkbox) — omitted where there's no alternative.
//
// `slug` is the URL segment under a portal's base path — this same page
// set is mounted at both /admin/* (Company Admin) and /user/* (User),
// each a fully separate portal with its own login. Which of these pages
// a given account can actually reach is governed by the module-permission
// checks below, not which prefix hosts the route. Most of the system's
// modules live here — every one a Company Admin can also grant to a User
// (see Backend/api/company_users.py's GRANTABLE_USER_MODULE_KEYS);
// subscription_payment and site_management (COMPANY_ADMIN_ONLY_MODULES
// below) never mount under /user/*.
export const MODULES = [
  { key: "dashboard", label: "Dashboard", slug: "dashboard", icon: LayoutDashboard },
  { key: "live_camera", label: "Live Camera", slug: "live-camera", icon: Video },
  {
    key: "unknown_person_analytics",
    label: "Unknown Person Analytics",
    slug: "unknown-person-analytics",
    icon: LineChart,
  },
  { key: "camera_management", label: "Camera Management", slug: "camera-management", icon: Camera },
  { key: "normal_camera", label: "Normal Camera", slug: "normal-camera", icon: Cctv },
  { key: "user_management", label: "User Management", slug: "user-management", icon: UserCog },
  {
    key: "registered_persons",
    altKeys: ["registered_persons_view"],
    label: "Registered Persons",
    slug: "registered-persons",
    icon: Users,
  },
  { key: "unknown_persons", label: "Unknown Persons", slug: "unknown-persons", icon: ScanFace },
  { key: "detection_events", label: "Detection Events", slug: "detection-events", icon: Flame },
  { key: "attendance", label: "Attendance", slug: "attendance", icon: ClipboardList },
  { key: "reports", label: "Reports", slug: "reports", icon: FileBarChart2 },
  { key: "settings", label: "Settings", slug: "settings", icon: SettingsIcon },
];

// The two portals that share this page set.
export const PORTAL_BASE_PATHS = ["/admin", "/user"];

// Company-Admin-EXCLUSIVE pages — unlike MODULES above, these are never
// mounted under /user/*, so they're kept out of that shared list rather
// than muddying its "mounted at both portals" invariant. Still driven by
// the exact same module-permission system (module_key matches
// Backend/auth/database.py's MODULES list) — a Company Admin only sees
// and can reach one of these if the Super Admin has granted it, via
// ModuleRoute below. site_management (Sites / VPN Gateway Management) is
// Site CRUD + VPN Gateway config, Company-Admin-only (see Backend/api/
// company_users.py's GRANTABLE_USER_MODULE_KEYS, which deliberately
// excludes it). No User-grantable equivalent — a User's own visibility
// into Sites is a plain field inside the shared Camera Management form
// (the "Site / Office" picker), not a page. subscription_payment (the
// Company Admin's own billing) is the SAME kind of Company-Admin-only,
// Super-Admin-granted module, but split into 3 pages — see
// SUBSCRIPTION_PAYMENT_PAGES below instead of an entry here.
export const COMPANY_ADMIN_ONLY_MODULES = [
  { key: "site_management", label: "Sites / VPN", slug: "sites", icon: Network },
];

// The 4 pages BOTH portals' old single combined Settings page were split
// into — /admin/settings (admin/pages/*) and /user/settings
// (pages/Settings.jsx, now unused — see the 2026-09-01 split memory).
// Mounted at both bases like MODULES above (unlike
// COMPANY_ADMIN_ONLY_MODULES), each still gated by the SAME "settings"
// module key as before — this is a page split, not a new permission — so
// PATH_TO_MODULE_KEYS below maps every slug at every base to ["settings"].
export const SETTINGS_PAGES = [
  { slug: "ai-settings", label: "AI Settings" },
  { slug: "notification-settings", label: "Notifications" },
  { slug: "detection-settings", label: "Detection Settings" },
  { slug: "company-settings", label: "Company Settings" },
];

// The 3 pages the old single combined Subscription & Payment page (Current
// Plan / Billing & Payment / Payment History sections on one page, linked
// only by #hash anchors) was split into — admin/pages/{CurrentPlan,
// BillingPayment,PaymentHistory}.jsx — so each is a fully separate
// page/route, not a scroll-linked section of one page. Company-Admin-only
// like COMPANY_ADMIN_ONLY_MODULES above (never mounted under /user/*), each
// still gated by the SAME "subscription_payment" module key as before —
// this is a page split, not a new permission.
export const SUBSCRIPTION_PAYMENT_PAGES = [
  { slug: "current-plan", label: "Current Plan" },
  { slug: "billing-payment", label: "Billing & Payment" },
  { slug: "payment-history", label: "Payment History" },
];

// Full pathname (either portal) -> the module key(s) that satisfy it, for
// ModuleRoute.jsx's per-route permission check.
export const PATH_TO_MODULE_KEYS = {
  ...Object.fromEntries(
    PORTAL_BASE_PATHS.flatMap((base) =>
      MODULES.map((m) => [`${base}/${m.slug}`, [m.key, ...(m.altKeys || [])]])
    )
  ),
  // Company Admin only — deliberately not registered under /user/*.
  ...Object.fromEntries(COMPANY_ADMIN_ONLY_MODULES.map((m) => [`/admin/${m.slug}`, [m.key]])),
  ...Object.fromEntries(
    SUBSCRIPTION_PAYMENT_PAGES.map((p) => [`/admin/${p.slug}`, ["subscription_payment"]])
  ),
  // Both portals — same "settings" gate MODULES' own "settings" entry used.
  ...Object.fromEntries(
    PORTAL_BASE_PATHS.flatMap((base) => SETTINGS_PAGES.map((p) => [`${base}/${p.slug}`, ["settings"]]))
  ),
};

// MODULES entries with `to` resolved against a specific portal's base path
// (e.g. "/admin" or "/user"), for Sidebar.jsx to render nav links from.
export const modulesForBase = (basePath) => MODULES.map((m) => ({ ...m, to: `${basePath}/${m.slug}` }));

// COMPANY_ADMIN_ONLY_MODULES resolved to /admin, for AdminLayout.jsx's
// Sidebar extraItems.
export const companyAdminOnlyModulesForAdmin = () =>
  COMPANY_ADMIN_ONLY_MODULES.map((m) => ({ ...m, to: `/admin/${m.slug}` }));


// ============================================================================
// Sidebar navigation grouping — PRESENTATION ONLY.
// ----------------------------------------------------------------------------
// SIDEBAR_GROUPS below is the USER portal (/user/*) menu — unchanged.
// ADMIN_SIDEBAR_GROUPS (further down) is the Company Admin portal
// (/admin/*) menu, which is deliberately different: no "Dashboard" entry
// (the /admin/dashboard ROUTE has been removed entirely — see App.jsx's
// ModulePortalRoutes({ includeDashboard: false }) — post-login and the
// `/admin` index both land on "User Management" instead; /user/dashboard
// and the shared Dashboard.jsx page are untouched), "User Management"
// and "User & Camera Overview" promoted to the top, People trimmed to
// just Registered/Unknown Persons, and Attendance moved under Reports as
// "Daily Attendance". sidebarGroupsForBase() picks the right one by
// portal.
//
// Reorganizes the SAME routes/pages above into top-level modules, each
// with an expandable submenu. This changes NOTHING about routing or
// permissions:
//   - every `route` is an EXISTING path already defined in App.jsx (a
//     MODULES slug, a COMPANY_ADMIN_ONLY_MODULES slug, or an account-level
//     route like `notifications` / `user-camera-overview`) — no new route
//     is introduced anywhere.
//   - `moduleKey` (+ `altKeys`) is the SAME permission key ModuleRoute.jsx
//     already gates that route with. Sidebar.jsx hides (User portal) or
//     locks (Company Admin portal, showLocked) a child using the existing
//     hasAnyModule() check — identical behavior to the old flat menu.
//   - a child with NO `moduleKey` is an always-reachable account-level
//     page (Alerts -> /notifications, User & Camera Overview), exactly as
//     it was reachable before.
//   - `adminOnly` marks a child/group whose route is only mounted under
//     /admin/* in App.jsx (Sites / VPN, User & Camera Overview, every
//     Subscription & Payment entry) — omitted from the /user portal
//     sidebar, matching today.
//   - `query` deep-links into an EXISTING page's EXISTING filter
//     (DetectionEvents `?type=`) — never a separate page. Submenu items
//     that resolve to the same page are intentional (e.g. "Reports >
//     Detection" and "Security & Detection > Detection Events" both open
//     the Detection Events log). Settings and Subscription & Payment are
//     each split into fully separate pages/routes — no `hash` anchors.
// ============================================================================
export const SIDEBAR_GROUPS = [
  {
    label: "Dashboard",
    icon: LayoutDashboard,
    route: "dashboard",
    moduleKey: "dashboard",
    end: true,
  },
  {
    label: "Cameras",
    icon: Camera,
    pkg: "cameras",
    children: [
      { label: "Camera Management", route: "camera-management", moduleKey: "camera_management" },
      { label: "Live Camera", route: "live-camera", moduleKey: "live_camera" },
      { label: "Normal Camera", route: "normal-camera", moduleKey: "normal_camera" },
      { label: "Sites / VPN", route: "sites", moduleKey: "site_management", adminOnly: true },
    ],
  },
  {
    label: "People",
    icon: Users,
    pkg: "people",
    children: [
      {
        label: "Registered Persons",
        route: "registered-persons",
        moduleKey: "registered_persons",
        altKeys: ["registered_persons_view"],
      },
      { label: "Unknown Persons", route: "unknown-persons", moduleKey: "unknown_persons" },
      { label: "User Management", route: "user-management", moduleKey: "user_management" },
      // Company-Admin-only overview page (no module grant/lock — every
      // Company Admin can always reach it, same as today's leadingItems).
      { label: "User & Camera Overview", route: "user-camera-overview", adminOnly: true },
      { label: "Attendance", route: "attendance", moduleKey: "attendance" },
    ],
  },
  {
    label: "Security & Detection",
    icon: ShieldAlert,
    pkg: "security",
    children: [
      { label: "Detection Events", route: "detection-events", moduleKey: "detection_events" },
      { label: "Vehicles", route: "detection-events", moduleKey: "detection_events", query: "type=CAR_DETECTED" },
      {
        label: "Animals / Birds",
        route: "detection-events",
        moduleKey: "detection_events",
        query: "type=ANIMAL_DETECTED,BIRD_DETECTED",
      },
      {
        label: "Fire / Smoke",
        route: "detection-events",
        moduleKey: "detection_events",
        query: "type=FIRE_DETECTED,SMOKE_DETECTED",
      },
      // Account-level notifications inbox — always reachable, no module key.
      { label: "Alerts", route: "notifications" },
    ],
  },
  {
    label: "Reports",
    icon: FileBarChart2,
    pkg: "reports",
    children: [
      { label: "Attendance", route: "reports", moduleKey: "reports" },
      // No separate "detection report" page exists — the Detection Events
      // log IS that record. Reuses the existing route.
      { label: "Detection", route: "detection-events", moduleKey: "detection_events" },
      { label: "Analytics", route: "unknown-person-analytics", moduleKey: "unknown_person_analytics" },
    ],
  },
  {
    // Stays a SEPARATE main module (never folded into Settings).
    label: "Subscription & Payment",
    icon: CreditCard,
    moduleKey: "subscription_payment",
    adminOnly: true,
    children: [
      { label: "Current Plan", route: "subscription-payment", moduleKey: "subscription_payment", adminOnly: true, hash: "current-plan" },
      { label: "Billing & Payment", route: "subscription-payment", moduleKey: "subscription_payment", adminOnly: true, hash: "billing" },
      { label: "Payment History", route: "subscription-payment", moduleKey: "subscription_payment", adminOnly: true, hash: "payment-history" },
    ],
  },
  {
    // 2026-09-01: split from a single Settings page into 4 own pages —
    // see user/pages/{AISettings,NotificationSettings,DetectionSettings,
    // CompanySettings}.jsx, same structure as ADMIN_SIDEBAR_GROUPS'
    // Settings group below. pages/Settings.jsx (the old combined page)
    // is no longer routed at all.
    label: "Settings",
    icon: SettingsIcon,
    moduleKey: "settings",
    children: [
      { label: "AI Settings", route: "ai-settings", moduleKey: "settings" },
      { label: "Notifications", route: "notification-settings", moduleKey: "settings" },
      { label: "Detection Settings", route: "detection-settings", moduleKey: "settings" },
      { label: "Company Settings", route: "company-settings", moduleKey: "settings" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Company Admin portal (/admin/*) menu — see the block comment above for
// how it differs from the User portal. Every `route` here is still an
// existing App.jsx path and every `moduleKey` the same permission gate as
// before; nothing about routing/permissions changes.
//
// 2026-08-31: the "Cameras", "People", "Security & Detection" and
// "Reports" groups (including the detection_events-gated "Detection
// Reports" item, plus "Daily Attendance" and "Analytics") are
// deliberately ABSENT from this Company Admin menu — those modules are
// managed through the User portal (/user/*) instead. This is a
// navigation-visibility change ONLY: the /admin/* routes, pages, backend
// APIs, ModuleRoute permission gates, package/billing logic and the User
// portal menu (SIDEBAR_GROUPS above) are all untouched.
// ---------------------------------------------------------------------------
export const ADMIN_SIDEBAR_GROUPS = [
  // Promoted to the former "Dashboard" position — two plain top-level
  // links, no submenu. "Dashboard" is intentionally absent from this
  // menu, and its /admin/dashboard ROUTE no longer exists at all (see
  // App.jsx) — this is now the Company Admin's post-login landing page
  // (App.jsx's `/admin` index redirect + every role-based redirect
  // elsewhere point here).
  { label: "User Management", icon: UserCog, route: "user-management", moduleKey: "user_management" },
  // No moduleKey — every Company Admin can always reach this page
  // (guarded only by AdminProtectedRoute's role check, same as before,
  // when it was the sidebar's "leadingItem").
  { label: "User & Camera Overview", icon: PieChart, route: "user-camera-overview" },
  {
    // Kept as its own main module per the earlier explicit requirement
    // ("Keep Subscription & Payment as a separate MAIN sidebar module")
    // — it wasn't in the new spec's list, but it's the only way to reach
    // the checkout page and removing it would be a functionality loss.
    label: "Subscription & Payment",
    icon: CreditCard,
    moduleKey: "subscription_payment",
    // 3 fully separate pages/routes, same split pattern as Settings below —
    // each is its own route (admin/pages/{CurrentPlan,BillingPayment,
    // PaymentHistory}.jsx), not a hash-scrolled section of one shared page.
    children: [
      { label: "Current Plan", route: "current-plan", moduleKey: "subscription_payment" },
      { label: "Billing & Payment", route: "billing-payment", moduleKey: "subscription_payment" },
      { label: "Payment History", route: "payment-history", moduleKey: "subscription_payment" },
    ],
  },
  {
    // 2026-09-01: split from a single Settings page (still the /user/*
    // page above) into 4 own pages — see admin/pages/settingsShared.jsx
    // + AISettings/NotificationSettings/DetectionSettings/CompanySettings.
    // Same "settings" moduleKey throughout; each `route` matches an
    // ADMIN_SETTINGS_PAGES slug and an App.jsx route.
    label: "Settings",
    icon: SettingsIcon,
    moduleKey: "settings",
    children: [
      { label: "AI Settings", route: "ai-settings", moduleKey: "settings" },
      { label: "Notifications", route: "notification-settings", moduleKey: "settings" },
      { label: "Detection Settings", route: "detection-settings", moduleKey: "settings" },
      { label: "Company Settings", route: "company-settings", moduleKey: "settings" },
    ],
  },
];

// Resolve the right group list for a portal base path ("/admin" |
// "/user"): prefixes every route, builds the final `to` (with ?query /
// #hash), drops adminOnly entries outside the Company Admin portal, and
// drops any group left with no children. Permission (hide/lock) is
// applied on top of this in Sidebar.jsx, which has the logged-in `user`.
export const sidebarGroupsForBase = (basePath) => {
  const isAdmin = basePath === "/admin";
  const source = isAdmin ? ADMIN_SIDEBAR_GROUPS : SIDEBAR_GROUPS;

  const resolveChild = (c) => {
    const path = `${basePath}/${c.route}`;
    const suffix = `${c.query ? `?${c.query}` : ""}${c.hash ? `#${c.hash}` : ""}`;
    return {
      label: c.label,
      path,
      to: path + suffix,
      moduleKey: c.moduleKey || null,
      altKeys: c.altKeys || [],
      query: c.query || null,
      hash: c.hash || null,
    };
  };

  return source
    .filter((g) => isAdmin || !g.adminOnly)
    .map((g) => {
      if (!g.children) {
        const resolved = resolveChild(g);
        return { label: g.label, icon: g.icon, end: !!g.end, moduleKey: resolved.moduleKey, ...resolved, children: null };
      }
      const children = g.children.filter((c) => isAdmin || !c.adminOnly).map(resolveChild);
      return { label: g.label, icon: g.icon, moduleKey: g.moduleKey || null, pkg: g.pkg || null, children };
    })
    .filter((g) => g.children === null || g.children.length > 0);
};
