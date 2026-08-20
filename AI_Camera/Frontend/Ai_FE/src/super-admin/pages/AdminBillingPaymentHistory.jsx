import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { Loader2, AlertTriangle, Receipt } from "lucide-react";
import AdminPageHeader from "../ui/AdminPageHeader";
import AdminSearchInput from "../ui/AdminSearchInput";
import AdminCard from "../ui/AdminCard";
import AdminBadge from "../ui/AdminBadge";

const formatAmount = (amount) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(amount || 0);

// Read-only ledger of every payment across every company — both
// manually logged (AdminBillingPaymentsLog.jsx) and completed through a
// Company Admin's own simulated checkout (Backend/api/billing.py). Same
// GET /payments as before this page was split out of the old combined
// AdminSubscriptions.jsx.
export default function AdminBillingPaymentHistory() {
  const [query, setQuery] = useState("");
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);

    axios
      .get("http://localhost:5000/payments")
      .then((res) => setPayments(res.data.payments || []))
      .catch((err) => {
        console.error("Payments API Error :", err);
        setError("Unable to load payment history. Please check the server and try again.");
      })
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(
    () => payments.filter((p) => p.customer_name.toLowerCase().includes(query.toLowerCase())),
    [payments, query]
  );

  return (
    <div>
      <AdminPageHeader
        eyebrow="Billing & Payments"
        title="Payment History"
        description="Every payment across every company — manually logged or completed through a Company Admin's own checkout."
      />

      <AdminCard className="p-4 sm:p-5">
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <AdminSearchInput value={query} onChange={setQuery} placeholder="Search by company…" className="sm:w-72" />
          <p className="font-mono text-xs text-ink-500">
            {loading ? "Loading…" : `${filtered.length} of ${payments.length} payments`}
          </p>
        </div>

        {loading && (
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-ink-500">
            <Loader2 size={22} className="animate-spin text-admin-accent" />
            <p className="text-xs">Loading payment history…</p>
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
            <table className="w-full min-w-[820px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-admin-accent/10 text-xs uppercase tracking-wide text-ink-500">
                  <th className="px-3 py-3 font-medium">Company</th>
                  <th className="px-3 py-3 font-medium">Amount</th>
                  <th className="px-3 py-3 font-medium">Items</th>
                  <th className="px-3 py-3 font-medium">Method</th>
                  <th className="px-3 py-3 font-medium">Status</th>
                  <th className="px-3 py-3 font-medium">Note</th>
                  <th className="px-3 py-3 font-medium text-right">Paid On</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => (
                  <tr key={p.id} className="border-b border-white/5">
                    <td className="px-3 py-2.5 font-medium text-ink-100">{p.customer_name}</td>
                    <td className="px-3 py-2.5 font-mono text-xs text-signal-green">{formatAmount(p.amount)}</td>
                    <td className="px-3 py-2.5 max-w-[220px] truncate text-xs text-ink-400" title={(p.items || []).map((i) => i.item_name).join(", ")}>
                      {p.items && p.items.length > 0 ? p.items.map((i) => i.item_name).join(", ") : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-ink-400">{p.method || "—"}</td>
                    <td className="px-3 py-2.5">
                      <AdminBadge status={p.status === "Success" ? "Active" : p.status || "Active"} />
                    </td>
                    <td className="px-3 py-2.5 text-xs text-ink-400">{p.note || "—"}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-xs text-ink-500">{p.paid_on}</td>
                  </tr>
                ))}

                {payments.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-16 text-center text-ink-500">
                      <div className="flex flex-col items-center gap-2">
                        <Receipt size={22} />
                        <p>No payments logged yet.</p>
                      </div>
                    </td>
                  </tr>
                )}

                {payments.length > 0 && filtered.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-12 text-center text-ink-500">
                      No payments match “{query}”.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </AdminCard>
    </div>
  );
}
