// Firebase Cloud Messaging background handler — Super Admin "New Lead"
// push notifications ONLY. A completely separate registration from
// sw.js (the app-shell/PWA-caching worker every visitor gets): this
// file is registered at its own dedicated scope
// ("/firebase-cloud-messaging-push-scope", see src/lib/firebase.js),
// specifically so it never competes with or replaces sw.js's own
// root-scoped ("/") registration — the two coexist independently.
//
// This is a classic (non-module) service worker, so it can't read
// import.meta.env the way the rest of the app does — src/lib/firebase.js
// passes the Firebase web config (none of it secret — see
// .env.development's comment) as query params on the registration URL,
// read back below via self.location.search. If those params are ever
// missing (registered with no config, or a stale cached copy from
// before this existed), this worker simply does nothing — it never
// throws, and never affects sw.js's own caching/offline behavior.
importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js");

const params = new URLSearchParams(self.location.search);
const firebaseConfig = {
  apiKey: params.get("apiKey"),
  authDomain: params.get("authDomain"),
  projectId: params.get("projectId"),
  storageBucket: params.get("storageBucket"),
  messagingSenderId: params.get("messagingSenderId"),
  appId: params.get("appId"),
};

if (firebaseConfig.apiKey && firebaseConfig.projectId) {
  firebase.initializeApp(firebaseConfig);
  const messaging = firebase.messaging();

  // Fires for a push that arrives while no tab has this app focused
  // (backgrounded or fully closed — this service worker's whole reason
  // to exist). Foreground delivery (a tab open and focused) is handled
  // separately, in-page, by onMessage in src/lib/firebase.js — Firebase
  // deliberately routes a message to exactly one of these two paths,
  // never both, so a lead never produces a duplicate notification.
  messaging.onBackgroundMessage((payload) => {
    const title = payload.notification?.title || "New Lead Received";
    const body = payload.notification?.body || "";

    self.registration.showNotification(title, {
      body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: payload.data || {},
      tag: "new-lead", // a second lead's notification replaces the first rather than stacking silently unread
    });
  });
}

// Clicking the notification (foreground OR background push, both use
// this same showNotification/click path) opens the Super Admin Leads
// page — reusing an already-open tab on this app instead of piling up
// new ones, same as clicking a normal browser notification would.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const path = event.notification.data?.click_action || "/super-admin/leads";
  const targetUrl = new URL(path, self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.startsWith(self.location.origin) && "focus" in client) {
          client.postMessage({ type: "new-lead-notification-click", url: targetUrl });
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});
