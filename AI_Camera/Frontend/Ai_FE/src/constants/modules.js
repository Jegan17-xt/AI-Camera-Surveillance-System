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
// checks below, not which prefix hosts the route. 11 of the system's 12
// modules live here — every one a Company Admin can also grant to a User
// (see Backend/api/company_users.py's GRANTABLE_USER_MODULE_KEYS); only
// subscription_payment (COMPANY_ADMIN_ONLY_MODULES below) never mounts
// under /user/*.
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
// Sidebar.jsx's extraItems + ModuleRoute below. subscription_payment and
// site_management are the two entries here: subscription_payment is a
// Company Admin's own billing page; site_management (Sites / VPN Gateway
// Management) is Site CRUD + VPN Gateway config, also Company-Admin-only
// (see Backend/api/company_users.py's GRANTABLE_USER_MODULE_KEYS, which
// deliberately excludes both). Neither has a User-grantable equivalent —
// a User's own visibility into Sites is a plain field inside the shared
// Camera Management form (the "Site / Office" picker), not a page.
export const COMPANY_ADMIN_ONLY_MODULES = [
  { key: "subscription_payment", label: "Subscription & Payment", slug: "subscription-payment", icon: CreditCard },
  { key: "site_management", label: "Sites / VPN", slug: "sites", icon: Network },
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
};

// MODULES entries with `to` resolved against a specific portal's base path
// (e.g. "/admin" or "/user"), for Sidebar.jsx to render nav links from.
export const modulesForBase = (basePath) => MODULES.map((m) => ({ ...m, to: `${basePath}/${m.slug}` }));

// COMPANY_ADMIN_ONLY_MODULES resolved to /admin, for AdminLayout.jsx's
// Sidebar extraItems.
export const companyAdminOnlyModulesForAdmin = () =>
  COMPANY_ADMIN_ONLY_MODULES.map((m) => ({ ...m, to: `/admin/${m.slug}` }));
