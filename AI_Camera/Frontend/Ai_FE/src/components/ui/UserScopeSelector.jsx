import { Users } from "lucide-react";
import { useSelectedUser } from "../../context/SelectedUserContext";
import UserSelect from "./UserSelect";

// Per-User Data Isolation: the Company Admin's "view as" filter, shared
// by every data page (Dashboard, Live Camera, Registered/Unknown
// Persons, Attendance, Analytics, Reports). Renders nothing for a User
// session (they have no filter of their own — always their own data,
// enforced server-side) or while there are no Users yet to filter by.
//
// Renders via the shared UserSelect primitive (same styling/behavior as
// the "Assign to User" fields in Camera Management / Registered
// Persons) — "Unassigned" is intentionally not offered here: it's a
// real ownership VALUE those assignment fields can set, not a
// meaningful "view" of aggregated data the way "All Users" is.
export default function UserScopeSelector({ className = "" }) {
  const { selectedUserId, setSelectedUserId, users, isCompanyAdmin } = useSelectedUser();

  if (!isCompanyAdmin) return null;

  const value = selectedUserId === null || selectedUserId === "unassigned" ? "" : String(selectedUserId);

  const handleChange = (e) => {
    const raw = e.target.value;
    setSelectedUserId(raw === "" ? null : Number(raw));
  };

  return (
    <UserSelect
      users={users}
      value={value}
      onChange={handleChange}
      emptyOptionLabel="All Users"
      icon={Users}
      className={className}
      title="View data for a specific User"
    />
  );
}
