import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import axios from "axios";
import { ShieldHalf, X, Lock } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { modulesForBase } from "../constants/modules";
import { hasAnyModule } from "../lib/permissions";
import { DATA_EVENTS, useDataEvent } from "../lib/dataEvents";
import { usePolling } from "../lib/usePolling";
import { APP_NAME, APP_SUBTITLE } from "../constants/branding";
import { API_BASE_URL } from "../lib/apiBase";

const MODULE_SYNC_POLL_MS = 15000;

// Shared by both the Company Admin portal (/admin/*) and the User portal
// (/user/*) — `basePath` picks which prefix this instance's module-driven
// links use. Super Admin has its own separate SuperAdminSidebar, not
// this component.
//
// `extraItems` are Company-Admin-only top-level pages (Camera Management,
// User Management, Subscription & Payment) — AdminLayout always passes
// these (only a Company Admin ever reaches that layout); UserLayout never
// does. Rendered right after Dashboard, ahead of the rest of the
// module-driven items. Each one MUST carry its own module `key`, checked
// the same way as `moduleItems` below.
//
// `leadingItems` are Company-Admin-only top-level pages that must render
// ABOVE Dashboard (currently just "User & Camera Overview") — kept as
// their own separate list rather than folded into `extraItems` because
// they carry no module `key` at all (not part of the Super Admin's
// per-module grant/lock system — every Company Admin can always reach
// one, same as Profile/Subscription/Notifications), so they skip
// withLockState/applyVisibility entirely and are simply prepended as-is.
//
// `showLocked` (Company Admin portal only — AdminLayout passes true) keeps
// every module visible in its normal place even when the Super Admin
// hasn't granted it, rendering it as a disabled row with a lock icon
// instead of removing it from the menu. The User portal never passes this
// (defaults to false), preserving its original hide-if-unassigned
// behavior — that permission tier is managed separately by the Company
// Admin, not part of this Super Admin -> Admin access system.
export default function Sidebar({ open, onClose, basePath, extraItems = [], leadingItems = [], showLocked = false }) {
  const { user, updateUser } = useAuth();

  // A Super Admin can grant/revoke a module from a completely different
  // browser session (AdminCustomers.jsx's Edit modal, or
  // AdminCompanyDetails.jsx's Module Access & Billing section) — this
  // keeps that change reflected here (locked/unlocked rows, and every
  // module-gated route via ModuleRoute.jsx reading the same user.modules)
  // without requiring a re-login. Same polling pattern already used on
  // SubscriptionPayment.jsx for live pricing/lock state.
  usePolling(() => {
    axios
      .get(`${API_BASE_URL}/me`)
      .then((res) => updateUser(res.data.user))
      .catch(() => {});
  }, MODULE_SYNC_POLL_MS);

  const withLockState = (list) =>
    list.map((item) => ({ ...item, locked: !hasAnyModule(user, item.key, ...(item.altKeys || [])) }));

  // showLocked=false (User portal): keep the original behavior of hiding
  // anything not granted. showLocked=true (Company Admin portal): keep
  // every module in the menu, tagging the ungranted ones as locked so
  // they render disabled with a lock icon instead of disappearing.
  const applyVisibility = (list) => {
    const withLocks = withLockState(list);
    return showLocked ? withLocks : withLocks.filter((item) => !item.locked);
  };

  const moduleItems = applyVisibility(modulesForBase(basePath));
  const dashboardItem = moduleItems.find((m) => m.key === "dashboard");
  const restModuleItems = moduleItems.filter((m) => m.key !== "dashboard");
  const visibleExtraItems = applyVisibility(extraItems);
  const items = [
    ...leadingItems,
    ...(dashboardItem ? [dashboardItem] : []),
    ...visibleExtraItems,
    ...restModuleItems,
  ];

  // Real counts from this customer's own Camera Management rows (see
  // Backend/api/cameras.py get_camera_counts) — never a static/demo
  // number. Fetched independently of the Dashboard page's own /dashboard
  // call since the Sidebar (and this widget) renders on every protected
  // page, including ones a user without the Dashboard module never
  // loads /dashboard for.
  const [cameraCounts, setCameraCounts] = useState(null); // null while loading

  const fetchCameraCounts = () => {
    let cancelled = false;

    axios
      .get(`${API_BASE_URL}/account/cameras/summary`)
      .then((res) => {
        if (!cancelled) setCameraCounts(res.data);
      })
      .catch(() => {
        if (!cancelled) setCameraCounts({ online: 0, total: 0 });
      });

    return () => {
      cancelled = true;
    };
  };

  useEffect(fetchCameraCounts, []);

  // A camera being added/edited/deleted/tested only ever happens from
  // the Super Admin Portal — a different browser session — but this
  // keeps the widget correct the moment any in-session source of that
  // same event exists, without polling.
  useDataEvent(DATA_EVENTS.CAMERAS_CHANGED, fetchCameraCounts);

  const camerasTotal = cameraCounts?.total || 0;
  const camerasOnline = cameraCounts?.online || 0;
  const hasCameras = cameraCounts !== null && camerasTotal > 0;

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={onClose}
        />
      )}
      <aside
        className={`fixed z-40 flex h-screen w-64 flex-col border-r border-white/8 bg-base-900/80 backdrop-blur-2xl transition-transform duration-300 lg:sticky lg:top-0 lg:translate-x-0
        ${open ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-accent-cyan to-accent-deep shadow-[0_0_20px_rgba(34,211,238,0.35)]">
              <ShieldHalf size={20} className="text-base-950" strokeWidth={2.4} />
            </div>
            <div>
              <p className="font-display text-sm font-semibold leading-tight text-white">{APP_NAME}</p>
              <p className="font-mono text-[10px] uppercase tracking-widest text-ink-500">{APP_SUBTITLE}</p>
            </div>
          </div>
          <button onClick={onClose} className="shrink-0 rounded-lg p-2 text-ink-500 hover:bg-white/5 hover:text-white lg:hidden">
            <X size={20} />
          </button>
        </div>

        <nav className="custom-scroll flex-1 space-y-1 overflow-y-auto px-3 py-2">
          {items.map(({ to, label, icon: Icon, locked }) =>
            locked ? (
              <div
                key={to}
                aria-disabled="true"
                title={`${label} is locked. Ask your Super Admin to enable this module.`}
                className="group relative flex cursor-not-allowed items-center gap-3 rounded-xl px-3.5 text-sm font-medium text-ink-600 opacity-60"
                style={{ paddingTop: "0.65rem", paddingBottom: "0.65rem" }}
              >
                <Icon size={18} strokeWidth={2} className="text-ink-600" />
                <span className="flex-1">{label}</span>
                <Lock size={14} strokeWidth={2} className="text-ink-600" />
              </div>
            ) : (
              <NavLink
                key={to}
                to={to}
                end={to === `${basePath}/dashboard`}
                onClick={onClose}
                className={({ isActive }) =>
                  `group relative flex items-center gap-3 rounded-xl px-3.5 text-sm font-medium transition-all duration-200 ${
                    isActive
                      ? "bg-gradient-to-r from-accent-cyan/15 to-transparent text-white"
                      : "text-ink-400 hover:bg-white/5 hover:text-ink-100"
                  }`
                }
                style={{ paddingTop: "0.65rem", paddingBottom: "0.65rem" }}
              >
                {({ isActive }) => (
                  <>
                    {isActive && (
                      <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-accent-cyan shadow-[0_0_8px_rgba(34,211,238,0.8)]" />
                    )}
                    <Icon
                      size={18}
                      strokeWidth={2}
                      className={isActive ? "text-accent-cyan" : "text-ink-500 group-hover:text-ink-200"}
                    />
                    {label}
                  </>
                )}
              </NavLink>
            )
          )}
        </nav>

        {/* Reports Camera Management's (RTSP/AI Detection Engine) real
            live connectivity — get_camera_counts() above, nothing to do
            with the separate, static Normal Camera registry. Labeled
            explicitly "Live Cameras" (not just "Cameras") so it's never
            mistaken for a status indicator belonging to whichever
            camera-related page happens to be open, including Normal
            Camera — that page has no live/online concept at all. */}
        <div className="m-3 rounded-xl border border-white/8 bg-white/[0.03] p-3.5">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${hasCameras && camerasOnline > 0 ? "pulse-dot bg-signal-green" : "bg-ink-700"}`} />
            <p className="font-mono text-[11px] text-ink-300">
              {hasCameras ? `${camerasOnline} / ${camerasTotal} Live Cameras Online` : "No live cameras configured"}
            </p>
          </div>
          <p className="mt-1.5 text-[11px] text-ink-500">
            {hasCameras ? "Live monitoring active." : "Add a live camera in Camera Management to begin monitoring."}
          </p>
        </div>
      </aside>
    </>
  );
}
