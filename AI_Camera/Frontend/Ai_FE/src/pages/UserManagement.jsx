import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { UserPlus, Pencil, Trash2, KeyRound, ShieldCheck, Loader2, AlertTriangle, Users, Gauge } from "lucide-react";
import PageHeader from "../components/ui/PageHeader";
import SearchInput from "../components/ui/SearchInput";
import Button from "../components/ui/Button";
import GlassCard from "../components/ui/GlassCard";
import StatusBadge from "../components/ui/StatusBadge";
import Modal from "../components/ui/Modal";
import Toast from "../components/ui/Toast";
import { DATA_EVENTS, emitDataEvent } from "../lib/dataEvents";
import { API_BASE_URL } from "../lib/apiBase";
import {
  validateTextField,
  validateEmail,
  validatePhone,
  validatePassword,
  hasNoErrors,
  INVALID_INPUT_CLASS,
} from "../lib/validation";

// Every module a Company Admin may grant one of their Users — mirrors
// Backend/api/company_users.py's GRANTABLE_USER_MODULE_KEYS exactly; one
// checkbox per User-accessible page. subscription_payment and
// user_management are the two system modules deliberately absent —
// Company Admin's own billing, and Company-Admin-only management of this
// company's OTHER Users, neither ever grantable to a User (see
// GRANTABLE_USER_MODULE_KEYS's comment for why, and the server-side
// strip that backs both up even against a tampered request).
const GRANTABLE_MODULE_LABELS = {
  dashboard: "Dashboard",
  live_camera: "Live Camera",
  camera_management: "Camera Management",
  normal_camera: "Normal Camera",
  registered_persons: "Registered Persons",
  unknown_persons: "Unknown Persons",
  unknown_person_analytics: "Unknown Person Analytics",
  attendance: "Attendance",
  reports: "Reports",
  settings: "Settings",
};

const inputClass =
  "w-full rounded-xl glass px-3.5 py-2.5 text-sm text-ink-100 placeholder:text-ink-500 outline-none focus:border-accent-cyan/50 focus:ring-2 focus:ring-accent-cyan/20";

function FieldError({ error }) {
  if (!error) return null;
  return <p className="mt-1.5 text-xs text-red-400">{error}</p>;
}

// A company's own "Manage Users" — self-service equivalent of the Super
// Admin's Company Management page, scoped entirely to this company's own
// Users via /company/users* (Backend/api/company_users.py enforces the
// ownership check server-side; this page never sends another company's
// user id anywhere on purpose, but couldn't reach one even if it tried).
// Company-Admin-only: "user_management" is deliberately absent from
// GRANTABLE_USER_MODULE_KEYS, so no User account can ever be granted
// access to this page or its /company/users* API, no matter what a
// tampered request asks for (see that constant's comment for why).
export default function UserManagement() {
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const fetchUsers = () => {
    setLoading(true);
    setError(null);

    return axios
      .get(`${API_BASE_URL}/company/users`)
      .then((res) => setUsers(res.data.users || []))
      .catch((err) => {
        console.error("Company Users API Error :", err);
        setError("Unable to load users. Please check the server and try again.");
      })
      .finally(() => setLoading(false));
  };

  // Camera Limit / Camera Quota Management — this company's own overall
  // rollup (Super-Admin-set camera_limit vs. real usage), plus how much
  // of it has been allocated across Users below. Same endpoint Camera
  // Management's own banner uses (Backend/api/routes.py's GET
  // /company/cameras/quota) — this page only ever loads for a Company
  // Admin (a User can never pass module_required("user_management")), so
  // `admin` is always what comes back.
  const [adminQuota, setAdminQuota] = useState(null);

  const fetchAdminQuota = () => {
    return axios
      .get(`${API_BASE_URL}/company/cameras/quota`)
      .then((res) => setAdminQuota(res.data.admin))
      .catch(() => setAdminQuota(null));
  };

  useEffect(() => {
    fetchUsers();
    fetchAdminQuota();
  }, []);

  const filtered = useMemo(
    () =>
      users.filter(
        (u) =>
          u.name.toLowerCase().includes(query.toLowerCase()) ||
          u.email.toLowerCase().includes(query.toLowerCase())
      ),
    [users, query]
  );

  // ---------------- Add / Edit ----------------

  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null); // null = Add, else Edit
  const [form, setForm] = useState({ name: "", email: "", username: "", phone_number: "", password: "" });
  const [formTouched, setFormTouched] = useState({});
  const [formSaving, setFormSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  const formErrors = {
    name: validateTextField(form.name, "Name", { minLen: 2, maxLen: 50 }),
    email: validateEmail(form.email),
    username: validateTextField(form.username, "Username", { minLen: 3, maxLen: 50 }),
    phone_number: validatePhone(form.phone_number),
    ...(editTarget ? {} : { password: validatePassword(form.password, { label: "Password", strong: true }) }),
  };
  const isFormValid = hasNoErrors(formErrors);

  const openAdd = () => {
    setEditTarget(null);
    setForm({ name: "", email: "", username: "", phone_number: "", password: "" });
    setFormTouched({});
    setFormError(null);
    setFormOpen(true);
  };

  const openEdit = (user) => {
    setEditTarget(user);
    setForm({ name: user.name, email: user.email, username: user.username, phone_number: user.phone_number || "", password: "" });
    setFormTouched({});
    setFormError(null);
    setFormOpen(true);
  };

  const closeForm = () => {
    if (formSaving) return;
    setFormOpen(false);
  };

  const handleSave = (e) => {
    e.preventDefault();
    setFormTouched({ name: true, email: true, username: true, phone_number: true, password: true });
    if (!isFormValid) return;
    setFormError(null);
    setFormSaving(true);

    const request = editTarget
      ? axios.put(`${API_BASE_URL}/company/users/${editTarget.id}`, {
          name: form.name.trim(),
          email: form.email.trim(),
          username: form.username.trim(),
          phone_number: form.phone_number.trim(),
        })
      : axios.post(`${API_BASE_URL}/company/users`, {
          name: form.name.trim(),
          email: form.email.trim(),
          username: form.username.trim(),
          phone_number: form.phone_number.trim(),
          password: form.password,
        });

    request
      .then(() => {
        setToast({ type: "success", message: editTarget ? "User updated successfully." : "User created successfully." });
        setFormOpen(false);
        emitDataEvent(DATA_EVENTS.COMPANY_USERS_CHANGED);
        return fetchUsers();
      })
      .catch((err) => {
        setFormError(err.response?.data?.message || "Failed to save user.");
      })
      .finally(() => setFormSaving(false));
  };

  // ---------------- Status toggle ----------------

  const [statusTargetId, setStatusTargetId] = useState(null);

  const handleToggleStatus = (user) => {
    setStatusTargetId(user.id);

    axios
      .put(`${API_BASE_URL}/company/users/${user.id}/status`, {
        status: user.status === "Active" ? "Inactive" : "Active",
      })
      .then(() => {
        setToast({ type: "success", message: `${user.name} ${user.status === "Active" ? "disabled" : "enabled"}.` });
        emitDataEvent(DATA_EVENTS.COMPANY_USERS_CHANGED);
        return fetchUsers();
      })
      .catch((err) => {
        setToast({ type: "error", message: err.response?.data?.message || "Failed to update status." });
      })
      .finally(() => setStatusTargetId(null));
  };

  // ---------------- Delete ----------------

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const handleConfirmDelete = () => {
    if (!deleteTarget) return;
    setDeleting(true);

    axios
      .delete(`${API_BASE_URL}/company/users/${deleteTarget.id}`)
      .then(() => {
        setToast({ type: "success", message: `${deleteTarget.name} deleted successfully.` });
        emitDataEvent(DATA_EVENTS.COMPANY_USERS_CHANGED);
        return fetchUsers();
      })
      .catch(() => {
        setToast({ type: "error", message: `Failed to delete ${deleteTarget.name}.` });
      })
      .finally(() => {
        setDeleting(false);
        setDeleteTarget(null);
      });
  };

  // ---------------- Reset Password ----------------

  const [resetTarget, setResetTarget] = useState(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetTouched, setResetTouched] = useState(false);
  const [resetSaving, setResetSaving] = useState(false);
  const [resetError, setResetError] = useState(null);

  const resetPasswordError = validatePassword(resetPassword, { label: "New Password", strong: true });

  const openReset = (user) => {
    setResetTarget(user);
    setResetPassword("");
    setResetTouched(false);
    setResetError(null);
  };

  const handleConfirmReset = (e) => {
    e.preventDefault();
    setResetTouched(true);
    if (resetPasswordError) return;
    setResetSaving(true);

    axios
      .put(`${API_BASE_URL}/company/users/${resetTarget.id}/reset-password`, { password: resetPassword })
      .then(() => {
        setToast({ type: "success", message: `Password reset for ${resetTarget.name}.` });
        setResetTarget(null);
      })
      .catch((err) => {
        setResetError(err.response?.data?.message || "Failed to reset password.");
      })
      .finally(() => setResetSaving(false));
  };

  // ---------------- Camera Limit ----------------

  const [cameraLimitTarget, setCameraLimitTarget] = useState(null);
  const [cameraLimitInput, setCameraLimitInput] = useState("");
  const [cameraLimitSaving, setCameraLimitSaving] = useState(false);
  const [cameraLimitError, setCameraLimitError] = useState(null);

  const openCameraLimit = (user) => {
    setCameraLimitTarget(user);
    setCameraLimitInput(user.camera_quota?.camera_limit ?? "");
    setCameraLimitError(null);
  };

  const handleSaveCameraLimit = (e) => {
    e.preventDefault();
    setCameraLimitError(null);
    setCameraLimitSaving(true);

    const camera_limit = cameraLimitInput === "" ? null : Number(cameraLimitInput);

    axios
      .put(`${API_BASE_URL}/company/users/${cameraLimitTarget.id}/camera-limit`, { camera_limit })
      .then(() => {
        setToast({ type: "success", message: `Camera limit updated for ${cameraLimitTarget.name}.` });
        setCameraLimitTarget(null);
        fetchAdminQuota();
        return fetchUsers();
      })
      .catch((err) => {
        setCameraLimitError(err.response?.data?.message || "Failed to update camera limit.");
      })
      .finally(() => setCameraLimitSaving(false));
  };

  // ---------------- Permissions ----------------

  const [permTarget, setPermTarget] = useState(null);
  const [permissions, setPermissions] = useState([]);
  const [permLoading, setPermLoading] = useState(false);
  const [permSaving, setPermSaving] = useState(false);

  const openPermissions = (user) => {
    setPermTarget(user);
    setPermLoading(true);

    axios
      .get(`${API_BASE_URL}/company/users/${user.id}/permissions`)
      .then((res) => setPermissions(res.data.permissions || []))
      .catch(() => setToast({ type: "error", message: "Failed to load permissions." }))
      .finally(() => setPermLoading(false));
  };

  const togglePermission = (moduleKey) => {
    setPermissions((prev) =>
      prev.map((p) => (p.module_key === moduleKey ? { ...p, granted: !p.granted } : p))
    );
  };

  const handleSavePermissions = () => {
    setPermSaving(true);

    const moduleKeys = permissions.filter((p) => p.granted).map((p) => p.module_key);

    axios
      .put(`${API_BASE_URL}/company/users/${permTarget.id}/permissions`, { module_keys: moduleKeys })
      .then(() => {
        setToast({ type: "success", message: `Permissions updated for ${permTarget.name}.` });
        setPermTarget(null);
      })
      .catch(() => setToast({ type: "error", message: "Failed to update permissions." }))
      .finally(() => setPermSaving(false));
  };

  return (
    <div>
      <PageHeader
        eyebrow="Accounts"
        title="User Management"
        description="Create and manage the team members who can sign in to this company's account."
        actions={
          <Button icon={UserPlus} onClick={openAdd}>
            Add User
          </Button>
        }
      />

      {/* Camera Limit / Camera Quota Management — this company's own
          overall rollup, set by the Super Admin (Super Admin -> Admin
          Camera Limit). Read-only here; a Company Admin distributes it
          across Users below, but can't change their own overall cap. */}
      {adminQuota && (
        <GlassCard className="mb-5 p-4 sm:p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <Gauge size={16} className={adminQuota.status === "Over Limit" ? "text-signal-red" : "text-accent-cyan"} />
              <p className="text-sm font-medium text-ink-100">Company Camera Quota</p>
              {adminQuota.status === "Over Limit" && (
                <span className="rounded-full border border-signal-red/30 bg-signal-red/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-signal-red">
                  Over Limit
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 font-mono text-xs text-ink-400">
              <span>
                Limit: <span className="text-ink-100">{adminQuota.camera_limit === null ? "Unlimited" : adminQuota.camera_limit}</span>
              </span>
              <span>
                Used: <span className="text-ink-100">{adminQuota.used}</span>
              </span>
              {adminQuota.camera_limit !== null && (
                <span>
                  Remaining: <span className="text-ink-100">{adminQuota.remaining}</span>
                </span>
              )}
              <span>
                Users: <span className="text-ink-100">{adminQuota.user_count}</span>
              </span>
              <span>
                Allocated to Users: <span className="text-ink-100">{adminQuota.allocated_to_users}</span>
              </span>
            </div>
          </div>

          {adminQuota.camera_limit !== null && (
            <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/5">
              <div
                className={`h-full rounded-full ${adminQuota.usage_percent >= 100 ? "bg-signal-red" : adminQuota.usage_percent >= 90 ? "bg-amber-400" : "bg-accent-cyan"}`}
                style={{ width: `${Math.min(100, adminQuota.usage_percent)}%` }}
              />
            </div>
          )}
        </GlassCard>
      )}

      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SearchInput value={query} onChange={setQuery} placeholder="Search by name or email…" className="max-w-sm" />
        <p className="font-mono text-xs text-ink-500">{loading ? "Loading…" : `${filtered.length} of ${users.length} users`}</p>
      </div>

      {loading && (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-ink-500">
          <Loader2 size={22} className="animate-spin" />
          <p className="text-xs">Loading users…</p>
        </div>
      )}

      {!loading && error && (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-center text-ink-500">
          <AlertTriangle size={22} className="text-red-400" />
          <p className="text-xs">{error}</p>
        </div>
      )}

      {!loading && !error && (
        <GlassCard className="p-4 sm:p-5">
          <div className="custom-scroll overflow-x-auto">
            <table className="w-full min-w-[680px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-accent-cyan/10 text-xs uppercase tracking-wide text-ink-500">
                  <th className="px-3 py-3 font-medium">Name</th>
                  <th className="px-3 py-3 font-medium">Email</th>
                  <th className="px-3 py-3 font-medium">Phone</th>
                  <th className="px-3 py-3 font-medium">Cameras</th>
                  <th className="px-3 py-3 font-medium">Status</th>
                  <th className="w-48 px-3 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((user) => {
                  const cq = user.camera_quota;
                  return (
                  <tr key={user.id} className="border-b border-white/5 transition hover:bg-white/[0.03]">
                    <td className="px-3 py-3 font-medium text-ink-100">{user.name}</td>
                    <td className="px-3 py-3 font-mono text-xs text-ink-400">{user.email}</td>
                    <td className="px-3 py-3 font-mono text-xs text-ink-400">{user.phone_number || "—"}</td>
                    <td className="px-3 py-3 font-mono text-xs">
                      {cq ? (
                        <span className={cq.status === "Over Limit" ? "text-signal-red" : "text-ink-400"}>
                          {cq.used}/{cq.camera_limit === null ? "∞" : cq.camera_limit}
                          {cq.camera_limit !== null && ` (${cq.usage_percent}%)`}
                          {cq.status === "Over Limit" && " · Over Limit"}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <button onClick={() => handleToggleStatus(user)} disabled={statusTargetId === user.id}>
                        <StatusBadge status={user.status} />
                      </button>
                    </td>
                    <td className="px-3 py-3 text-right">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => openCameraLimit(user)}
                          title="Camera Limit"
                          className="rounded-md p-2 text-ink-400 hover:bg-white/5 hover:text-accent-cyan"
                        >
                          <Gauge size={15} />
                        </button>
                        <button
                          type="button"
                          onClick={() => openPermissions(user)}
                          title="Permissions"
                          className="rounded-md p-2 text-ink-400 hover:bg-white/5 hover:text-accent-cyan"
                        >
                          <ShieldCheck size={15} />
                        </button>
                        <button
                          type="button"
                          onClick={() => openReset(user)}
                          title="Reset Password"
                          className="rounded-md p-2 text-ink-400 hover:bg-white/5 hover:text-accent-cyan"
                        >
                          <KeyRound size={15} />
                        </button>
                        <button
                          type="button"
                          onClick={() => openEdit(user)}
                          title="Edit"
                          className="rounded-md p-2 text-ink-400 hover:bg-white/5 hover:text-accent-cyan"
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(user)}
                          title="Delete"
                          className="rounded-md p-2 text-ink-400 hover:bg-signal-red/10 hover:text-signal-red"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                  );
                })}

                {users.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-16 text-center text-ink-500">
                      <div className="flex flex-col items-center gap-2">
                        <Users size={22} />
                        <p>No users have been added yet.</p>
                      </div>
                    </td>
                  </tr>
                )}

                {users.length > 0 && filtered.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-12 text-center text-ink-500">
                      No users match "{query}".
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </GlassCard>
      )}

      {/* Add / Edit */}
      <Modal open={formOpen} onClose={closeForm} title={editTarget ? "Edit User" : "Add User"}>
        <form className="space-y-4" onSubmit={handleSave}>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-400">Name</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              onBlur={() => setFormTouched((t) => ({ ...t, name: true }))}
              className={`${inputClass} ${formTouched.name && formErrors.name ? INVALID_INPUT_CLASS : ""}`}
            />
            {formTouched.name && <FieldError error={formErrors.name} />}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink-400">Email</label>
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                onBlur={() => setFormTouched((t) => ({ ...t, email: true }))}
                className={`${inputClass} ${formTouched.email && formErrors.email ? INVALID_INPUT_CLASS : ""}`}
              />
              {formTouched.email && <FieldError error={formErrors.email} />}
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink-400">Username</label>
              <input
                type="text"
                value={form.username}
                onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                onBlur={() => setFormTouched((t) => ({ ...t, username: true }))}
                className={`${inputClass} ${formTouched.username && formErrors.username ? INVALID_INPUT_CLASS : ""}`}
              />
              {formTouched.username && <FieldError error={formErrors.username} />}
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-400">Phone Number</label>
            <input
              type="text"
              value={form.phone_number}
              onChange={(e) => setForm((f) => ({ ...f, phone_number: e.target.value }))}
              onBlur={() => setFormTouched((t) => ({ ...t, phone_number: true }))}
              placeholder="10-digit number"
              className={`${inputClass} ${formTouched.phone_number && formErrors.phone_number ? INVALID_INPUT_CLASS : ""}`}
            />
            {formTouched.phone_number && <FieldError error={formErrors.phone_number} />}
          </div>

          {editTarget && (
            <p className="text-xs text-ink-500">
              Profile photo, Camera, AI, Recognition, and WhatsApp & Reports settings for this User are configured
              from the Settings page — select {editTarget.name} under "Managing Settings For" there.
            </p>
          )}

          {!editTarget && (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink-400">Password</label>
              <input
                type="password"
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                onBlur={() => setFormTouched((t) => ({ ...t, password: true }))}
                placeholder="At least 8 characters, mixed case, number & symbol"
                autoComplete="new-password"
                className={`${inputClass} ${formTouched.password && formErrors.password ? INVALID_INPUT_CLASS : ""}`}
              />
              {formTouched.password && <FieldError error={formErrors.password} />}
            </div>
          )}

          {formError && (
            <div className="flex items-start gap-2 rounded-xl border border-signal-red/30 bg-signal-red/10 px-3.5 py-2.5 text-xs text-signal-red">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{formError}</span>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="ghost" onClick={closeForm} disabled={formSaving}>
              Cancel
            </Button>
            <Button type="submit" disabled={formSaving || !isFormValid}>
              {formSaving ? "Saving…" : "Save User"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Reset Password */}
      <Modal open={!!resetTarget} onClose={() => (!resetSaving ? setResetTarget(null) : null)} title="Reset Password">
        <form className="space-y-4" onSubmit={handleConfirmReset}>
          <p className="text-sm text-ink-300">
            Set a new password for <span className="text-white">{resetTarget?.name}</span>.
          </p>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-400">New Password</label>
            <input
              type="password"
              value={resetPassword}
              onChange={(e) => setResetPassword(e.target.value)}
              onBlur={() => setResetTouched(true)}
              autoComplete="new-password"
              className={`${inputClass} ${resetTouched && resetPasswordError ? INVALID_INPUT_CLASS : ""}`}
            />
            {resetTouched && <FieldError error={resetPasswordError} />}
          </div>

          {resetError && (
            <div className="flex items-start gap-2 rounded-xl border border-signal-red/30 bg-signal-red/10 px-3.5 py-2.5 text-xs text-signal-red">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{resetError}</span>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="ghost" onClick={() => setResetTarget(null)} disabled={resetSaving}>
              Cancel
            </Button>
            <Button type="submit" disabled={resetSaving || !!resetPasswordError}>
              {resetSaving ? "Saving…" : "Reset Password"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Camera Limit / Camera Quota Management */}
      <Modal open={!!cameraLimitTarget} onClose={() => (!cameraLimitSaving ? setCameraLimitTarget(null) : null)} title="Camera Limit">
        <form className="space-y-4" onSubmit={handleSaveCameraLimit}>
          <p className="text-sm text-ink-300">
            Set how many cameras <span className="text-white">{cameraLimitTarget?.name}</span> may use. Leave blank for
            unlimited.
          </p>

          {cameraLimitTarget?.camera_quota && (
            <p className="font-mono text-xs text-ink-500">
              Currently using {cameraLimitTarget.camera_quota.used} camera
              {cameraLimitTarget.camera_quota.used === 1 ? "" : "s"}.
            </p>
          )}

          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-400">Camera Limit</label>
            <input
              type="number"
              min="0"
              step="1"
              value={cameraLimitInput}
              onChange={(e) => setCameraLimitInput(e.target.value)}
              placeholder="Unlimited"
              className={inputClass}
            />
          </div>

          {adminQuota && (
            <p className="font-mono text-xs text-ink-500">
              Company remaining capacity:{" "}
              {adminQuota.camera_limit === null ? "Unlimited" : adminQuota.remaining}
            </p>
          )}

          {cameraLimitError && (
            <div className="flex items-start gap-2 rounded-xl border border-signal-red/30 bg-signal-red/10 px-3.5 py-2.5 text-xs text-signal-red">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{cameraLimitError}</span>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="ghost" onClick={() => setCameraLimitTarget(null)} disabled={cameraLimitSaving}>
              Cancel
            </Button>
            <Button type="submit" disabled={cameraLimitSaving}>
              {cameraLimitSaving ? "Saving…" : "Save Camera Limit"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Permissions */}
      <Modal open={!!permTarget} onClose={() => setPermTarget(null)} title="User Permissions">
        {permLoading ? (
          <div className="flex items-center gap-2 py-6 text-ink-500">
            <Loader2 size={16} className="animate-spin" />
            <p className="text-xs">Loading permissions…</p>
          </div>
        ) : (
          <>
            <p className="mb-4 text-sm text-ink-300">
              Choose which modules <span className="text-white">{permTarget?.name}</span> can access.
            </p>
            <div className="space-y-2">
              {permissions.map((p) => (
                <label
                  key={p.module_key}
                  className="flex items-center gap-3 rounded-xl glass px-3.5 py-2.5 text-sm text-ink-200"
                >
                  <input
                    type="checkbox"
                    checked={p.granted}
                    onChange={() => togglePermission(p.module_key)}
                    className="h-4 w-4 rounded border-white/20 bg-transparent accent-accent-cyan"
                  />
                  {GRANTABLE_MODULE_LABELS[p.module_key] || p.module_label}
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-3 pt-5">
              <Button type="button" variant="ghost" onClick={() => setPermTarget(null)} disabled={permSaving}>
                Cancel
              </Button>
              <Button type="button" onClick={handleSavePermissions} disabled={permSaving}>
                {permSaving ? "Saving…" : "Save Permissions"}
              </Button>
            </div>
          </>
        )}
      </Modal>

      {/* Delete Confirmation */}
      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Delete User">
        <p className="text-sm text-ink-300">
          Are you sure you want to delete <span className="text-white">{deleteTarget?.name}</span>? This cannot be undone.
        </p>
        <div className="flex justify-end gap-3 pt-5">
          <Button type="button" variant="ghost" onClick={() => setDeleteTarget(null)} disabled={deleting}>
            Cancel
          </Button>
          <Button type="button" variant="danger" onClick={handleConfirmDelete} disabled={deleting}>
            {deleting ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </Modal>

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
