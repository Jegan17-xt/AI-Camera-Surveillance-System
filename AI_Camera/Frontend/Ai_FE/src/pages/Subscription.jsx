import { useEffect, useState } from "react";
import axios from "axios";
import { CreditCard, Receipt, Loader2, AlertTriangle } from "lucide-react";
import PageHeader from "../components/ui/PageHeader";
import GlassCard from "../components/ui/GlassCard";
import StatusBadge from "../components/ui/StatusBadge";
import { API_BASE_URL } from "../lib/apiBase";

const formatAmount = (amount) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(amount || 0);

// Read-only — the same manual record Super Admin maintains
// (Backend/api/subscriptions.py), scoped to this company only via the
// session (GET /account/subscription, /account/payments). No edit
// controls here by design; editing stays exclusively a Super Admin
// action under Subscription & Payment in the Admin Portal.
export default function Subscription() {
  const [subscription, setSubscription] = useState(null);
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);

    Promise.all([
      axios.get(`${API_BASE_URL}/account/subscription`),
      axios.get(`${API_BASE_URL}/account/payments`),
    ])
      .then(([subscriptionRes, paymentsRes]) => {
        setSubscription(subscriptionRes.data.subscription);
        setPayments(paymentsRes.data.payments || []);
      })
      .catch((err) => {
        console.error("Subscription API Error :", err);
        setError("Unable to load your subscription details. Please check the server and try again.");
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <PageHeader
        eyebrow="Account"
        title="Payment"
        description="Your company's plan, status, and payment history. Maintained by your administrator — read-only here."
      />

      {loading && (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-ink-500">
          <Loader2 size={22} className="animate-spin" />
          <p className="text-xs">Loading subscription details…</p>
        </div>
      )}

      {!loading && error && (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-center text-ink-500">
          <AlertTriangle size={22} className="text-red-400" />
          <p className="text-xs">{error}</p>
        </div>
      )}

      {!loading && !error && subscription && (
        <>
          <GlassCard className="p-5">
            <div className="mb-4 flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-cyan/10 text-accent-cyan">
                <CreditCard size={19} />
              </span>
              <div>
                <p className="font-display text-sm font-semibold text-white">Current Plan</p>
                <p className="text-xs text-ink-500">Your company's subscription status</p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <p className="text-xs font-medium text-ink-500">Plan</p>
                <p className="mt-1 text-sm font-medium text-ink-100">{subscription.plan_name}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-ink-500">Status</p>
                <div className="mt-1.5">
                  <StatusBadge status={subscription.status} />
                </div>
              </div>
              <div>
                <p className="text-xs font-medium text-ink-500">Amount</p>
                <p className="mt-1 font-mono text-sm text-ink-100">{formatAmount(subscription.amount)}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-ink-500">Billing Cycle</p>
                <p className="mt-1 text-sm text-ink-100">{subscription.billing_cycle}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-ink-500">Next Due Date</p>
                <p className="mt-1 text-sm text-ink-100">{subscription.next_due_date || "—"}</p>
              </div>
              {subscription.notes && (
                <div className="sm:col-span-2 lg:col-span-3">
                  <p className="text-xs font-medium text-ink-500">Notes</p>
                  <p className="mt-1 text-sm text-ink-300">{subscription.notes}</p>
                </div>
              )}
            </div>
          </GlassCard>

          <GlassCard className="mt-4 p-5">
            <div className="mb-4 flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-cyan/10 text-accent-cyan">
                <Receipt size={19} />
              </span>
              <div>
                <p className="font-display text-sm font-semibold text-white">Payment History</p>
                <p className="text-xs text-ink-500">Payments logged against your account</p>
              </div>
            </div>

            {payments.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-10 text-ink-500">
                <Receipt size={20} />
                <p className="text-xs">No payments logged yet.</p>
              </div>
            ) : (
              <div className="custom-scroll overflow-x-auto">
                <table className="w-full min-w-[520px] border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-white/8 text-xs uppercase tracking-wide text-ink-500">
                      <th className="px-3 py-2.5 font-medium">Amount</th>
                      <th className="px-3 py-2.5 font-medium">Method</th>
                      <th className="px-3 py-2.5 font-medium">Note</th>
                      <th className="px-3 py-2.5 font-medium text-right">Paid On</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payments.map((p) => (
                      <tr key={p.id} className="border-b border-white/5">
                        <td className="px-3 py-2.5 font-mono text-xs text-signal-green">{formatAmount(p.amount)}</td>
                        <td className="px-3 py-2.5 text-xs text-ink-400">{p.method || "—"}</td>
                        <td className="px-3 py-2.5 text-xs text-ink-400">{p.note || "—"}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-xs text-ink-500">{p.paid_on}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </GlassCard>
        </>
      )}
    </div>
  );
}
