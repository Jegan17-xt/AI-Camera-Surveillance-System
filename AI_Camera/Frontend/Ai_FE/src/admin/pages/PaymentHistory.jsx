import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { Receipt, Loader2, AlertTriangle, Download } from "lucide-react";
import PageHeader from "../../components/ui/PageHeader";
import GlassCard from "../../components/ui/GlassCard";
import { usePolling } from "../../lib/usePolling";
import { API_BASE_URL } from "../../lib/apiBase";
import { POLL_MS, formatAmount, PaymentStatusBadge } from "../../components/subscription/subscriptionShared";

// Company Admin Subscription & Payment → Payment History — its own page/
// route, separate from Current Plan and Billing & Payment. Fetches only the
// payments list (+ the subscription record, used only as the fallback
// "Items" label for a payment with no line items of its own).
function invoiceNumber(paymentId) {
  return `INV-${String(paymentId).padStart(6, "0")}`;
}

export default function PaymentHistory() {
  const [subscription, setSubscription] = useState(null);
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchData = useCallback(() => {
    setError(null);

    return Promise.all([
      axios.get(`${API_BASE_URL}/company/subscription`),
      axios.get(`${API_BASE_URL}/company/payments`),
    ])
      .then(([subscriptionRes, paymentsRes]) => {
        setSubscription(subscriptionRes.data.subscription);
        setPayments(paymentsRes.data.payments || []);
      })
      .catch((err) => {
        console.error("Payment History API Error :", err);
        setError("Unable to load your payment history. Please check the server and try again.");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // The Super Admin edits subscription / billing from a different session —
  // polling reflects that here without a manual refresh.
  usePolling(fetchData, POLL_MS);

  return (
    <div>
      <PageHeader
        eyebrow="Account"
        title="Payment History"
        description="Payments made on your account — scoped to your account only."
      />

      {loading && (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-ink-500">
          <Loader2 size={22} className="animate-spin" />
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
        <GlassCard className="p-5">
          <div className="mb-4 flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-cyan/10 text-accent-cyan">
              <Receipt size={19} />
            </span>
            <div>
              <p className="font-display text-sm font-semibold text-white">Payment History</p>
              <p className="text-xs text-ink-500">Payments made on your account</p>
            </div>
          </div>

          {payments.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-ink-500">
              <Receipt size={20} />
              <p className="text-xs">No payments logged yet.</p>
            </div>
          ) : (
            <div className="custom-scroll overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-white/8 text-xs uppercase tracking-wide text-ink-500">
                    <th className="px-3 py-2.5 font-medium">Invoice Number</th>
                    <th className="px-3 py-2.5 font-medium">Payment Date</th>
                    <th className="px-3 py-2.5 font-medium">Amount</th>
                    <th className="px-3 py-2.5 font-medium">Items</th>
                    <th className="px-3 py-2.5 font-medium">Payment Method</th>
                    <th className="px-3 py-2.5 font-medium">Status</th>
                    <th className="w-16 px-3 py-2.5 font-medium text-right">Invoice</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.id} className="border-b border-white/5">
                      <td className="px-3 py-2.5 font-mono text-xs text-ink-400">{invoiceNumber(p.id)}</td>
                      <td className="px-3 py-2.5 font-mono text-xs text-ink-500">{p.paid_on}</td>
                      <td className="px-3 py-2.5 font-mono text-xs text-signal-green">{formatAmount(p.amount)}</td>
                      <td className="px-3 py-2.5 text-xs text-ink-300">
                        {p.items && p.items.length > 0
                          ? p.items.map((i) => i.item_name).join(", ")
                          : subscription?.plan_name || "—"}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-ink-400">{p.method || "—"}</td>
                      <td className="px-3 py-2.5">
                        <PaymentStatusBadge status={p.status || "Paid"} />
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <button
                          type="button"
                          disabled
                          title="Invoice file not available"
                          className="inline-flex cursor-not-allowed rounded-md p-1.5 text-ink-600 opacity-50"
                        >
                          <Download size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </GlassCard>
      )}
    </div>
  );
}
