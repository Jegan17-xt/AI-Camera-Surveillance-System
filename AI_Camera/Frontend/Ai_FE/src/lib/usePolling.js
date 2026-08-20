import { useEffect, useRef } from "react";

// Bounded-interval refresh for data the event bus (dataEvents.js) can't
// reach — anything written by a DIFFERENT browser tab/session or by a
// backend background thread (the face-recognition pipeline marking
// attendance / logging an unknown person), neither of which can dispatch
// into this tab's in-memory EventTarget. Pauses while the tab is hidden
// (Page Visibility API) so a backgrounded dashboard tab makes zero
// requests, and fires once immediately when the tab becomes visible
// again so it doesn't sit stale until the next tick.
export function usePolling(callback, intervalMs, { enabled = true } = {}) {
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  });

  useEffect(() => {
    if (!enabled) return;

    const tick = () => {
      if (!document.hidden) callbackRef.current?.();
    };

    const interval = setInterval(tick, intervalMs);

    const handleVisibilityChange = () => {
      if (!document.hidden) callbackRef.current?.();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [intervalMs, enabled]);
}
