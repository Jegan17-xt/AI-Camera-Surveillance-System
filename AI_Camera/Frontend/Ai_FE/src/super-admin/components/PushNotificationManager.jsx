import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import { Bell, BellOff, X } from "lucide-react";
import { API_BASE_URL } from "../../lib/apiBase";
import { isFirebaseConfigured, isPushAvailable, requestPushPermissionAndToken, onForegroundLeadNotification } from "../../lib/firebase";

// "New Lead Received" push notifications — Super Admin only (mounted in
// SuperAdminLayout.jsx, never in the Admin or User portals, so a Company
// Admin/User account can never end up here at all). Renders a small,
// dismissible prompt banner ONLY while permission genuinely hasn't been
// decided yet, plus a toast for a lead that arrives while this tab is
// open/focused; otherwise renders nothing. Every browser interaction
// this component performs (requestPermission, service worker
// registration, getToken) is a real, standard, user-controlled browser
// API — nothing here can grant, bypass, or override the OS/browser's own
// notification permission.
const DISMISS_KEY = "zx_push_banner_dismissed";

export default function PushNotificationManager() {
  const navigate = useNavigate();
  const [available, setAvailable] = useState(false);
  const [permission, setPermission] = useState(typeof Notification !== "undefined" ? Notification.permission : "default");
  const [showBanner, setShowBanner] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [leadToast, setLeadToast] = useState(null);
  const registeredTokenRef = useRef(null);

  const registerToken = (token) => {
    if (!token || registeredTokenRef.current === token) return;
    registeredTokenRef.current = token;

    axios.post(`${API_BASE_URL}/fcm/register-token`, { token }).catch((err) => {
      console.error("FCM token registration failed:", err);
      registeredTokenRef.current = null;
    });
  };

  const enablePush = async () => {
    setRequesting(true);
    try {
      const token = await requestPushPermissionAndToken();
      setPermission(typeof Notification !== "undefined" ? Notification.permission : "denied");

      if (token) {
        registerToken(token);
        setShowBanner(false);
      }
    } finally {
      setRequesting(false);
    }
  };

  const dismissBanner = () => {
    setShowBanner(false);
    try {
      sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Storage unavailable — the banner just shows again next load,
      // which is harmless.
    }
  };

  // Initial check: is push even usable here, and — only if permission
  // was already granted in a previous visit — silently (re)issue a
  // token, since a token can rotate/expire and the backend's upsert
  // makes re-registering the same one a no-op either way.
  useEffect(() => {
    let cancelled = false;

    isPushAvailable().then((ok) => {
      if (cancelled || !ok) return;
      setAvailable(true);

      const currentPermission = Notification.permission;
      setPermission(currentPermission);

      if (currentPermission === "granted") {
        requestPushPermissionAndToken().then((token) => registerToken(token));
      } else if (currentPermission === "default") {
        let dismissed = false;
        try {
          dismissed = sessionStorage.getItem(DISMISS_KEY) === "1";
        } catch {
          // Fail open — banner shows.
        }
        if (!dismissed) setShowBanner(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  // Foreground messages (this tab open + focused) — background/closed
  // delivery is handled entirely by public/firebase-messaging-sw.js.
  useEffect(() => {
    if (!isFirebaseConfigured) return;

    const unsubscribe = onForegroundLeadNotification((payload) => {
      setLeadToast({
        title: payload.notification?.title || "New Lead Received",
        body: payload.notification?.body || "",
      });
    });

    return unsubscribe;
  }, []);

  // The service worker's notificationclick handler focuses an existing
  // tab and posts this message rather than navigating it directly — a
  // service worker has no access to this app's React Router, so the
  // actual in-app navigation happens here instead.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    const onMessage = (event) => {
      if (event.data?.type === "new-lead-notification-click") {
        navigate("/super-admin/leads");
      }
    };

    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [navigate]);

  useEffect(() => {
    if (!leadToast) return;
    const timer = setTimeout(() => setLeadToast(null), 8000);
    return () => clearTimeout(timer);
  }, [leadToast]);

  return (
    <>
      {showBanner && available && (
        <div className="fixed inset-x-4 bottom-6 z-[70] flex items-center gap-3 rounded-lg admin-panel-strong px-4 py-3 shadow-2xl sm:inset-x-auto sm:right-6 sm:max-w-sm">
          <Bell size={18} className="shrink-0 text-admin-accent" />
          <p className="min-w-0 flex-1 text-sm text-ink-100">
            Get notified instantly when a new lead comes in — even when this app is closed.
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={enablePush}
              disabled={requesting}
              className="rounded-md bg-admin-accent px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
            >
              {requesting ? "…" : "Enable"}
            </button>
            <button
              type="button"
              onClick={dismissBanner}
              aria-label="Dismiss"
              className="rounded-md p-1.5 text-ink-500 hover:bg-white/5 hover:text-white"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      {/* Permission was explicitly blocked at the browser/OS level — this
          code has no way to override that, so it only ever explains how
          to change it, never claims it can work around it. Shown once,
          low-key, only on a fresh page where the banner above would
          otherwise have appeared. */}
      {available && permission === "denied" && !showBanner && (
        <div className="fixed inset-x-4 bottom-6 z-[70] flex items-start gap-2.5 rounded-lg admin-panel px-3.5 py-2.5 text-xs text-ink-400 shadow-lg sm:inset-x-auto sm:right-6 sm:max-w-xs">
          <BellOff size={14} className="mt-0.5 shrink-0" />
          <span>
            New-lead notifications are blocked for this site. Enable them from your browser&rsquo;s site
            settings (the lock/info icon in the address bar &gt; Notifications) to turn them back on.
          </span>
        </div>
      )}

      {leadToast && (
        <button
          type="button"
          onClick={() => {
            setLeadToast(null);
            navigate("/super-admin/leads");
          }}
          className="fixed inset-x-4 bottom-6 z-[70] flex items-center gap-3 rounded-lg admin-panel-strong px-4 py-3 text-left shadow-2xl transition-transform hover:scale-[1.01] sm:inset-x-auto sm:right-6 sm:max-w-sm"
        >
          <Bell size={18} className="shrink-0 text-admin-accent" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-white">{leadToast.title}</p>
            {leadToast.body && <p className="mt-0.5 truncate text-xs text-ink-400">{leadToast.body}</p>}
          </div>
        </button>
      )}
    </>
  );
}
