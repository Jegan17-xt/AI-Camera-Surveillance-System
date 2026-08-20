import { useEffect, useState } from "react";
import axios from "axios";
import { Receipt, AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import AdminPageHeader from "../ui/AdminPageHeader";
import AdminCard from "../ui/AdminCard";
import AdminButton from "../ui/AdminButton";
import AdminToast from "../ui/AdminToast";
import AdminSelect from "../ui/AdminSelect";

const inputClass =
  "w-full rounded-md admin-panel px-3.5 py-2.5 text-sm text-ink-100 placeholder:text-ink-500 outline-none focus:border-admin-accent/50 focus:ring-2 focus:ring-admin-accent/20";

const todayDate = () => new Date().toISOString().slice(0, 10);

const emptyForm = { customer_id: "", amount: "", method: "", note: "", paid_on: todayDate() };

// Manually log a payment against a company's account — separate from
// "Payment History" (the read-only ledger) so this page stays a single,
// focused action. Same Backend/api/subscriptions.py:add_payment as
// before this page was split out of the old combined AdminSubscriptions.jsx.
export default function AdminBillingPaymentsLog() {
  const [companies, setCompanies] = useState([]);
  const [companiesLoading, setCompaniesLoading] = useState(true);

  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    setCompaniesLoading(true);

    axios
      .get("http://localhost:5000/subscriptions")
      .then((res) => setCompanies(res.data.subscriptions || []))
      .catch((err) => console.error("Subscriptions API Error :", err))
      .finally(() => setCompaniesLoading(false));
  }, []);

  const companyOptions = companies.map((c) => ({ value: String(c.customer_id), label: c.customer_name }));

  const handleSubmit = (e) => {
    e.preventDefault();

    if (!form.customer_id) {
      setFormError("Please select a company.");
      return;
    }

    setFormError(null);
    setSaving(true);

    axios
      .post(`http://localhost:5000/users/${form.customer_id}/payments`, {
        amount: form.amount,
        method: form.method,
        note: form.note,
        paid_on: form.paid_on,
      })
      .then(() => {
        setToast({ type: "success", message: "Payment logged successfully." });
        setForm(emptyForm);
      })
      .catch((err) => {
        setFormError(err.response?.data?.message || "Failed to log payment.");
      })
      .finally(() => setSaving(false));
  };

  return (
    <div>
      <AdminPageHeader
        eyebrow="Billing & Payments"
        title="Payments"
        description="Manually log a payment against a company's account — for a payment collected outside the simulated checkout flow."
      />

      <AdminCard className="mx-auto max-w-xl p-5 sm:p-6">
        <div className="mb-5 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-admin-accent/10 text-admin-accent">
            <Receipt size={19} />
          </span>
          <div>
            <p className="font-display text-sm font-semibold text-white">Log a Payment</p>
            <p className="text-xs text-ink-500">Recorded immediately in that company's Payment History.</p>
          </div>
        </div>

        {companiesLoading ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-ink-500">
            <Loader2 size={22} className="animate-spin text-admin-accent" />
            <p className="text-xs">Loading companies…</p>
          </div>
        ) : (
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink-400">Company</label>
              <AdminSelect
                value={form.customer_id}
                onChange={(value) => setForm((f) => ({ ...f, customer_id: value }))}
                options={companyOptions}
                placeholder="Select a company…"
              />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-ink-400">Amount (₹)</label>
                <input
                  type="number"
                  required
                  min={0.01}
                  step="0.01"
                  value={form.amount}
                  onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                  className={inputClass}
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-ink-400">Method</label>
                <input
                  type="text"
                  maxLength={50}
                  placeholder="e.g. Bank Transfer"
                  value={form.method}
                  onChange={(e) => setForm((f) => ({ ...f, method: e.target.value }))}
                  className={inputClass}
                />
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink-400">Paid On</label>
              <input
                type="date"
                required
                value={form.paid_on}
                onChange={(e) => setForm((f) => ({ ...f, paid_on: e.target.value }))}
                className={inputClass}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink-400">Note</label>
              <input
                type="text"
                maxLength={300}
                placeholder="Optional"
                value={form.note}
                onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                className={inputClass}
              />
            </div>

            {formError && (
              <div className="flex items-start gap-2 rounded-md border border-signal-red/30 bg-signal-red/10 px-3.5 py-2.5 text-xs text-signal-red">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>{formError}</span>
              </div>
            )}

            <AdminButton type="submit" icon={CheckCircle2} disabled={saving || companies.length === 0} className="w-full justify-center">
              {saving ? "Logging…" : "Log Payment"}
            </AdminButton>
          </form>
        )}
      </AdminCard>

      <AdminToast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
