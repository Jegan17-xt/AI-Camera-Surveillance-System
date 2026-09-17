import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { CreditCard, Loader2, AlertTriangle, Clock, CheckCircle2 } from "lucide-react";
import PageHeader from "../../components/ui/PageHeader";
import GlassCard from "../../components/ui/GlassCard";
import StatusBadge from "../../components/ui/StatusBadge";
import { usePolling } from "../../lib/usePolling";
import { API_BASE_URL } from "../../lib/apiBase";
import { POLL_MS, formatAmount, PaymentStatusBadge } from "../../components/subscription/subscriptionShared";

// Company Admin Subscription & Payment → Current Plan — its own page/route,
// separate from Billing & Payment and Payment History (each of those is its
// own file too). Fetches only what THIS page shows: the subscription record,
// the latest payment (for the Payment Status / Last Payment fields), and the
// module packages list (for the Active Packages summary).
function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function computePaymentStatus(subscription, latestPayment) {
  const dueDate = parseDate(subscription?.next_due_date);

  if (!dueDate) return null;

  const today = new Date();

  if (dueDate.getTime() < today.getTime()) return "Overdue";

  const paidDate = parseDate(latestPayment?.paid_on);

  if (paidDate) {
    const cycleDays = subscription.billing_cycle === "Yearly" ? 366 : subscription.billing_cycle === "One-time" ? 36500 : 31;
    const daysSincePaid = Math.round((today.getTime() - paidDate.getTime()) / MS_PER_DAY);

    if (daysSincePaid >= 0 && daysSincePaid <= cycleDays) return "Paid";
  }

  return "Pending";
}

function remainingDaysLabel(nextDueDate) {
  const dueDate = parseDate(nextDueDate);

  if (!dueDate) return "—";

  const days = Math.ceil((dueDate.getTime() - new Date().getTime()) / MS_PER_DAY);

  if (days < 0) return `Overdue by ${Math.abs(days)} Day${Math.abs(days) === 1 ? "" : "s"}`;
  if (days === 0) return "Due Today";

  return `${days} Day${days === 1 ? "" : "s"} Remaining`;
}

export default function CurrentPlan() {
  const [subscription, setSubscription] = useState(null);
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [pkgList, setPkgList] = useState([]);
  const [pkgLoading, setPkgLoading] = useState(true);

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
        console.error("Current Plan API Error :", err);
        setError("Unable to load your subscription details. Please check the server and try again.");
      })
      .finally(() => setLoading(false));
  }, []);

  const fetchPackages = useCallback((isPoll = false) => {
    if (!isPoll) setPkgLoading(true);

    return axios
      .get(`${API_BASE_URL}/company/module-packages`)
      .then((res) => setPkgList(res.data.packages || []))
      .catch((err) => console.error("Module Packages API Error :", err))
      .finally(() => {
        if (!isPoll) setPkgLoading(false);
      });
  }, []);

  useEffect(() => {
    fetchData();
    fetchPackages();
  }, [fetchData, fetchPackages]);

  // The Super Admin edits subscription / pricing / access from a different
  // session — polling reflects that here without a manual refresh.
  usePolling(fetchData, POLL_MS);
  usePolling(() => fetchPackages(true), POLL_MS);

  const latestPayment = payments[0] || null;
  const paymentStatus = subscription ? computePaymentStatus(subscription, latestPayment) : null;
  const activePackages = pkgList.filter((p) => p.owned && p.enabled);

  return (
    <div>
      <PageHeader
        eyebrow="Account"
        title="Current Plan"
        description="Your company's subscription status — scoped to your account only."
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

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <p className="text-xs font-medium text-ink-500">Current Plan</p>
              <p className="mt-1 text-sm font-medium text-ink-100">{subscription.plan_name}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-ink-500">Subscription Status</p>
              <div className="mt-1.5">
                <StatusBadge status={subscription.status} />
              </div>
            </div>
            <div>
              <p className="text-xs font-medium text-ink-500">Monthly / Yearly Amount</p>
              <p className="mt-1 font-mono text-sm text-ink-100">
                {formatAmount(subscription.amount)} <span className="text-ink-500">/ {subscription.billing_cycle}</span>
              </p>
            </div>

            <div className="sm:col-span-2 lg:col-span-3">
              <p className="text-xs font-medium text-ink-500">Active Packages</p>
              {pkgLoading ? (
                <p className="mt-1 text-sm text-ink-500">Loading…</p>
              ) : activePackages.length > 0 ? (
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {activePackages.map((p) => (
                    <span
                      key={p.package_key}
                      className="inline-flex items-center gap-1.5 rounded-md border border-accent-cyan/30 bg-accent-cyan/10 px-2.5 py-1 text-xs font-medium text-accent-cyan"
                    >
                      <CheckCircle2 size={12} />
                      {p.name}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="mt-1 text-sm text-ink-400">
                  No packages active. See Billing &amp; Payment for what's available.
                </p>
              )}
            </div>

            <div>
              <p className="text-xs font-medium text-ink-500">Subscription Expiry / Next Due Date</p>
              <p className="mt-1 text-sm text-ink-100">{subscription.next_due_date || "—"}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-ink-500">Remaining Days</p>
              <p className="mt-1 flex items-center gap-1.5 text-sm font-medium text-ink-100">
                <Clock size={14} className="text-ink-500" />
                {remainingDaysLabel(subscription.next_due_date)}
              </p>
            </div>
            <div>
              <p className="text-xs font-medium text-ink-500">Payment Status</p>
              <div className="mt-1.5">
                <PaymentStatusBadge status={paymentStatus} />
              </div>
            </div>

            <div>
              <p className="text-xs font-medium text-ink-500">Last Payment Amount</p>
              <p className="mt-1 font-mono text-sm text-ink-100">
                {latestPayment ? formatAmount(latestPayment.amount) : "—"}
              </p>
            </div>
            <div>
              <p className="text-xs font-medium text-ink-500">Last Payment Date</p>
              <p className="mt-1 text-sm text-ink-100">{latestPayment?.paid_on || "—"}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-ink-500">Payment Method</p>
              <p className="mt-1 text-sm text-ink-100">{latestPayment?.method || "—"}</p>
            </div>

            {subscription.notes && (
              <div className="sm:col-span-2 lg:col-span-3">
                <p className="text-xs font-medium text-ink-500">Notes</p>
                <p className="mt-1 text-sm text-ink-300">{subscription.notes}</p>
              </div>
            )}
          </div>
        </GlassCard>
      )}
    </div>
  );
}
