import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import axios from "axios";
import { Menu, Bell, ChevronDown, LogOut, UserCircle2, CreditCard, CheckCheck, Database } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { useSelectedUser } from "../context/SelectedUserContext";
import { roleLabel } from "../lib/permissions";
import { DATA_EVENTS, emitDataEvent, useDataEvent } from "../lib/dataEvents";
import { usePolling } from "../lib/usePolling";
import { API_BASE_URL } from "../lib/apiBase";

const NOTIF_POLL_MS = 15000;
// Same cadence as notifications — the Super Admin who changes this
// setting is a DIFFERENT browser session (Super Admin portal), so
// dataEvents.js's in-tab event bus can never reach this tab; polling is
// the only way this pill can learn about a change without a refresh.
const RETENTION_POLL_MS = 15000;

// Mirrors Backend/api/retention_settings.py's VALID_POLICIES exactly —
// the label shown in this pill for each saved Super Admin policy value.
const RETENTION_POLICY_LABELS = {
  permanent: "Permanent",
  "7_days": "7 Days",
  "1_month": "1 Month",
};

// Shared by both the Company Admin portal (/admin/*) and the User portal
// (/user/*) — `basePath` picks which prefix Profile/Payment/logout use.
export default function Navbar({ onMenuClick, basePath }) {
  const { user, logout } = useAuth();
  const { selectedUserId } = useSelectedUser();
  const [now, setNow] = useState(new Date());
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  const [notifOpen, setNotifOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [recentNotifications, setRecentNotifications] = useState([]);
  const notifRef = useRef(null);

  // Data Retention status — Super-Admin-set, view-only here. Company
  // Admin portal only (basePath === "/admin"); the User portal never
  // fetches or shows this. Backend/api/routes.py's
  // GET /account/retention-settings resolves the company via
  // get_tenant_id(current_user) server-side, so this account can only
  // ever see its OWN company's policy — never another's, and there's no
  // PUT here at all (view-only, matches the task's "Company Admin can
  // only VIEW" requirement). The saved DB row (read fresh on every poll
  // below) is the single source of truth — this state is only ever a
  // cache of the last successful read of it, never written to directly.
  const [retentionPolicy, setRetentionPolicy] = useState(null);

  const fetchRetentionPolicy = () => {
    if (basePath !== "/admin") return;

    axios
      .get(`${API_BASE_URL}/account/retention-settings`)
      .then((res) => setRetentionPolicy(res.data.retention_settings?.policy || null))
      .catch(() => {});
  };

  // Immediate fetch on mount/basePath change, PLUS a recurring poll
  // (same shape as fetchNotifSummary/usePolling below) so a Super Admin
  // saving a new policy in their own session shows up here — without
  // any refresh — the next time this tick fires (worst case
  // RETENTION_POLL_MS later; usePolling also fires immediately the
  // moment this tab regains focus/visibility, so it's never stale for
  // long after coming back to it).
  useEffect(fetchRetentionPolicy, [basePath]);
  usePolling(fetchRetentionPolicy, RETENTION_POLL_MS, { enabled: basePath === "/admin" });

  const fetchNotifSummary = () => {
    axios
      .get(`${API_BASE_URL}/account/notifications`, {
        params: { limit: 6, ...(selectedUserId !== null ? { user_id: selectedUserId } : {}) },
      })
      .then((res) => {
        setUnreadCount(res.data.unread_count || 0);
        setRecentNotifications(res.data.notifications || []);
      })
      .catch(() => {});
  };

  useEffect(fetchNotifSummary, [selectedUserId]);
  useDataEvent(DATA_EVENTS.NOTIFICATIONS_CHANGED, fetchNotifSummary);
  usePolling(fetchNotifSummary, NOTIF_POLL_MS);

  const handleMarkAllRead = () => {
    axios
      .put(`${API_BASE_URL}/account/notifications/read-all`, null, {
        params: selectedUserId !== null ? { user_id: selectedUserId } : undefined,
      })
      .then(() => {
        emitDataEvent(DATA_EVENTS.NOTIFICATIONS_CHANGED);
      })
      .catch(() => {});
  };

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpen(false);
      }
      if (notifRef.current && !notifRef.current.contains(e.target)) {
        setNotifOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const dateStr = now.toLocaleDateString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const timeStr = now.toLocaleTimeString(undefined, { hour12: true });

  return (
    <header className="sticky top-0 z-20 border-b border-white/8 bg-base-950/70 backdrop-blur-2xl">
      <div className="flex items-center justify-between gap-4 px-4 py-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <button
            onClick={onMenuClick}
            className="shrink-0 rounded-lg p-2 text-ink-300 hover:bg-white/5 hover:text-white lg:hidden"
          >
            <Menu size={20} />
          </button>
          <div className="min-w-0">
            <h2 className="truncate font-display text-base font-semibold text-white sm:text-lg">
              AI Camera Surveillance System
            </h2>
            <p className="hidden truncate font-mono text-[11px] text-ink-500 sm:block">
              Real-time facial recognition &amp; attendance monitoring
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-3 sm:gap-4">
          <div className="hidden items-center gap-2 rounded-xl glass px-3.5 py-2 md:flex">
            <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-signal-green" />
            <span className="font-mono text-xs text-ink-300">{dateStr}</span>
            <span className="mx-1 h-3 w-px bg-white/10" />
            <span className="font-mono text-xs text-accent-cyan">{timeStr}</span>
          </div>

          {basePath === "/admin" && retentionPolicy && (
            <div className="hidden items-center gap-2 rounded-xl glass px-3.5 py-2 lg:flex">
              <Database size={13} className="text-accent-cyan" />
              <span className="font-mono text-xs text-ink-300">
                Data Retention: <span className="text-accent-cyan">{RETENTION_POLICY_LABELS[retentionPolicy] || retentionPolicy}</span>
              </span>
            </div>
          )}

          <div className="relative" ref={notifRef}>
            <button
              onClick={() => setNotifOpen((v) => !v)}
              className="relative rounded-xl p-2.5 text-ink-300 glass hover:text-white transition"
            >
              <Bell size={18} />
              {unreadCount > 0 && (
                <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-signal-red ring-2 ring-base-950" />
              )}
            </button>

            {notifOpen && (
              <div className="absolute right-0 top-[calc(100%+8px)] z-30 w-[calc(100vw-6rem)] max-w-80 overflow-hidden rounded-xl glass-strong shadow-2xl">
                <div className="flex items-center justify-between border-b border-white/8 px-3.5 py-3">
                  <p className="text-xs font-semibold text-white">Notifications</p>
                  {unreadCount > 0 && (
                    <button
                      onClick={handleMarkAllRead}
                      className="flex items-center gap-1 text-[11px] font-medium text-accent-cyan hover:text-accent-cyan/80"
                    >
                      <CheckCheck size={12} />
                      Mark all read
                    </button>
                  )}
                </div>

                <div className="custom-scroll max-h-72 overflow-y-auto">
                  {recentNotifications.length === 0 ? (
                    <p className="px-3.5 py-6 text-center text-xs text-ink-500">No notifications yet.</p>
                  ) : (
                    recentNotifications.map((n) => (
                      <div
                        key={n.id}
                        className={`border-b border-white/5 px-3.5 py-2.5 last:border-b-0 ${
                          !n.is_read ? "bg-accent-cyan/5" : ""
                        }`}
                      >
                        <p className="text-xs text-ink-100">{n.message}</p>
                        <p className="mt-0.5 font-mono text-[10px] text-ink-500">{n.created_at}</p>
                      </div>
                    ))
                  )}
                </div>

                <Link
                  to={`${basePath}/notifications`}
                  onClick={() => setNotifOpen(false)}
                  className="block border-t border-white/8 px-3.5 py-2.5 text-center text-xs font-medium text-accent-cyan hover:bg-white/5"
                >
                  View all
                </Link>
              </div>
            )}
          </div>

          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="flex items-center gap-2.5 rounded-xl glass py-1.5 pl-1.5 pr-3 hover:border-accent-cyan/40 transition"
            >
              {user?.avatar_url ? (
                <img
                  src={user.avatar_url}
                  alt="User avatar"
                  className="h-8 w-8 rounded-lg object-cover ring-1 ring-white/10"
                />
              ) : (
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-cyan/10 text-xs font-semibold text-accent-cyan ring-1 ring-white/10">
                  {(user?.name || "?").trim().charAt(0).toUpperCase()}
                </span>
              )}
              <span className="hidden text-left sm:block">
                <span className="block text-xs font-medium text-white">{user?.name || "—"}</span>
                <span className="block text-[10px] text-ink-500">{roleLabel(user)}</span>
              </span>
              <ChevronDown size={14} className="hidden text-ink-500 sm:block" />
            </button>

            {menuOpen && (
              <div className="absolute right-0 top-[calc(100%+8px)] z-30 w-48 overflow-hidden rounded-xl glass-strong shadow-2xl">
                <div className="border-b border-white/8 px-3.5 py-3">
                  <p className="truncate text-xs font-medium text-white">{user?.name}</p>
                  <p className="truncate text-[11px] text-ink-500">{user?.email}</p>
                </div>
                {/* Profile/Payment are Company Admin only — a User's
                    profile dropdown is intentionally just Logout. */}
                {basePath === "/admin" && (
                  <>
                    <Link
                      to={`${basePath}/profile`}
                      onClick={() => setMenuOpen(false)}
                      className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-xs font-medium text-ink-200 hover:bg-white/5 hover:text-white"
                    >
                      <UserCircle2 size={14} />
                      Profile
                    </Link>
                    <Link
                      to={`${basePath}/subscription`}
                      onClick={() => setMenuOpen(false)}
                      className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-xs font-medium text-ink-200 hover:bg-white/5 hover:text-white"
                    >
                      <CreditCard size={14} />
                      Payment
                    </Link>
                  </>
                )}
                <button
                  onClick={async () => {
                    setMenuOpen(false);
                    await logout();
                    // Hard reload rather than relying on the protected
                    // route's declarative redirect — see SuperAdminSidebar's
                    // logout for why: an SPA-only transition can render the
                    // next page before the browser has fully committed
                    // /logout's Set-Cookie, letting a stale session leak
                    // through.
                    window.location.href = `${basePath}/login`;
                  }}
                  className="flex w-full items-center gap-2 border-t border-white/8 px-3.5 py-2.5 text-left text-xs font-medium text-signal-red hover:bg-signal-red/10"
                >
                  <LogOut size={14} />
                  Logout
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
