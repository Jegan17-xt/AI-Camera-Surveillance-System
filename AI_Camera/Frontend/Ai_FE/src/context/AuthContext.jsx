import { createContext, useContext, useEffect, useMemo, useReducer, useRef } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import { authLog } from "../debugLog";

const AuthContext = createContext(null);

// Single authoritative shape for auth state. `status` and `user` always
// change together, in one dispatch — there is no way for them to drift
// out of sync with each other, unlike two independent useState calls.
const initialState = { status: "loading", user: null }; // loading | authenticated | unauthenticated

function authReducer(state, action) {
  authLog(`REDUCER: ${state.status} --[${action.type}]--> ?`, action.user ? `(user: ${action.user.email})` : "");
  switch (action.type) {
    case "AUTHENTICATED":
      // --- Re-render fix: bail out on a no-op AUTHENTICATED dispatch ---
      // Sidebar polls GET /me every 15s (module-sync — see Sidebar.jsx)
      // purely to catch a Super Admin/Company Admin grant change from a
      // DIFFERENT browser session, and dispatches AUTHENTICATED with
      // whatever it gets back every single time, whether or not
      // anything actually changed. Returning a BRAND NEW state object
      // unconditionally (the old behavior) gave `value` below a new
      // reference on every one of those ticks even when the user data
      // was byte-for-byte identical — and since AuthContext.Provider
      // wraps the whole app, that re-created `value` re-rendered every
      // consumer of useAuth() (~20 files) every 15 seconds, for every
      // logged-in tab. Returning the SAME `state` reference when nothing
      // meaningfully changed lets useMemo below correctly skip
      // recomputing `value`, so nothing downstream re-renders for a
      // poll that found no change. A real login, logout, or actual
      // permission-grant change still updates state exactly as before.
      if (state.status === "authenticated" && sameUser(state.user, action.user)) {
        return state;
      }
      return { status: "authenticated", user: action.user };
    case "UNAUTHENTICATED":
      return { status: "unauthenticated", user: null };
    case "REVALIDATING":
      return { status: "loading", user: null };
    default:
      return state;
  }
}

function sameUser(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  // Both are plain, JSON-serializable objects straight off /login, /me,
  // or updateUser() (see auth.serialize_user on the backend) — same
  // fields, same key order every time, so a JSON comparison is a safe,
  // cheap stand-in for a real deep-equal here.
  return JSON.stringify(a) === JSON.stringify(b);
}

export function AuthProvider({ children }) {
  const [state, dispatch] = useReducer(authReducer, initialState);
  const navigate = useNavigate();

  authLog(`RENDER: status=${state.status} user=${state.user?.email ?? "null"}`);

  // Mirrors of `state`/`navigate` for code that must read the CURRENT
  // value synchronously (the response interceptor) without waiting for
  // an effect to re-run after a render commits. Written directly during
  // render, so they are never stale by even one tick — this is not a
  // second source of truth, it is the same value made readable outside
  // React's render cycle, and it can never diverge because it is
  // overwritten from `state` on every single render.
  const stateRef = useRef(state);
  stateRef.current = state;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  const hasCheckedSession = useRef(false);

  const verifySession = (logPrefix) => {
    authLog(`${logPrefix}: firing GET /me`);
    axios
      .get("http://localhost:5000/me")
      .then((res) => {
        authLog(`${logPrefix}: resolved 200`, res.data.user?.email);
        dispatch({ type: "AUTHENTICATED", user: res.data.user });
      })
      .catch((err) => {
        authLog(`${logPrefix}: rejected`, err.response?.status, err.response?.data);
        dispatch({ type: "UNAUTHENTICATED" });
      });
  };

  // Initial app load: verify whether a session cookie from a previous
  // visit is still valid. Guaranteed to run at most once per provider
  // lifetime — the ref guard also protects against StrictMode's dev-only
  // double-invocation of effects, which would otherwise fire this GET
  // twice on every load.
  useEffect(() => {
    if (hasCheckedSession.current) {
      authLog("INITIAL /me CHECK: skipped (already ran once — StrictMode double-invoke guard)");
      return;
    }
    hasCheckedSession.current = true;

    verifySession("INITIAL /me CHECK");
  }, []);

  // Defense-in-depth against the back-forward cache. A `pageshow` with
  // `event.persisted === true` means the browser just repainted a frozen
  // snapshot of this page (DOM, committed React state, everything) from
  // bfcache instead of re-running the app — no effect above reruns for
  // that, so without this listener a Dashboard visited before logout can
  // reappear verbatim on Back, still showing stale data, even though
  // `state.status` in that frozen snapshot says "authenticated". The
  // backend/server `no-store` headers are the primary fix (they should
  // stop the page from ever entering bfcache), but this catches any
  // browser/proxy that restores it anyway: drop straight back to the
  // "loading" spinner and re-verify against the server before anything
  // protected is allowed to stay on screen.
  useEffect(() => {
    const handlePageShow = (event) => {
      if (!event.persisted) return;
      authLog("PAGESHOW: page restored from bfcache -> forcing re-verification");
      dispatch({ type: "REVALIDATING" });
      verifySession("PAGESHOW /me CHECK");
    };

    window.addEventListener("pageshow", handlePageShow);
    return () => window.removeEventListener("pageshow", handlePageShow);
  }, []);

  // Registered exactly once, for the entire lifetime of the provider —
  // empty dependency array, nothing to re-run it. It reads stateRef /
  // navigateRef at the moment each response actually resolves, so it is
  // always acting on the true current value, never a stale snapshot. It
  // only reacts once we've settled into a known authenticated session —
  // never during the initial "loading" check, and never for a login
  // attempt that simply had bad credentials.
  useEffect(() => {
    authLog("INTERCEPTOR: registering (should log this exactly once)");

    const interceptor = axios.interceptors.response.use(
      (res) => {
        authLog(`INTERCEPTOR: response OK ${res.config.method?.toUpperCase()} ${res.config.url} -> ${res.status}`);
        return res;
      },
      (err) => {
        authLog(
          `INTERCEPTOR: response ERROR ${err.config?.method?.toUpperCase()} ${err.config?.url} -> ${err.response?.status}`,
          `| statusRef.current=${stateRef.current.status}`
        );

        if (stateRef.current.status === "authenticated") {
          if (err.response?.status === 401) {
            authLog("INTERCEPTOR: was authenticated, got 401 -> dispatch UNAUTHENTICATED");
            dispatch({ type: "UNAUTHENTICATED" });
          } else if (err.response?.status === 403 && !err.config?.suppressAuthRedirect) {
            // Runs outside React render, so it can't use useLocation —
            // reads the browser's current path directly instead. Only
            // the Company Admin (/admin/*) and User (/user/*) portals
            // have a module-permission 403 page; Super Admin has blanket
            // access and shouldn't normally hit this branch at all.
            //
            // `suppressAuthRedirect` (set in the request config, e.g.
            // Attendance.jsx's fetchRegisteredTotal — a page CAN legitimately
            // fetch a bit of data from a module it doesn't itself hold, as a
            // secondary/optional enrichment) opts a specific request out of
            // this: a 403 from a supplementary fetch must not evict the user
            // from a page they otherwise have every right to be on. Without
            // this, ANY secondary call failing with 403 anywhere in the app
            // force-navigates away from a page that was rendering correctly.
            const path = window.location.pathname;
            const base = path.startsWith("/admin") ? "/admin" : path.startsWith("/user") ? "/user" : null;
            if (base) {
              authLog(`INTERCEPTOR: was authenticated, got 403 -> navigate ${base}/403`);
              navigateRef.current(`${base}/403`, { replace: true });
            }
          }
        } else {
          authLog(`INTERCEPTOR: statusRef.current is "${stateRef.current.status}", not "authenticated" -> ignoring error`);
        }

        return Promise.reject(err);
      }
    );

    return () => {
      authLog("INTERCEPTOR: ejecting (provider unmounting or effect re-running — should not happen)");
      axios.interceptors.response.eject(interceptor);
    };
  }, []);

  const login = async (email, password, remember) => {
    authLog(`LOGIN: called with email=${email}`);
    try {
      const res = await axios.post("http://localhost:5000/login", { email, password, remember });
      authLog("LOGIN: POST /login resolved 200, dispatching AUTHENTICATED", res.data.user?.email);
      dispatch({ type: "AUTHENTICATED", user: res.data.user });
      authLog("LOGIN: dispatch call has returned (state update is now scheduled)");
      return { success: true, user: res.data.user };
    } catch (err) {
      authLog("LOGIN: POST /login rejected", err.response?.status, err.response?.data?.message);
      return {
        success: false,
        message: err.response?.data?.message || "Unable to sign in. Please try again.",
      };
    }
  };

  // Lets a component (e.g. after a profile-photo change) push a fresh
  // user object straight into auth state — the same shape /login and
  // the initial /me check already use — so the Navbar avatar updates
  // immediately instead of waiting for the next full page load.
  const updateUser = (user) => {
    authLog("UPDATE_USER: called", user?.email);
    dispatch({ type: "AUTHENTICATED", user });
  };

  const logout = async () => {
    authLog("LOGOUT: called");
    try {
      await axios.post("http://localhost:5000/logout");
      authLog("LOGOUT: POST /logout resolved 200");
    } catch (err) {
      authLog("LOGOUT: POST /logout rejected", err.response?.status);
      console.error("Logout API Error :", err);
    } finally {
      authLog("LOGOUT: dispatching UNAUTHENTICATED");
      dispatch({ type: "UNAUTHENTICATED" });
    }
  };

  const value = useMemo(
    () => ({
      user: state.user,
      status: state.status,
      isAuthenticated: state.status === "authenticated",
      isLoading: state.status === "loading",
      login,
      logout,
      updateUser,
    }),
    [state]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
