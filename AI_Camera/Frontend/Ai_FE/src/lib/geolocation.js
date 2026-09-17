// Real GPS location for Leads (Landing page popup + Contact section form
// — see pages/Landing.jsx). Uses the standard browser Geolocation API
// only — never any bypass or silent-permission trick; the browser/OS
// always shows its own native permission prompt, entirely outside this
// code's control.
//
// getBrowserLocation() NEVER rejects and NEVER throws — every failure
// path (permission denied, GPS unavailable, timeout, any other error,
// or the API not existing at all) resolves to { latitude: null,
// longitude: null } instead, so a caller can always safely do
// `const coords = await getBrowserLocation()` and merge the result
// straight into a lead submission with no try/catch needed. This is
// deliberate: a Lead submission must never be blocked, delayed
// indefinitely, or rejected because of location permission.
const DEFAULT_TIMEOUT_MS = 8000;

const NULL_COORDS = { latitude: null, longitude: null };

export function getBrowserLocation(timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      resolve(NULL_COORDS);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
      },
      () => {
        // Any GeolocationPositionError (PERMISSION_DENIED,
        // POSITION_UNAVAILABLE, TIMEOUT) lands here — all three are
        // handled identically: submit the lead anyway, coordinates null.
        resolve(NULL_COORDS);
      },
      { timeout: timeoutMs, maximumAge: 0 }
    );
  });
}
