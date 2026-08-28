import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import { UserPlus, Pencil, Trash2, Eye, Loader2, AlertTriangle, Building2, Lock, Unlock } from "lucide-react";
import AdminPageHeader from "../ui/AdminPageHeader";
import AdminSearchInput from "../ui/AdminSearchInput";
import AdminCard from "../ui/AdminCard";
import AdminButton from "../ui/AdminButton";
import AdminModal from "../ui/AdminModal";
import AdminToast from "../ui/AdminToast";
import AdminBadge from "../ui/AdminBadge";
import AdminSelect from "../ui/AdminSelect";
import AdminToggle from "../ui/AdminToggle";
import { DATA_EVENTS, emitDataEvent } from "../../lib/dataEvents";
import { API_BASE_URL } from "../../lib/apiBase";
import {
  validateTextField,
  validateEmail,
  validatePhone,
  validatePassword,
  hasNoErrors,
  INVALID_INPUT_CLASS,
} from "../../lib/validation";

const inputClass =
  "w-full rounded-md admin-panel px-3.5 py-2.5 text-sm text-ink-100 placeholder:text-ink-500 outline-none focus:border-admin-accent/50 focus:ring-2 focus:ring-admin-accent/20";

const errorInputClass = (invalid) => `${inputClass} ${invalid ? INVALID_INPUT_CLASS : ""}`;

const emptyAddForm = { name: "", email: "", username: "", phone_number: "", password: "" };

const formatAmount = (amount) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(amount || 0);

function FieldError({ error }) {
  if (!error) return null;
  return <p className="mt-1.5 text-xs text-red-400">{error}</p>;
}

export default function AdminCustomers() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [customers, setCustomers] = useState([]);
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
  const [permissions, setPermissions] = useState([]);
  const [permLoading, setPermLoading] = useState(false);

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

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const fetchCustomers = () => {
    setLoading(true);
    setError(null);

    return axios
      .get(`${API_BASE_URL}/users`)
      .then((res) => {
        // This page manages Company Admin accounts only — neither Super
        // Admins (managed elsewhere) nor individual Users (managed only
        // by their own Company Admin, never listed here) belong on it.
        setCustomers((res.data.users || []).filter((u) => u.role === "Company Admin"));
      })
      .catch((err) => {
        console.error("Company Admins API Error :", err);
        setError("Unable to load Company Admins. Please check the server and try again.");
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchCustomers();
  }, []);

  const filtered = useMemo(
    () => customers.filter((c) => c.name.toLowerCase().includes(query.toLowerCase())),
    [customers, query]
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
      .post(`${API_BASE_URL}/users`, { ...addForm, role: "Company Admin", status: "Active" })
      .then(() => {
        setToast({ type: "success", message: "Company Admin created successfully." });
        setAddOpen(false);
        fetchCustomers();
        emitDataEvent(DATA_EVENTS.CUSTOMERS_CHANGED);
      })
      .catch((err) => {
        setToast({ type: "error", message: err.response?.data?.message || "Failed to create Company Admin." });
      })
      .finally(() => setSaving(false));
  };

  const openEdit = (customer) => {
    setEditTarget(customer);
    setEditForm({
      name: customer.name,
      email: customer.email,
      username: customer.username,
      phone_number: customer.phone_number || "",
      status: customer.status,
    });
    setEditTouched({});
    setPermissions([]);
    setPermLoading(true);

    // Permissions (module_key/label/granted/always_active) + this
    // company's effective billing price per module (its own override if
    // one is set, otherwise the global catalog price — same resolution
    // AdminBillingPricing.jsx and the Company Admin's own Subscription &
    // Payment page use), merged into one row per module for the Module
    // Access & Billing grid below.
    Promise.all([
      axios.get(`${API_BASE_URL}/users/${customer.id}/permissions`),
      axios.get(`${API_BASE_URL}/billing/items`, { params: { customer_id: customer.id } }),
    ])
      .then(([permRes, itemsRes]) => {
        const priceByModuleKey = Object.fromEntries(
          (itemsRes.data.items || [])
            .filter((item) => item.activation_type === "module")
            .map((item) => [item.activation_ref, item])
        );

        setPermissions(
          (permRes.data.permissions || []).map((p) => ({
            ...p,
            monthly_price: priceByModuleKey[p.module_key]?.monthly_price ?? 0,
            yearly_price: priceByModuleKey[p.module_key]?.yearly_price ?? 0,
          }))
        );
      })
      .catch((err) => {
        console.error("Get Permissions API Error :", err);
        setToast({ type: "error", message: "Failed to load module access & billing details." });
      })
      .finally(() => setPermLoading(false));
  };

  const closeEdit = () => {
    setEditTarget(null);
  };

  const toggleModule = (moduleKey, alwaysActive) => {
    // Dashboard and Subscription & Payment can never be locked — see
    // Backend/auth/database.py's ALWAYS_ACTIVE_MODULE_KEYS. Enforced
    // again server-side regardless of this guard.
    if (alwaysActive) return;

    setPermissions((prev) =>
      prev.map((p) => (p.module_key === moduleKey ? { ...p, granted: !p.granted } : p))
    );
  };

  const handleSave = async () => {
    if (!editTarget) return;
    setEditTouched({ name: true, email: true, username: true, phone_number: true });
    if (!isEditValid) return;
    setSaving(true);

    try {
      await axios.put(`${API_BASE_URL}/users/${editTarget.id}`, {
        name: editForm.name,
        email: editForm.email,
        username: editForm.username,
        phone_number: editForm.phone_number,
        role: "Company Admin",
      });

      if (editForm.status !== editTarget.status) {
        await axios.put(`${API_BASE_URL}/users/${editTarget.id}/status`, { status: editForm.status });
      }

      const moduleKeys = permissions.filter((p) => p.granted).map((p) => p.module_key);
      await axios.put(`${API_BASE_URL}/users/${editTarget.id}/permissions`, { module_keys: moduleKeys });

      setToast({ type: "success", message: "Company Admin updated successfully." });
      setEditTarget(null);
      fetchCustomers();
      emitDataEvent(DATA_EVENTS.CUSTOMERS_CHANGED);
    } catch (err) {
      setToast({ type: "error", message: err.response?.data?.message || "Failed to save Company Admin." });
    } finally {
      setSaving(false);
    }
  };

  // Delete confirmation is shared by both entry points: the table row's
  // Delete button, and the Delete Company Admin button inside the Edit modal.
  const requestDelete = (customer) => {
    setDeleteTarget(customer);
  };

  const handleConfirmDelete = () => {
    if (!deleteTarget) return;
    setDeleting(true);

    axios
      .delete(`${API_BASE_URL}/users/${deleteTarget.id}`)
      .then(() => {
        setToast({ type: "success", message: "Company Admin deleted successfully." });
        setDeleteTarget(null);
        setEditTarget(null);
        fetchCustomers();
        emitDataEvent(DATA_EVENTS.CUSTOMERS_CHANGED);
      })
      .catch((err) => {
        setToast({ type: "error", message: err.response?.data?.message || "Failed to delete Company Admin." });
      })
      .finally(() => setDeleting(false));
  };

  return (
    <div>
      <AdminPageHeader
        eyebrow="Accounts"
        title="Company Admins"
        description="Manage Company Admin accounts and the modules each one can access."
        actions={
          <AdminButton icon={UserPlus} onClick={openAdd}>
            Add Company Admin
          </AdminButton>
        }
      />

      <AdminCard className="p-4 sm:p-5">
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <AdminSearchInput value={query} onChange={setQuery} placeholder="Search by name…" className="sm:w-72" />
          <p className="font-mono text-xs text-ink-500">
            {loading ? "Loading…" : `${filtered.length} of ${customers.length} Company Admins`}
          </p>
        </div>

        {loading && (
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-ink-500">
            <Loader2 size={22} className="animate-spin text-admin-accent" />
            <p className="text-xs">Loading Company Admins…</p>
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
            <table className="w-full min-w-[720px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-admin-accent/10 text-xs uppercase tracking-wide text-ink-500">
                  <th className="px-3 py-3 font-medium">Company Name</th>
                  <th className="px-3 py-3 font-medium">Company Admin Name</th>
                  <th className="px-3 py-3 font-medium">Username</th>
                  <th className="px-3 py-3 font-medium">Status</th>
                  <th className="w-24 px-3 py-3 font-medium text-right">Details</th>
                  <th className="w-24 px-3 py-3 font-medium text-right">Edit</th>
                  <th className="w-24 px-3 py-3 font-medium text-right">Delete</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <tr key={c.id} className="border-b border-white/5 hover:bg-white/[0.03] transition">
                    {/* The account only has a single "name" field today —
                        it doubles as both the company's display name and
                        the Company Admin's own name, so both columns
                        intentionally show the same value. */}
                    <td className="px-3 py-3 font-medium text-ink-100">{c.name}</td>
                    <td className="px-3 py-3 text-ink-300">{c.name}</td>
                    <td className="px-3 py-3 font-mono text-xs text-ink-400">{c.username}</td>
                    <td className="px-3 py-3">
                      <AdminBadge status={c.status} />
                    </td>
                    <td className="px-3 py-3 text-right">
                      <button
                        onClick={() => navigate(`/super-admin/company-management/${c.id}/details`)}
                        className="inline-flex rounded-md p-2 text-ink-400 hover:bg-white/5 hover:text-admin-accent"
                        title="View Company Details"
                      >
                        <Eye size={16} />
                      </button>
                    </td>
                    <td className="px-3 py-3 text-right">
                      <button
                        onClick={() => openEdit(c)}
                        className="inline-flex rounded-md p-2 text-ink-400 hover:bg-white/5 hover:text-admin-accent"
                        title="Edit Company Admin"
                      >
                        <Pencil size={16} />
                      </button>
                    </td>
                    <td className="px-3 py-3 text-right">
                      <button
                        onClick={() => requestDelete(c)}
                        className="inline-flex rounded-md p-2 text-ink-400 hover:bg-signal-red/10 hover:text-signal-red"
                        title="Delete Company Admin"
                      >
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))}

                {customers.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-16 text-center text-ink-500">
                      <div className="flex flex-col items-center gap-2">
                        <Building2 size={22} />
                        <p>No Company Admins have been created yet.</p>
                      </div>
                    </td>
                  </tr>
                )}

                {customers.length > 0 && filtered.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-12 text-center text-ink-500">
                      No Company Admins match “{query}”.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </AdminCard>

      {/* Add Company Admin */}
      <AdminModal open={addOpen} onClose={() => setAddOpen(false)} title="Add Company Admin">
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
            />
            {addTouched.password && <FieldError error={addErrors.password} />}
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <AdminButton type="button" variant="ghost" onClick={() => setAddOpen(false)} disabled={saving}>
              Cancel
            </AdminButton>
            <AdminButton type="submit" disabled={saving || !isAddValid}>
              {saving ? "Creating…" : "Create Company Admin"}
            </AdminButton>
          </div>
        </form>
      </AdminModal>

      {/* Edit Company Admin */}
      <AdminModal open={!!editTarget} onClose={closeEdit} title="Edit Company Admin" size="lg">
        <div className="space-y-5">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Company Admin Details</p>

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
          </div>

          <div className="border-t border-white/8 pt-5">
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-500">Module Access & Billing</p>
            <p className="mb-3 text-xs text-ink-500">
              Allow (unlock) a module to make it accessible in this Company Admin's dashboard and include its price
              in their Total Amount. A locked module stays visible to them but inaccessible and unbilled — they
              cannot change this themselves.
            </p>
            {permLoading ? (
              <div className="flex items-center gap-2 py-3 text-ink-500">
                <Loader2 size={16} className="animate-spin" />
                <p className="text-xs">Loading module access…</p>
              </div>
            ) : (
              <div className="divide-y divide-white/5 rounded-md admin-panel px-4 py-1">
                {permissions.map((p) => (
                  <AdminToggle
                    key={p.module_key}
                    label={
                      <span className="flex items-center gap-2">
                        {p.granted ? (
                          <Unlock size={14} className="text-signal-green" />
                        ) : (
                          <Lock size={14} className="text-ink-500" />
                        )}
                        {p.module_label}
                        {p.always_active && <span className="text-[11px] text-ink-500">(Always Unlocked)</span>}
                      </span>
                    }
                    description={
                      p.always_active
                        ? "Free — always included, never billed."
                        : `${formatAmount(p.monthly_price)} / mo · ${formatAmount(p.yearly_price)} / yr — ${
                            p.granted ? "included in Total Amount" : "excluded from Total Amount"
                          }`
                    }
                    checked={p.granted}
                    disabled={p.always_active}
                    onChange={() => toggleModule(p.module_key, p.always_active)}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/8 pt-5">
            <AdminButton
              type="button"
              variant="danger"
              onClick={() => requestDelete(editTarget)}
              disabled={saving || deleting}
            >
              Delete Company Admin
            </AdminButton>

            <div className="flex gap-3">
              <AdminButton type="button" variant="ghost" onClick={closeEdit} disabled={saving}>
                Cancel
              </AdminButton>
              <AdminButton type="button" onClick={handleSave} disabled={saving || permLoading || !isEditValid}>
                {saving ? "Saving…" : "Save Changes"}
              </AdminButton>
            </div>
          </div>
        </div>
      </AdminModal>

      {/* Delete Confirmation — shared by table row and Edit modal */}
      <AdminModal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Delete Company Admin">
        <p className="text-sm text-ink-300">
          Are you sure you want to delete this Company Admin?
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
