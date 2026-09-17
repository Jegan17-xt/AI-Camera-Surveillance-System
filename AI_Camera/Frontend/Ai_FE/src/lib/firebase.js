// Firebase Cloud Messaging (web push) — Super Admin "New Lead"
// notifications only (super-admin/components/PushNotificationManager.jsx).
// Nothing else in this app touches Firebase. Every export here degrades
// gracefully (returns null / a no-op) when VITE_FIREBASE_* isn't
// configured — see .env.development's comment — so the rest of the app
// is never affected by push notifications being unset up.
import { initializeApp, getApps } from "firebase/app";
import { getMessaging, getToken, onMessage, isSupported } from "firebase/messaging";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const VAPID_KEY = import.meta.env.VITE_FIREBASE_VAPID_KEY;

export const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.messagingSenderId && firebaseConfig.appId && VAPID_KEY
);

let app = null;

function getFirebaseApp() {
  if (!isFirebaseConfigured) return null;
  if (!app) {
    app = getApps()[0] || initializeApp(firebaseConfig);
  }
  return app;
}

// public/firebase-messaging-sw.js, registered at its OWN scope so it
// never conflicts with (or replaces) main.jsx's separate app-shell `/`
// registration of sw.js — the two coexist independently. This is a
// classic (non-module) worker with no build-time env access, so the
// Firebase web config (none of it secret, see .env.development) rides
// along as query params on the registration URL and is read back via
// self.location.search inside that file.
const FCM_SW_URL =
  "/firebase-messaging-sw.js?" +
  new URLSearchParams({
    apiKey: firebaseConfig.apiKey || "",
    authDomain: firebaseConfig.authDomain || "",
    projectId: firebaseConfig.projectId || "",
    storageBucket: firebaseConfig.storageBucket || "",
    messagingSenderId: firebaseConfig.messagingSenderId || "",
    appId: firebaseConfig.appId || "",
  }).toString();
const FCM_SW_SCOPE = "/firebase-cloud-messaging-push-scope";

async function getSwRegistration() {
  if (!("serviceWorker" in navigator)) return null;
  return navigator.serviceWorker.register(FCM_SW_URL, { scope: FCM_SW_SCOPE });
}

// True only once every precondition FCM actually needs is confirmed —
// browser support (isSupported(), which itself checks for
// serviceWorker/PushManager/Notification), a configured Firebase
// project, and a secure context (FCM requires HTTPS; localhost is
// exempted by browsers same as any other PWA feature).
export async function isPushAvailable() {
  if (!isFirebaseConfigured) return false;
  if (!("Notification" in window) || !("serviceWorker" in navigator)) return false;
  try {
    return await isSupported();
  } catch {
    return false;
  }
}

// Requests browser notification permission (a real, one-time OS/browser
// prompt — this code cannot bypass or auto-grant it) and, only if
// granted, returns a fresh FCM device token. Returns null on any
// unsupported/unconfigured/denied/error path — callers must treat null
// as "push isn't available right now" and degrade quietly, never as an
// error to surface loudly.
export async function requestPushPermissionAndToken() {
  const available = await isPushAvailable();
  if (!available) return null;

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return null;

  const firebaseApp = getFirebaseApp();
  if (!firebaseApp) return null;

  const registration = await getSwRegistration();
  if (!registration) return null;

  try {
    const messaging = getMessaging(firebaseApp);
    return await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: registration });
  } catch (err) {
    console.error("FCM getToken failed:", err);
    return null;
  }
}

// Foreground-only — a message that arrives while this tab is open and
// focused. Background/closed delivery is handled entirely by the service
// worker (public/sw.js's onBackgroundMessage), never by this function.
// Returns an unsubscribe function, or a no-op if push isn't configured.
export function onForegroundLeadNotification(callback) {
  const firebaseApp = getFirebaseApp();
  if (!firebaseApp) return () => {};

  const messaging = getMessaging(firebaseApp);
  return onMessage(messaging, callback);
}
