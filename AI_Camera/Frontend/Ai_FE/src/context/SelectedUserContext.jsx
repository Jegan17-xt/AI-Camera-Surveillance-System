import { createContext, useContext, useEffect, useMemo, useState } from "react";
import axios from "axios";
import { useAuth } from "./AuthContext";
import { DATA_EVENTS, useDataEvent } from "../lib/dataEvents";
import { API_BASE_URL } from "../lib/apiBase";

const SelectedUserContext = createContext(null);

const STORAGE_KEY = "selected_user_id";
const COMPANY_USERS_URL = `${API_BASE_URL}/company/users`;

// Per-User Data Isolation: the Company Admin's "view as" filter — which
// User's data-scoped pages (Dashboard, Live Camera, Registered/Unknown
// Persons, Attendance, Analytics, Reports) should show. `null` = "All
// Users" (today's exact pooled aggregate, the default). `"unassigned"` =
// only cameras/records nobody's been assigned to yet. A number = one
// specific User's own data.
//
// Deliberately a SEPARATE context from AuthContext — this is a view
// filter, not identity; keeping it apart means switching the selection
// never re-renders every useAuth() consumer, and a User's own login
// (which has no selector at all) can still safely call this hook without
// AuthContext needing to know anything about it.
export function SelectedUserProvider({ children }) {
  const { user } = useAuth();
  const isCompanyAdmin = user?.role === "Company Admin";
  // A User granted "user_management" can also reach /company/users (see
  // Backend/api/company_users.py + routes.py's company_or_user_required),
  // so this same list can populate the owner-assignment dropdowns on
  // pages like Camera Management/Normal Camera for them too. Doesn't
  // affect `isCompanyAdmin` itself, which consumers (e.g. the "view as"
  // selector) still use to decide whether to show that Company-Admin-only
  // aggregate filter — a User never gets that UI, only this list.
  const isUser = user?.role === "User";

  const [selectedUserId, setSelectedUserIdState] = useState(() => {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored === "unassigned") return "unassigned";
    const parsed = Number(stored);
    return stored && Number.isInteger(parsed) ? parsed : null;
  });

  const [users, setUsers] = useState([]);
  const [usersLoading, setUsersLoading] = useState(false);

  const fetchUsers = () => {
    if (!isCompanyAdmin && !isUser) {
      setUsers([]);
      return;
    }
    setUsersLoading(true);
    axios
      .get(COMPANY_USERS_URL)
      .then((res) => setUsers(res.data.users || []))
      .catch((err) => {
        console.error("Company Users API Error :", err);
        setUsers([]);
      })
      .finally(() => setUsersLoading(false));
  };

  useEffect(fetchUsers, [isCompanyAdmin, isUser]);

  // A User (or role we don't have a selector for) just got created,
  // edited, disabled, or deleted elsewhere (UserManagement.jsx) — refresh
  // the list, and if the currently-selected User no longer exists, fall
  // back to "All Users" rather than silently filtering on a stale id.
  useDataEvent(DATA_EVENTS.COMPANY_USERS_CHANGED, () => {
    axios
      .get(COMPANY_USERS_URL)
      .then((res) => {
        const fresh = res.data.users || [];
        setUsers(fresh);
        setSelectedUserIdState((current) => {
          if (current === null || current === "unassigned") return current;
          return fresh.some((u) => u.id === current) ? current : null;
        });
      })
      .catch(() => {});
  });

  const setSelectedUserId = (value) => {
    setSelectedUserIdState(value);
    if (value === null) {
      sessionStorage.removeItem(STORAGE_KEY);
    } else {
      sessionStorage.setItem(STORAGE_KEY, String(value));
    }
  };

  const value = useMemo(
    () => ({ selectedUserId, setSelectedUserId, users, usersLoading, isCompanyAdmin }),
    [selectedUserId, users, usersLoading, isCompanyAdmin]
  );

  return <SelectedUserContext.Provider value={value}>{children}</SelectedUserContext.Provider>;
}

export function useSelectedUser() {
  const ctx = useContext(SelectedUserContext);
  if (!ctx) {
    throw new Error("useSelectedUser must be used within a SelectedUserProvider");
  }
  return ctx;
}
