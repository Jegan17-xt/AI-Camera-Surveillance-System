import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { UserPlus, Pencil, Trash2, KeyRound, Loader2, AlertTriangle, ShieldCheck } from "lucide-react";
import AdminPageHeader from "../ui/AdminPageHeader";
import AdminSearchInput from "../ui/AdminSearchInput";
import AdminCard from "../ui/AdminCard";
import AdminButton from "../ui/AdminButton";
import AdminModal from "../ui/AdminModal";
import AdminToast from "../ui/AdminToast";
import AdminBadge from "../ui/AdminBadge";
import AdminSelect from "../ui/AdminSelect";
import { useAuth } from "../../context/AuthContext";
import {
  validateTextField,
  validateEmail,
  validatePhone,
  validatePassword,
  validatePasswordsMatch,
  hasNoErrors,
  INVALID_INPUT_CLASS,
} from "../../lib/validation";

const inputClass =
  "w-full rounded-md admin-panel px-3.5 py-2.5 text-sm text-ink-100 placeholder:text-ink-500 outline-none focus:border-admin-accent/50 focus:ring-2 focus:ring-admin-accent/20";

const errorInputClass = (invalid) => `${inputClass} ${invalid ? INVALID_INPUT_CLASS : ""}`;

const emptyAddForm = { name: "", email: "", username: "", phone_number: "", password: "" };

function FieldError({ error }) {
  if (!error) return null;
  return <p className="mt-1.5 text-xs text-red-400">{error}</p>;
}

// Every action here (create/edit/delete/status/reset-password) hits the
// exact same /users* endpoints AdminCustomers.jsx already uses — this
// page only differs in which role it targets (Super Admin instead of
// User) and which fields it shows (no Module Permissions section, since
// Super Admin always has every module implicitly — see
// auth/auth.py get_effective_modules). The backend's own safeguards
// ("cannot delete/disable your own account", "at least one active
// Super Admin must remain" — api/users.py) are untouched and enforced
// exactly as they already are for every other caller of these routes.
export default function AdminManagement() {
  const { user: currentUser } = useAuth();

  const [query, setQuery] = useState("");
  const [admins, setAdmins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState(emptyAddForm);
  const [addTouched, setAddTouched] = useState({});
  const [saving, setSaving] = useState(false);

  const [editTarget, setEditTarget] = useState(null);
  const [editForm, setEditForm] = useState({ name: "", email: "", username: "", phone_number: "", status: "Active" });
  const [editTouched, setEditTouched] = useState({});

  const [passwordTarget, setPasswordTarget] = useState(null);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordTouched, setPasswordTouched] = useState({});
  const [passwordError, setPasswordError] = useState(null);
  const [updatingPassword, setUpdatingPassword] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const addErrors = {
    name: validateTextField(addForm.name, "Name", { minLen: 2, maxLen: 50 }),
    email: validateEmail(addForm.email),
    username: validateTextField(addForm.username, "Username", { minLen: 3, maxLen: 50 }),
    phone_number: validatePhone(addForm.phone_number),
    password: validatePassword(addForm.password, { label: "Password", strong: true }),
  };
  const isAddValid = hasNoErrors(addErrors);

  const editErrors = {
    name: validateTextField(editForm.name, "Name", { minLen: 2, maxLen: 50 }),
    email: validateEmail(editForm.email),
    username: validateTextField(editForm.username, "Username", { minLen: 3, maxLen: 50 }),
    phone_number: validatePhone(editForm.phone_number),
  };
  const isEditValid = hasNoErrors(editErrors);

  const passwordErrors = {
    newPassword: validatePassword(newPassword, { label: "New Password", strong: true }),
    confirmPassword: validatePasswordsMatch(newPassword, confirmPassword),
  };
  const isPasswordValid = hasNoErrors(passwordErrors);

  const fetchAdmins = () => {
    setLoading(true);
    setError(null);

    return axios
      .get("http://localhost:5000/users")
      .then((res) => {
        setAdmins((res.data.users || []).filter((u) => u.role === "Super Admin"));
      })
      .catch((err) => {
        console.error("Admin Management API Error :", err);
        setError("Unable to load Super Admin accounts. Please check the server and try again.");
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchAdmins();
  }, []);

  const filtered = useMemo(
    () => admins.filter((a) => a.name.toLowerCase().includes(query.toLowerCase())),
    [admins, query]
  );

  const openAdd = () => {
    setAddForm(emptyAddForm);
    setAddTouched({});
    setAddOpen(true);
  };

  const handleAdd = (e) => {
    e.preventDefault();
    setAddTouched({ name: true, email: true, username: true, phone_number: true, password: true });
    if (!isAddValid) return;
    setSaving(true);

    axios
      .post("http://localhost:5000/users", { ...addForm, role: "Super Admin", status: "Active" })
      .then(() => {
        setToast({ type: "success", message: "Super Admin account created successfully." });
        setAddOpen(false);
        fetchAdmins();
      })
      .catch((err) => {
        setToast({ type: "error", message: err.response?.data?.message || "Failed to create Super Admin account." });
      })
      .finally(() => setSaving(false));
  };

  const openEdit = (admin) => {
    setEditTarget(admin);
    setEditForm({
      name: admin.name,
      email: admin.email,
      username: admin.username,
      phone_number: admin.phone_number || "",
      status: admin.status,
    });
    setEditTouched({});
  };

  const closeEdit = () => setEditTarget(null);

  const handleSave = async () => {
    if (!editTarget) return;
    setEditTouched({ name: true, email: true, username: true, phone_number: true });
    if (!isEditValid) return;
    setSaving(true);

    try {
      await axios.put(`http://localhost:5000/users/${editTarget.id}`, {
        name: editForm.name,
        email: editForm.email,
        username: editForm.username,
        phone_number: editForm.phone_number,
        role: "Super Admin",
      });

      if (editForm.status !== editTarget.status) {
        await axios.put(`http://localhost:5000/users/${editTarget.id}/status`, { status: editForm.status });
      }

      setToast({ type: "success", message: "Super Admin account updated successfully." });
      setEditTarget(null);
      fetchAdmins();
    } catch (err) {
      setToast({ type: "error", message: err.response?.data?.message || "Failed to save Super Admin account." });
    } finally {
      setSaving(false);
    }
  };

  const openResetPassword = (admin) => {
    setPasswordTarget(admin);
    setNewPassword("");
    setConfirmPassword("");
    setPasswordTouched({});
    setPasswordError(null);
  };

  const closeResetPassword = () => setPasswordTarget(null);

  const handleResetPassword = (e) => {
    e.preventDefault();
    setPasswordTouched({ newPassword: true, confirmPassword: true });
    setPasswordError(null);
    if (!isPasswordValid || !passwordTarget) return;
    setUpdatingPassword(true);

    axios
      .put(`http://localhost:5000/users/${passwordTarget.id}/reset-password`, { password: newPassword })
      .then(() => {
        setToast({ type: "success", message: "Password reset successfully." });
        setPasswordTarget(null);
      })
      .catch((err) => {
        setPasswordError(err.response?.data?.message || "Failed to reset password.");
      })
      .finally(() => setUpdatingPassword(false));
  };

  const requestDelete = (admin) => setDeleteTarget(admin);

  const handleConfirmDelete = () => {
    if (!deleteTarget) return;
    setDeleting(true);

    axios
      .delete(`http://localhost:5000/users/${deleteTarget.id}`)
      .then(() => {
        setToast({ type: "success", message: "Super Admin account deleted successfully." });
        setDeleteTarget(null);
        setEditTarget(null);
        fetchAdmins();
      })
      .catch((err) => {
        setToast({ type: "error", message: err.response?.data?.message || "Failed to delete Super Admin account." });
      })
      .finally(() => setDeleting(false));
  };

  return (
    <div>
      <AdminPageHeader
        eyebrow="System Settings"
        title="Super Admin Management"
        description="Create and manage other Super Admin accounts. Super Admin always has complete access to every module."
        actions={
          <AdminButton icon={UserPlus} onClick={openAdd}>
            Add Super Admin
          </AdminButton>
        }
      />

      <AdminCard className="p-4 sm:p-5">
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <AdminSearchInput value={query} onChange={setQuery} placeholder="Search by name…" className="sm:w-72" />
          <p className="font-mono text-xs text-ink-500">
            {loading ? "Loading…" : `${filtered.length} of ${admins.length} Super Admins`}
          </p>
        </div>

        {loading && (
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-ink-500">
            <Loader2 size={22} className="animate-spin text-admin-accent" />
            <p className="text-xs">Loading Super Admin accounts…</p>
          </div>
        )}

        {!loading && error && (
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-center text-ink-500">
            <AlertTriangle size={22} className="text-red-400" />
            <p className="text-xs">{error}</p>
          </div>
        )}

        {!loading && !error && (
          <div className="custom-scroll overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-admin-accent/10 text-xs uppercase tracking-wide text-ink-500">
                  <th className="px-3 py-3 font-medium">Name</th>
                  <th className="px-3 py-3 font-medium">Username</th>
                  <th className="px-3 py-3 font-medium">Status</th>
                  <th className="w-24 px-3 py-3 font-medium text-right">Reset Password</th>
                  <th className="w-16 px-3 py-3 font-medium text-right">Edit</th>
                  <th className="w-16 px-3 py-3 font-medium text-right">Delete</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((a) => (
                  <tr key={a.id} className="border-b border-white/5 hover:bg-white/[0.03] transition">
                    <td className="px-3 py-3 font-medium text-ink-100">
                      {a.name}
                      {a.id === currentUser?.id && <span className="ml-2 text-xs text-ink-500">(You)</span>}
                    </td>
                    <td className="px-3 py-3 font-mono text-xs text-ink-400">{a.username}</td>
                    <td className="px-3 py-3">
                      <AdminBadge status={a.status} />
                    </td>
                    <td className="px-3 py-3 text-right">
                      <button
                        onClick={() => openResetPassword(a)}
                        className="inline-flex rounded-md p-2 text-ink-400 hover:bg-white/5 hover:text-admin-accent"
                        title="Reset Password"
                      >
                        <KeyRound size={16} />
                      </button>
                    </td>
                    <td className="px-3 py-3 text-right">
                      <button
                        onClick={() => openEdit(a)}
                        className="inline-flex rounded-md p-2 text-ink-400 hover:bg-white/5 hover:text-admin-accent"
                        title="Edit Super Admin"
                      >
                        <Pencil size={16} />
                      </button>
                    </td>
                    <td className="px-3 py-3 text-right">
                      <button
                        onClick={() => requestDelete(a)}
                        className="inline-flex rounded-md p-2 text-ink-400 hover:bg-signal-red/10 hover:text-signal-red"
                        title="Delete Super Admin"
                      >
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))}

                {admins.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-16 text-center text-ink-500">
                      <div className="flex flex-col items-center gap-2">
                        <ShieldCheck size={22} />
                        <p>No Super Admin accounts found.</p>
                      </div>
                    </td>
                  </tr>
                )}

                {admins.length > 0 && filtered.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-12 text-center text-ink-500">
                      No Super Admins match “{query}”.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </AdminCard>

      {/* Add Super Admin */}
      <AdminModal open={addOpen} onClose={() => setAddOpen(false)} title="Add Super Admin">
        <form className="space-y-4" onSubmit={handleAdd}>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-400">Name</label>
            <input
              type="text"
              required
              value={addForm.name}
              onChange={(e) => setAddForm((f) => ({ ...f, name: e.target.value }))}
              onBlur={() => setAddTouched((t) => ({ ...t, name: true }))}
              className={errorInputClass(addTouched.name && addErrors.name)}
            />
            {addTouched.name && <FieldError error={addErrors.name} />}
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-400">Email</label>
            <input
              type="email"
              required
              value={addForm.email}
              onChange={(e) => setAddForm((f) => ({ ...f, email: e.target.value }))}
              onBlur={() => setAddTouched((t) => ({ ...t, email: true }))}
              className={errorInputClass(addTouched.email && addErrors.email)}
            />
            {addTouched.email && <FieldError error={addErrors.email} />}
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-400">Username</label>
            <input
              type="text"
              required
              value={addForm.username}
              onChange={(e) => setAddForm((f) => ({ ...f, username: e.target.value }))}
              onBlur={() => setAddTouched((t) => ({ ...t, username: true }))}
              className={errorInputClass(addTouched.username && addErrors.username)}
            />
            {addTouched.username && <FieldError error={addErrors.username} />}
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-400">Phone Number</label>
            <input
              type="tel"
              required
              inputMode="numeric"
              maxLength={10}
              value={addForm.phone_number}
              onChange={(e) => setAddForm((f) => ({ ...f, phone_number: e.target.value.replace(/\D/g, "") }))}
              onBlur={() => setAddTouched((t) => ({ ...t, phone_number: true }))}
              placeholder="10-digit phone number"
              className={errorInputClass(addTouched.phone_number && addErrors.phone_number)}
            />
            {addTouched.phone_number && <FieldError error={addErrors.phone_number} />}
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-400">Password</label>
            <input
              type="password"
              required
              minLength={8}
              value={addForm.password}
              onChange={(e) => setAddForm((f) => ({ ...f, password: e.target.value }))}
              onBlur={() => setAddTouched((t) => ({ ...t, password: true }))}
              placeholder="At least 8 characters, mixed case, number & symbol"
              className={errorInputClass(addTouched.password && addErrors.password)}
              autoComplete="new-password"
            />
            {addTouched.password && <FieldError error={addErrors.password} />}
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <AdminButton type="button" variant="ghost" onClick={() => setAddOpen(false)} disabled={saving}>
              Cancel
            </AdminButton>
            <AdminButton type="submit" disabled={saving || !isAddValid}>
              {saving ? "Creating…" : "Create Super Admin"}
            </AdminButton>
          </div>
        </form>
      </AdminModal>

      {/* Edit Super Admin */}
      <AdminModal open={!!editTarget} onClose={closeEdit} title="Edit Super Admin">
        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink-400">Name</label>
              <input
                type="text"
                value={editForm.name}
                onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                onBlur={() => setEditTouched((t) => ({ ...t, name: true }))}
                className={errorInputClass(editTouched.name && editErrors.name)}
              />
              {editTouched.name && <FieldError error={editErrors.name} />}
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink-400">Username</label>
              <input
                type="text"
                value={editForm.username}
                onChange={(e) => setEditForm((f) => ({ ...f, username: e.target.value }))}
                onBlur={() => setEditTouched((t) => ({ ...t, username: true }))}
                className={errorInputClass(editTouched.username && editErrors.username)}
              />
              {editTouched.username && <FieldError error={editErrors.username} />}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink-400">Email</label>
              <input
                type="email"
                value={editForm.email}
                onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))}
                onBlur={() => setEditTouched((t) => ({ ...t, email: true }))}
                className={errorInputClass(editTouched.email && editErrors.email)}
              />
              {editTouched.email && <FieldError error={editErrors.email} />}
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink-400">Phone Number</label>
              <input
                type="tel"
                inputMode="numeric"
                maxLength={10}
                value={editForm.phone_number}
                onChange={(e) => setEditForm((f) => ({ ...f, phone_number: e.target.value.replace(/\D/g, "") }))}
                onBlur={() => setEditTouched((t) => ({ ...t, phone_number: true }))}
                placeholder="10-digit phone number"
                className={errorInputClass(editTouched.phone_number && editErrors.phone_number)}
              />
              {editTouched.phone_number && <FieldError error={editErrors.phone_number} />}
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-400">Status</label>
            <AdminSelect
              value={editForm.status}
              onChange={(v) => setEditForm((f) => ({ ...f, status: v }))}
              options={[
                { value: "Active", label: "Active" },
                { value: "Inactive", label: "Inactive" },
              ]}
            />
            {editTarget?.id === currentUser?.id && (
              <p className="mt-1.5 text-xs text-ink-500">You cannot deactivate your own account.</p>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/8 pt-5">
            <AdminButton
              type="button"
              variant="danger"
              onClick={() => requestDelete(editTarget)}
              disabled={saving || deleting}
            >
              Delete Super Admin
            </AdminButton>

            <div className="flex gap-3">
              <AdminButton type="button" variant="ghost" onClick={closeEdit} disabled={saving}>
                Cancel
              </AdminButton>
              <AdminButton type="button" onClick={handleSave} disabled={saving || !isEditValid}>
                {saving ? "Saving…" : "Save Changes"}
              </AdminButton>
            </div>
          </div>
        </div>
      </AdminModal>

      {/* Reset Password */}
      <AdminModal open={!!passwordTarget} onClose={closeResetPassword} title="Reset Password">
        <form className="space-y-4" onSubmit={handleResetPassword}>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-400">Super Admin</label>
            <input type="text" value={passwordTarget?.name || ""} readOnly disabled className={`${inputClass} opacity-60`} />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-400">New Password</label>
            <input
              type="password"
              required
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              onBlur={() => setPasswordTouched((t) => ({ ...t, newPassword: true }))}
              placeholder="At least 8 characters, mixed case, number & symbol"
              className={errorInputClass(passwordTouched.newPassword && passwordErrors.newPassword)}
              autoComplete="new-password"
            />
            {passwordTouched.newPassword && <FieldError error={passwordErrors.newPassword} />}
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-400">Confirm Password</label>
            <input
              type="password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              onBlur={() => setPasswordTouched((t) => ({ ...t, confirmPassword: true }))}
              className={errorInputClass(passwordTouched.confirmPassword && passwordErrors.confirmPassword)}
              autoComplete="new-password"
            />
            {passwordTouched.confirmPassword && <FieldError error={passwordErrors.confirmPassword} />}
          </div>

          {passwordError && (
            <div className="flex items-start gap-2 rounded-md border border-signal-red/30 bg-signal-red/10 px-3.5 py-2.5 text-xs text-signal-red">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{passwordError}</span>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <AdminButton type="button" variant="ghost" onClick={closeResetPassword} disabled={updatingPassword}>
              Cancel
            </AdminButton>
            <AdminButton type="submit" disabled={updatingPassword || !isPasswordValid}>
              {updatingPassword ? "Updating…" : "Reset Password"}
            </AdminButton>
          </div>
        </form>
      </AdminModal>

      {/* Delete Confirmation */}
      <AdminModal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Delete Super Admin">
        <p className="text-sm text-ink-300">
          Are you sure you want to delete this Super Admin account?
          {deleteTarget && (
            <>
              {" "}
              <span className="font-semibold text-white">{deleteTarget.name}</span> will be permanently removed.
            </>
          )}
        </p>
        <div className="flex justify-end gap-3 pt-5">
          <AdminButton type="button" variant="ghost" onClick={() => setDeleteTarget(null)} disabled={deleting}>
            Cancel
          </AdminButton>
          <AdminButton type="button" variant="danger" onClick={handleConfirmDelete} disabled={deleting}>
            {deleting ? "Deleting…" : "Delete"}
          </AdminButton>
        </div>
      </AdminModal>

      <AdminToast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
