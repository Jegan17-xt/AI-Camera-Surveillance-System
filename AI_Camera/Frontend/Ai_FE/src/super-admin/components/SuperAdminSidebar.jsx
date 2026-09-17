import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  Users,
  CreditCard,
  KeyRound,
  ScrollText,
  Settings,
  ChevronDown,
  LogOut,
  KeySquare,
  X,
  PieChart,
  UserPlus,
} from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { useAdminBranding } from "../context/AdminBrandingContext";

const navItems = [
  { to: "/super-admin/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/super-admin/company-management", label: "Company Admins", icon: Users },
  // New, fully additive read-only rollup (real storage/camera/user usage
  // per Company Admin and per User) — see Backend/api/admin_overview.py.
  // Deliberately its own page, not folded into "Company Admins" or
  // "Super Admin Management" below, so neither existing page's behavior
  // changes at all.
  { to: "/super-admin/admin-overview", label: "Admin & User Overview", icon: PieChart },
  { to: "/super-admin/password", label: "Passwords", icon: KeyRound },
  { to: "/super-admin/leads", label: "Leads", icon: UserPlus },
  { to: "/super-admin/audit-logs", label: "Activity Logs", icon: ScrollText },
];

// Collapsible groups — every Billing & Pricing-related page now lives
// under one place instead of being scattered as flat top-level items.
// Routes/pages for "Subscriptions"/"Payments"/"Payment History" are the
// same GET/PUT /subscriptions, /payments endpoints as before
// (Backend/api/subscriptions.py, untouched) — this only reorganizes how
// the existing pages are reached, split into 3 focused pages instead of
// one page trying to do all three at once (see AdminBillingSubscriptions.jsx,
// AdminBillingPaymentsLog.jsx, AdminBillingPaymentHistory.jsx).
const navGroups = [
  {
    label: "Billing & Payments",
    icon: CreditCard,
    children: [
      { to: "/super-admin/billing/overview", label: "Overview" },
      { to: "/super-admin/billing/pricing", label: "Pricing" },
      { to: "/super-admin/billing/subscriptions", label: "Subscriptions" },
      { to: "/super-admin/billing/payments", label: "Payments" },
      { to: "/super-admin/billing/payment-history", label: "Payment History" },
    ],
  },
  {
    // The former standalone "Admin Management" nav item now lives here
    // as "Super Admin Management" — same route, same page, only its
    // place in the sidebar changed. Routes/pages are untouched (see
    // App.jsx).
    label: "System Settings",
    icon: Settings,
    children: [
      { to: "/super-admin/system-settings", label: "General Settings" },
      { to: "/super-admin/website-settings", label: "Website Settings" },
      { to: "/super-admin/admin-management", label: "Super Admin Management" },
    ],
  },
];

export default function SuperAdminSidebar({ open, onClose }) {
  const { logout } = useAuth();
  const { branding } = useAdminBranding();
  const location = useLocation();

  const isGroupChildActive = (group) => group.children.some((child) => location.pathname.startsWith(child.to));

  const [openGroups, setOpenGroups] = useState(() =>
    Object.fromEntries(navGroups.map((group) => [group.label, isGroupChildActive(group)]))
  );

  // Landing directly on a child route (deep link, browser back/forward)
  // should always reveal its group, even if it was previously collapsed.
  useEffect(() => {
    setOpenGroups((prev) => {
      const next = { ...prev };
      let changed = false;

      for (const group of navGroups) {
        if (isGroupChildActive(group) && !next[group.label]) {
          next[group.label] = true;
          changed = true;
        }
      }

      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  const toggleGroup = (label) => setOpenGroups((prev) => ({ ...prev, [label]: !prev[label] }));

  const handleLogout = async () => {
    await logout();

    // A hard reload, not client-side router navigation. The browser's
    // Set-Cookie processing for the /logout response is not guaranteed to
    // have fully committed to the cookie store by the moment the axios
    // promise resolves — an SPA navigate() immediately afterward can race
    // it and land on a page whose first request still carries the old
    // session. A full navigation forces a fresh document load, giving
    // that response every chance to settle before any new request fires.
    window.location.href = "/super-admin/login";
  };

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/70 lg:hidden"
          onClick={onClose}
        />
      )}
      <aside
        className={`fixed z-40 flex h-screen w-64 flex-col border-r border-admin-accent/10 bg-admin-900 transition-transform duration-300 lg:sticky lg:top-0 lg:translate-x-0
        ${open ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-6">
          <div className="flex items-center gap-3">
            {branding.logo_url ? (
              <img
                src={branding.logo_url}
                alt={`${branding.app_name} logo`}
                className="h-10 w-10 shrink-0 rounded-md object-cover shadow-[0_0_20px_rgba(168,85,247,0.4)]"
              />
            ) : (
              <div className="flex h-10 w-10 items-center justify-center rounded-md bg-gradient-to-br from-admin-accent to-admin-accent-deep shadow-[0_0_20px_rgba(168,85,247,0.4)]">
                {/* Fixed literal white — sits on a permanently-vivid gradient badge in both themes. */}
                <KeySquare size={20} className="text-[#fff]" strokeWidth={2.4} />
              </div>
            )}
            <div>
              <p className="font-display text-sm font-semibold leading-tight text-white">{branding.app_name}</p>
              <p className="font-mono text-[10px] uppercase tracking-widest text-admin-gold">Control Console</p>
            </div>
          </div>
          <button onClick={onClose} className="text-ink-500 hover:text-white lg:hidden">
            <X size={20} />
          </button>
        </div>

        <nav className="custom-scroll flex-1 space-y-1 overflow-y-auto px-3 py-2">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              onClick={onClose}
              className={({ isActive }) =>
                `group relative flex items-center gap-3 rounded-md px-3.5 text-sm font-medium transition-all duration-200 ${
                  isActive
                    ? "bg-gradient-to-r from-admin-accent/20 to-transparent text-white"
                    : "text-ink-400 hover:bg-white/5 hover:text-ink-100"
                }`
              }
              style={{ paddingTop: "0.65rem", paddingBottom: "0.65rem" }}
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-admin-accent shadow-[0_0_8px_rgba(168,85,247,0.8)]" />
                  )}
                  <Icon
                    size={18}
                    strokeWidth={2}
                    className={isActive ? "text-admin-accent" : "text-ink-500 group-hover:text-ink-200"}
                  />
                  {label}
                </>
              )}
            </NavLink>
          ))}

          {navGroups.map((group) => {
            const active = isGroupChildActive(group);
            const isOpen = !!openGroups[group.label];
            const GroupIcon = group.icon;

            return (
              <div key={group.label}>
                <button
                  type="button"
                  onClick={() => toggleGroup(group.label)}
                  aria-expanded={isOpen}
                  className={`group relative flex w-full items-center gap-3 rounded-md px-3.5 text-sm font-medium transition-all duration-200 ${
                    active
                      ? "bg-gradient-to-r from-admin-accent/20 to-transparent text-white"
                      : "text-ink-400 hover:bg-white/5 hover:text-ink-100"
                  }`}
                  style={{ paddingTop: "0.65rem", paddingBottom: "0.65rem" }}
                >
                  {active && (
                    <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-admin-accent shadow-[0_0_8px_rgba(168,85,247,0.8)]" />
                  )}
                  <GroupIcon
                    size={18}
                    strokeWidth={2}
                    className={active ? "text-admin-accent" : "text-ink-500 group-hover:text-ink-200"}
                  />
                  <span className="flex-1 text-left">{group.label}</span>
                  <ChevronDown
                    size={16}
                    strokeWidth={2}
                    className={`shrink-0 transition-transform duration-200 ${isOpen ? "rotate-180" : ""} ${
                      active ? "text-admin-accent" : "text-ink-500"
                    }`}
                  />
                </button>

                {isOpen && (
                  <div className="ml-[1.15rem] mt-1 space-y-1 border-l border-white/10 pl-4">
                    {group.children.map((child) => (
                      <NavLink
                        key={child.to}
                        to={child.to}
                        onClick={onClose}
                        className={({ isActive }) =>
                          `relative flex items-center rounded-md px-3 py-2 text-sm font-medium transition-all duration-200 ${
                            isActive
                              ? "bg-admin-accent/15 text-white"
                              : "text-ink-400 hover:bg-white/5 hover:text-ink-100"
                          }`
                        }
                      >
                        {child.label}
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div className="p-3">
          <button
            onClick={handleLogout}
            className="flex w-full items-center gap-3 rounded-md px-3.5 py-2.5 text-sm font-medium text-signal-red hover:bg-signal-red/10"
          >
            <LogOut size={18} strokeWidth={2} />
            Logout
          </button>
        </div>
      </aside>
    </>
  );
}
