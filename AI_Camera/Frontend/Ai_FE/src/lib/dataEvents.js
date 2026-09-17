import { useEffect, useRef } from "react";

// App-wide "this data changed, go refetch" signal bus — a single
// in-memory EventTarget shared by both portals (Super Admin and
// Customer). It exists so a mutation in ONE component (e.g. the Super
// Admin adding a camera) can tell every OTHER already-mounted
// component that displays the same kind of data (a Dashboard stat
// card, the Sidebar's camera count, a different page entirely) to
// refetch itself — without polling, without a full page reload, and
// without every producer/consumer pair needing to know about each
// other directly.
//
// Deliberately NOT React Context: these are global, portal-wide
// signals with no per-subtree scoping need, so a plain module-level
// singleton avoids requiring every consumer to sit under a Provider
// (and avoids two separate providers for two portals that are never
// mounted at the same time).
const bus = new EventTarget();

export const DATA_EVENTS = {
  CUSTOMERS_CHANGED: "customers:changed",
  CAMERAS_CHANGED: "cameras:changed",
  AI_CONFIG_CHANGED: "ai-config:changed",
  BRANDING_CHANGED: "branding:changed",
  REGISTERED_PERSONS_CHANGED: "registered-persons:changed",
  UNKNOWN_PERSONS_CHANGED: "unknown-persons:changed",
  // Multi-Object & Fire Detection — fired by pages/DetectionEvents.jsx
  // after a delete/bulk-delete/clear so the Dashboard cards + feed
  // refresh without waiting for their next poll.
  DETECTION_EVENTS_CHANGED: "detection-events:changed",
  ATTENDANCE_CHANGED: "attendance:changed",
  REPORTS_CHANGED: "reports:changed",
  SETTINGS_CHANGED: "settings:changed",
  ACTIVITY_LOGS_CHANGED: "activity-logs:changed",
  PROFILE_CHANGED: "profile:changed",
  // Per-User Data Isolation: fired by pages/UserManagement.jsx after a
  // Company Admin (or a User granted "user_management") creates/edits/
  // deletes/disables one of their company's Users, so
  // context/SelectedUserContext.jsx can refresh its list and clear a
  // selection that no longer exists.
  COMPANY_USERS_CHANGED: "company-users:changed",
  // Fired by pages/Notifications.jsx after mark-read/mark-all-read/
  // delete, so the Navbar bell's unread count refreshes instantly
  // instead of waiting for its next poll cycle.
  NOTIFICATIONS_CHANGED: "notifications:changed",
};

// Call after a create/update/delete succeeds — never on a timer.
export function emitDataEvent(name, detail) {
  bus.dispatchEvent(new CustomEvent(name, { detail }));
}

// React hook: re-runs `callback` whenever any of `eventNames` fires.
// `callback` is always called with its latest closure (via a ref) so
// callers never need to memoize it themselves, and the subscription
// itself is only ever (re)established when the event name(s) change.
export function useDataEvent(eventNames, callback) {
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  });

  const names = Array.isArray(eventNames) ? eventNames : [eventNames];
  const key = names.join(",");

  useEffect(() => {
    const listener = (e) => callbackRef.current?.(e.detail);

    names.forEach((name) => bus.addEventListener(name, listener));

    return () => {
      names.forEach((name) => bus.removeEventListener(name, listener));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}