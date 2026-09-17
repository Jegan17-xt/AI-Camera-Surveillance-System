import { useEffect, useMemo, useState } from "react";
import { NavLink, Link, useLocation } from "react-router-dom";
import axios from "axios";
import { ShieldHalf, X, Lock, ChevronDown } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { sidebarGroupsForBase } from "../constants/modules";
import { hasAnyModule } from "../lib/permissions";
import { DATA_EVENTS, useDataEvent } from "../lib/dataEvents";
import { usePolling } from "../lib/usePolling";
import { APP_NAME, APP_SUBTITLE } from "../constants/branding";
import { API_BASE_URL } from "../lib/apiBase";

const MODULE_SYNC_POLL_MS = 15000;

// Shared by the Company Admin portal (/admin/*) and the User portal
// (/user/*) — `basePath` picks which prefix the nav links use. Super
// Admin has its own separate SuperAdminSidebar.
//
// The nav is a two-level accordion (7 top-level modules, expandable
// submenus) built from constants/modules.js SIDEBAR_GROUPS — that file's
// comment explains why this is presentation-only and changes no route or
// permission. Every child still carries the SAME module key its route is
// gated by; this component applies the identical hide/lock rule the old
// flat menu used:
//   - `showLocked` (Company Admin portal — AdminLayout passes true): keep
//     every ungranted module visible as a disabled row with a lock icon,
//     never removed from the menu.
//   - `showLocked` false (User portal): hide anything not granted, and
//     hide a whole group once it has no visible children — exactly the
//     old hide-if-unassigned behavior.
export default function Sidebar({ open, onClose, basePath, showLocked = false }) {
  const { user, updateUser } = useAuth();
  const location = useLocation();

  // A Super Admin can grant/revoke a module from a different browser
  // session — this keeps that reflected here (and in every ModuleRoute
  // gate reading the same user.modules) without a re-login.
  usePolling(() => {
    axios
      .get(`${API_BASE_URL}/me`)
      .then((res) => updateUser(res.data.user))
      .catch(() => {});
  }, MODULE_SYNC_POLL_MS);

  // Resolve groups for this portal, then apply per-child lock/visibility
  // using the existing permission check. `user` is the only reactive
  // input, so memoize on it + basePath.
  const groups = useMemo(() => {
    const isLocked = (item) =>
      item.moduleKey ? !hasAnyModule(user, item.moduleKey, ...(item.altKeys || [])) : false;

    return sidebarGroupsForBase(basePath)
      .map((g) => {
        if (g.children === null) {
          return { ...g, locked: isLocked(g) };
        }
        const children = g.children.map((c) => ({ ...c, locked: isLocked(c) }));
        // A package group (Cameras / People / Security & Detection /
        // Reports — constants/modules.js `pkg`) appears only when the
        // company owns that package, i.e. at least one of its
        // module-gated children is unlocked. Its locked children are
        // always hidden, never shown as a lock row — an un-purchased
        // package is absent from the menu entirely, in both portals.
        if (g.pkg) {
          const owned = children.some((c) => c.moduleKey && !c.locked);
          return { ...g, children: owned ? children.filter((c) => !c.locked) : [] };
        }
        const visible = showLocked ? children : children.filter((c) => !c.locked);
        return { ...g, children: visible };
      })
      // Drop a top-level link the user can't use (User portal only —
      // Dashboard is always granted so this never actually fires there),
      // and any group left with zero visible children.
      .filter((g) => (g.children === null ? showLocked || !g.locked : g.children.length > 0));
  }, [user, basePath, showLocked]);

  const groupHasActivePath = (g) =>
    Array.isArray(g.children) && g.children.some((c) => c.path === location.pathname);

  const [openGroups, setOpenGroups] = useState(() =>
    Object.fromEntries(
      groups.filter((g) => Array.isArray(g.children)).map((g) => [g.label, groupHasActivePath(g)])
    )
  );

  // Landing directly on a sub-page (deep link, bookmark, browser
  // back/forward) always reveals its parent group.
  useEffect(() => {
    setOpenGroups((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const g of groups) {
        if (Array.isArray(g.children) && groupHasActivePath(g) && !next[g.label]) {
          next[g.label] = true;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, groups]);

  const toggleGroup = (label) => setOpenGroups((prev) => ({ ...prev, [label]: !prev[label] }));

  // A submenu child is "active" when the current URL matches its route,
  // its ?type= filter, and its #section anchor. Bare page (no hash) ->
  // the parent still highlights via groupHasActivePath, no child row does.
  const childActive = (c) => {
    if (location.pathname !== c.path) return false;
    const curType = new URLSearchParams(location.search).get("type") || "";
    const wantType = c.query ? new URLSearchParams(c.query).get("type") || "" : "";
    if (curType !== wantType) return false;
    if (c.hash) return location.hash === `#${c.hash}`;
    return true;
  };

  // --- bottom widget: real live-camera counts (unchanged) ---
  const [cameraCounts, setCameraCounts] = useState(null);

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
  useDataEvent(DATA_EVENTS.CAMERAS_CHANGED, fetchCameraCounts);

  const camerasTotal = cameraCounts?.total || 0;
  const camerasOnline = cameraCounts?.online || 0;
  const hasCameras = cameraCounts !== null && camerasTotal > 0;

  const rowPad = { paddingTop: "0.6rem", paddingBottom: "0.6rem" };

  const lockedRow = (label, Icon, key) => (
    <div
      key={key}
      aria-disabled="true"
      title={`${label} is locked. Ask your Super Admin to enable this module.`}
      className="group relative flex cursor-not-allowed items-center gap-3 rounded-xl px-3.5 text-sm font-medium text-ink-600 opacity-60"
      style={rowPad}
    >
      {Icon ? <Icon size={18} strokeWidth={2} className="text-ink-600" /> : <span className="w-[18px]" />}
      <span className="flex-1">{label}</span>
      <Lock size={14} strokeWidth={2} className="text-ink-600" />
    </div>
  );

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm lg:hidden" onClick={onClose} />
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
          {groups.map((g) => {
            const Icon = g.icon;

            // --- Top-level link with no submenu (Dashboard) ---
            if (g.children === null) {
              if (g.locked) return lockedRow(g.label, Icon, g.to);
              return (
                <NavLink
                  key={g.to}
                  to={g.to}
                  end={g.end}
                  onClick={onClose}
                  className={({ isActive }) =>
                    `group relative flex items-center gap-3 rounded-xl px-3.5 text-sm font-medium transition-all duration-200 ${
                      isActive
                        ? "bg-gradient-to-r from-accent-cyan/15 to-transparent text-white"
                        : "text-ink-400 hover:bg-white/5 hover:text-ink-100"
                    }`
                  }
                  style={rowPad}
                >
                  {({ isActive }) => (
                    <>
                      {isActive && (
                        <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-accent-cyan shadow-[0_0_8px_rgba(34,211,238,0.8)]" />
                      )}
                      <Icon size={18} strokeWidth={2} className={isActive ? "text-accent-cyan" : "text-ink-500 group-hover:text-ink-200"} />
                      {g.label}
                    </>
                  )}
                </NavLink>
              );
            }

            // --- Parent module with an expandable submenu ---
            const groupActive = groupHasActivePath(g);
            const isOpen = !!openGroups[g.label];

            return (
              <div key={g.label}>
                <button
                  type="button"
                  onClick={() => toggleGroup(g.label)}
                  aria-expanded={isOpen}
                  className={`group relative flex w-full items-center gap-3 rounded-xl px-3.5 text-sm font-semibold transition-all duration-200 ${
                    groupActive
                      ? "bg-gradient-to-r from-accent-cyan/15 to-transparent text-white"
                      : "text-ink-300 hover:bg-white/5 hover:text-ink-100"
                  }`}
                  style={rowPad}
                >
                  {groupActive && (
                    <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-accent-cyan shadow-[0_0_8px_rgba(34,211,238,0.8)]" />
                  )}
                  <Icon size={18} strokeWidth={2} className={groupActive ? "text-accent-cyan" : "text-ink-500 group-hover:text-ink-200"} />
                  <span className="flex-1 text-left">{g.label}</span>
                  <ChevronDown
                    size={15}
                    strokeWidth={2}
                    className={`shrink-0 transition-transform duration-200 ${isOpen ? "rotate-180" : ""} ${
                      groupActive ? "text-accent-cyan" : "text-ink-500"
                    }`}
                  />
                </button>

                {isOpen && (
                  <div className="ml-[1.15rem] mt-1 mb-1 space-y-0.5 border-l border-white/10 pl-3">
                    {g.children.map((c) =>
                      c.locked ? (
                        lockedRow(c.label, null, c.to)
                      ) : (
                        <Link
                          key={c.to + c.label}
                          to={c.to}
                          onClick={onClose}
                          aria-current={childActive(c) ? "page" : undefined}
                          className={`relative flex items-center rounded-lg px-3 py-2 text-[13px] font-medium transition-all duration-200 ${
                            childActive(c)
                              ? "bg-accent-cyan/15 text-white"
                              : "text-ink-400 hover:bg-white/5 hover:text-ink-100"
                          }`}
                        >
                          {c.label}
                        </Link>
                      )
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* Live-camera connectivity widget — unchanged. */}
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
