import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { Pencil, Loader2, AlertTriangle, CreditCard } from "lucide-react";
import AdminPageHeader from "../ui/AdminPageHeader";
import AdminSearchInput from "../ui/AdminSearchInput";
import AdminCard from "../ui/AdminCard";
import AdminButton from "../ui/AdminButton";
import AdminModal from "../ui/AdminModal";
import AdminToast from "../ui/AdminToast";
import AdminBadge from "../ui/AdminBadge";
import AdminSelect from "../ui/AdminSelect";

const inputClass =
  "w-full rounded-md admin-panel px-3.5 py-2.5 text-sm text-ink-100 placeholder:text-ink-500 outline-none focus:border-admin-accent/50 focus:ring-2 focus:ring-admin-accent/20";

const STATUS_OPTIONS = [
  { value: "Trial", label: "Trial" },
  { value: "Active", label: "Active" },
  { value: "Expired", label: "Expired" },
  { value: "Cancelled", label: "Cancelled" },
];

const BILLING_CYCLE_OPTIONS = [
  { value: "Monthly", label: "Monthly" },
  { value: "Yearly", label: "Yearly" },
  { value: "One-time", label: "One-time" },
];

const formatAmount = (amount) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(amount || 0);

// Manual, per-company plan/status override — Super Admin's own
// tracking, independent of whatever a Company Admin has actually
// purchased on their own checkout page (Backend/api/billing.py). Every
// write goes through Backend/api/subscriptions.py, unchanged from
// before this page was split out of the old combined AdminSubscriptions.jsx.
export default function AdminBillingSubscriptions() {
  const [query, setQuery] = useState("");
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [editTarget, setEditTarget] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  const fetchCompanies = () => {
    setLoading(true);
    setError(null);

    return axios
      .get("http://localhost:5000/subscriptions")
      .then((res) => setCompanies(res.data.subscriptions || []))
      .catch((err) => {
        console.error("Subscriptions API Error :", err);
        setError("Unable to load subscriptions. Please check the server and try again.");
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchCompanies();
  }, []);

  const filtered = useMemo(
    () => companies.filter((c) => c.customer_name.toLowerCase().includes(query.toLowerCase())),
    [companies, query]
  );

  const openEdit = (company) => {
    setEditTarget(company);
    setEditForm({
      plan_name: company.plan_name,
      status: company.status,
      amount: String(company.amount ?? 0),
      billing_cycle: company.billing_cycle,
      next_due_date: company.next_due_date || "",
      notes: company.notes || "",
    });
    setFormError(null);
  };

  const closeEdit = () => {
    setEditTarget(null);
    setEditForm(null);
  };

  const handleSave = (e) => {
    e.preventDefault();
    if (!editTarget || !editForm) return;
    setFormError(null);
    setSaving(true);

    axios
      .put(`http://localhost:5000/users/${editTarget.customer_id}/subscription`, editForm)
      .then(() => {
        setToast({ type: "success", message: "Subscription updated successfully." });
        closeEdit();
        fetchCompanies();
      })
      .catch((err) => {
        setFormError(err.response?.data?.message || "Failed to update subscription.");
      })
      .finally(() => setSaving(false));
  };

  return (
    <div>
      <AdminPageHeader
        eyebrow="Billing & Payments"
        title="Subscriptions"
        description="Manual plan and status override per company — independent of what a Company Admin has purchased on their own checkout page."
      />

      <AdminCard className="p-4 sm:p-5">
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <AdminSearchInput value={query} onChange={setQuery} placeholder="Search by company…" className="sm:w-72" />
          <p className="font-mono text-xs text-ink-500">
            {loading ? "Loading…" : `${filtered.length} of ${companies.length} companies`}
          </p>
        </div>

        {loading && (
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-ink-500">
            <Loader2 size={22} className="animate-spin text-admin-accent" />
            <p className="text-xs">Loading subscriptions…</p>
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
                  <th className="px-3 py-3 font-medium">Company</th>
                  <th className="px-3 py-3 font-medium">Plan</th>
                  <th className="px-3 py-3 font-medium">Status</th>
                  <th className="px-3 py-3 font-medium">Amount</th>
                  <th className="px-3 py-3 font-medium">Billing Cycle</th>
                  <th className="px-3 py-3 font-medium">Next Due</th>
                  <th className="w-16 px-3 py-3 font-medium text-right">Edit</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <tr key={c.customer_id} className="border-b border-white/5 hover:bg-white/[0.03] transition">
                    <td className="px-3 py-3 font-medium text-ink-100">{c.customer_name}</td>
                    <td className="px-3 py-3 text-ink-200">{c.plan_name}</td>
                    <td className="px-3 py-3">
                      <AdminBadge status={c.status} />
                    </td>
                    <td className="px-3 py-3 font-mono text-xs text-ink-300">{formatAmount(c.amount)}</td>
                    <td className="px-3 py-3 text-xs text-ink-400">{c.billing_cycle}</td>
                    <td className="px-3 py-3 text-xs text-ink-400">{c.next_due_date || "—"}</td>
                    <td className="px-3 py-3 text-right">
                      <button
                        onClick={() => openEdit(c)}
                        className="inline-flex rounded-md p-2 text-ink-400 hover:bg-white/5 hover:text-admin-accent"
                        title="Edit Subscription"
                      >
                        <Pencil size={16} />
                      </button>
                    </td>
                  </tr>
                ))}

                {companies.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-16 text-center text-ink-500">
                      <div className="flex flex-col items-center gap-2">
                        <CreditCard size={22} />
                        <p>No companies found.</p>
                      </div>
                    </td>
                  </tr>
                )}

                {companies.length > 0 && filtered.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-12 text-center text-ink-500">
                      No companies match “{query}”.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </AdminCard>

      <AdminModal open={!!editTarget} onClose={closeEdit} title={editTarget ? `Subscription — ${editTarget.customer_name}` : "Subscription"}>
        {editForm && (
          <form className="space-y-4" onSubmit={handleSave}>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-ink-400">Plan Name</label>
                <input
                  type="text"
                  required
                  maxLength={50}
                  value={editForm.plan_name}
                  onChange={(e) => setEditForm((f) => ({ ...f, plan_name: e.target.value }))}
                  className={inputClass}
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-ink-400">Status</label>
                <AdminSelect
                  value={editForm.status}
                  onChange={(value) => setEditForm((f) => ({ ...f, status: value }))}
                  options={STATUS_OPTIONS}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-ink-400">Amount (₹)</label>
                <input
                  type="number"
                  required
                  min={0}
                  step="0.01"
                  value={editForm.amount}
                  onChange={(e) => setEditForm((f) => ({ ...f, amount: e.target.value }))}
                  className={inputClass}
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-ink-400">Billing Cycle</label>
                <AdminSelect
                  value={editForm.billing_cycle}
                  onChange={(value) => setEditForm((f) => ({ ...f, billing_cycle: value }))}
                  options={BILLING_CYCLE_OPTIONS}
                />
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink-400">Next Due Date</label>
              <input
                type="date"
                value={editForm.next_due_date}
                onChange={(e) => setEditForm((f) => ({ ...f, next_due_date: e.target.value }))}
                className={inputClass}
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink-400">Notes</label>
              <textarea
                rows={3}
                maxLength={500}
                value={editForm.notes}
                onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))}
                className={inputClass}
              />
            </div>

            {formError && (
              <div className="flex items-start gap-2 rounded-md border border-signal-red/30 bg-signal-red/10 px-3.5 py-2.5 text-xs text-signal-red">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>{formError}</span>
              </div>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <AdminButton type="button" variant="ghost" onClick={closeEdit} disabled={saving}>
                Cancel
              </AdminButton>
              <AdminButton type="submit" disabled={saving}>
                {saving ? "Saving…" : "Save Subscription"}
              </AdminButton>
            </div>
          </form>
        )}
      </AdminModal>

      <AdminToast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
