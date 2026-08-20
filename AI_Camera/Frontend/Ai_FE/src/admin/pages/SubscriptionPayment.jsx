import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { CreditCard, Receipt, Loader2, AlertTriangle, Download, Clock, ShoppingCart, CheckCircle2, Lock, Unlock } from "lucide-react";
import PageHeader from "../../components/ui/PageHeader";
import GlassCard from "../../components/ui/GlassCard";
import StatusBadge from "../../components/ui/StatusBadge";
import Modal from "../../components/ui/Modal";
import Toast from "../../components/ui/Toast";
import { usePolling } from "../../lib/usePolling";
import { useAuth } from "../../context/AuthContext";

// View-only Current Plan / Payment History for the Company Admin, PLUS
// a "Choose Billing Cycle & Pay" flow over every catalog item — every
// item, module or not, is VIEW ONLY here: a Company Admin can see
// which ones are unlocked/locked and what each costs, but can never
// tick/untick one themselves. "AI / Camera Modules" unlock via module
// access (Frontend/.../AdminCustomers.jsx's permission grid ->
// PUT /users/<id>/permissions); Additional Camera, Cloud Storage,
// Platform Hosting, and the WhatsApp items unlock via the Super
// Admin's per-company ON/OFF lock (Backend/api/billing.py's
// set_item_access). Whichever items are currently unlocked are
// automatically included in the Total Amount below and in whatever
// this company pays for, computed server-side in checkout() — this
// page just mirrors that truth. GET /company/checkout-context +
// POST /company/checkout are the ONLY things that ever write to this
// company's own Subscription/Payment/notification settings —
// completely independent of any other company's own checkout.
const POLL_MS = 15000;

const CATEGORY_ORDER = [
  "AI / Camera Modules",
  "Camera / Hardware",
  "Storage",
  "Hosting / Infrastructure",
  "Notifications / Communication",
];

const formatAmount = (amount) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(amount || 0);

const paymentStatusTone = {
  Paid: "bg-signal-green/10 text-signal-green border-signal-green/30",
  Pending: "bg-signal-amber/10 text-signal-amber border-signal-amber/30",
  Overdue: "bg-signal-red/10 text-signal-red border-signal-red/30",
};

function PaymentStatusBadge({ status }) {
  if (!status) return <span className="text-sm text-ink-500">—</span>;

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium font-mono tracking-wide ${
        paymentStatusTone[status] || "bg-ink-500/10 text-ink-500 border-ink-500/30"
      }`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {status}
    </span>
  );
}

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

function invoiceNumber(paymentId) {
  return `INV-${String(paymentId).padStart(6, "0")}`;
}

function quantityLabel(item) {
  if (item.unit_type === "per_camera") return `${item.quantity} camera${item.quantity === 1 ? "" : "s"}`;
  if (item.unit_type === "per_gb") return `${item.quantity.toFixed(3)} GB`;
  return null;
}

export default function SubscriptionPayment() {
  const { user, updateUser } = useAuth();

  const [subscription, setSubscription] = useState(null);
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Choose Items & Pay
  const [checkoutItems, setCheckoutItems] = useState([]);
  const [taxPercent, setTaxPercent] = useState(0);
  const [billingCycle, setBillingCycle] = useState("Monthly");
  const [selectedKeys, setSelectedKeys] = useState(new Set());
  const [checkoutLoading, setCheckoutLoading] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState(null);
  const [toast, setToast] = useState(null);

  const fetchData = useCallback(() => {
    setError(null);

    return Promise.all([
      axios.get("http://localhost:5000/company/subscription"),
      axios.get("http://localhost:5000/company/payments"),
    ])
      .then(([subscriptionRes, paymentsRes]) => {
        setSubscription(subscriptionRes.data.subscription);
        setPayments(paymentsRes.data.payments || []);
      })
      .catch((err) => {
        console.error("Subscription & Payment API Error :", err);
        setError("Unable to load your subscription details. Please check the server and try again.");
      })
      .finally(() => setLoading(false));
  }, []);

  // Every item here — module or not — is Super-Admin-gated and has no
  // Company-Admin-facing checkbox: a module is "in" when granted
  // (currently_active), a non-module item (Additional Camera, Cloud
  // Storage, Platform Hosting, WhatsApp items) is "in" whenever the
  // Super Admin's per-company lock is on (access_enabled !== false —
  // Backend/api/billing.py's set_item_access), regardless of whether a
  // past checkout ever included it. So selection is always re-derived
  // fresh from the server on every fetch, poll included — there is no
  // in-progress Admin choice here to preserve.
  const isAutoSelected = (item) =>
    item.always_active || (item.activation_type === "module" ? item.currently_active : item.access_enabled !== false);

  const fetchCheckoutContext = useCallback((isPoll = false) => {
    if (!isPoll) setCheckoutLoading(true);

    return axios
      .get("http://localhost:5000/company/checkout-context")
      .then((res) => {
        const items = res.data.items || [];
        setCheckoutItems(items);
        setBillingCycle(res.data.billing_cycle || "Monthly");
        setTaxPercent(res.data.tax_percent || 0);
        setSelectedKeys(new Set(items.filter(isAutoSelected).map((i) => i.item_key)));
      })
      .catch((err) => console.error("Checkout Context API Error :", err))
      .finally(() => {
        if (!isPoll) setCheckoutLoading(false);
      });
  }, []);

  useEffect(() => {
    fetchData();
    fetchCheckoutContext();
  }, [fetchData, fetchCheckoutContext]);

  // The Super Admin edits Subscription/Payment/pricing from a
  // completely different session — polling picks that up.
  usePolling(fetchData, POLL_MS);

  // checkout-context carries the per-item monthly/yearly prices the
  // Super Admin edits on Billing & Pricing (AdminBillingPricing.jsx) —
  // same cross-session reasoning as fetchData above, so it needs its
  // own poll to reflect a price change without a manual refresh.
  usePolling(() => fetchCheckoutContext(true), POLL_MS);

  const priceField = billingCycle === "Yearly" ? "yearly_price" : "monthly_price";

  // Billed line items exclude the always-active guard modules (Dashboard,
  // Subscription & Payment) — those are granted free and never charged.
  // Every other item here is included/excluded purely by whether the
  // Super Admin unlocked it (selectedKeys, synced from isAutoSelected
  // above) — never by anything the Admin ticked, since nothing on this
  // page has a checkbox.
  const billedItems = checkoutItems.filter((i) => selectedKeys.has(i.item_key) && !i.always_active);
  const includedFreeItems = checkoutItems.filter((i) => i.always_active);
  const subtotal = billedItems.reduce((sum, i) => sum + i.quantity * (i[priceField] || 0), 0);
  const taxAmount = subtotal * taxPercent / 100;
  const total = subtotal + taxAmount;

  const grouped = CATEGORY_ORDER.map((category) => ({
    category,
    rows: checkoutItems.filter((i) => i.category === category),
  })).filter((g) => g.rows.length > 0);

  const openConfirm = () => {
    setPayError(null);
    setConfirmOpen(true);
  };

  const handlePay = () => {
    setPaying(true);
    setPayError(null);

    axios
      .post("http://localhost:5000/company/checkout", {
        item_keys: billedItems.map((i) => i.item_key),
        billing_cycle: billingCycle,
      })
      .then(() => {
        setConfirmOpen(false);
        setToast({ type: "success", message: "Payment successful — your items are now active." });
        fetchData();
        fetchCheckoutContext();

        // Refresh this session's own module list immediately (same
        // pattern Profile.jsx already uses after a profile change) so
        // the sidebar reflects newly-purchased modules without a
        // re-login.
        axios
          .get("http://localhost:5000/me")
          .then((res) => updateUser(res.data.user))
          .catch(() => {});
      })
      .catch((err) => {
        setPayError(err.response?.data?.message || "Payment failed. Please try again.");
      })
      .finally(() => setPaying(false));
  };

  const latestPayment = payments[0] || null;
  const paymentStatus = subscription ? computePaymentStatus(subscription, latestPayment) : null;

  return (
    <div>
      <PageHeader
        eyebrow="Account"
        title="Subscription & Payment"
        description="Choose the items you need, see the total update live, and pay — your selection, amount, and history belong only to your account."
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

      {/* Current Plan appears first — billing cycle / item selection
          below is a decision the Admin makes only after seeing their
          current standing. */}
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

            <div>
              <p className="text-xs font-medium text-ink-500">Subscription Start Date</p>
              <p className="mt-1 text-sm text-ink-100">—</p>
              <p className="mt-0.5 text-[11px] text-ink-600">Not tracked by the subscription system.</p>
            </div>
            <div>
              <p className="text-xs font-medium text-ink-500">Subscription Expiry Date</p>
              <p className="mt-1 text-sm text-ink-100">{subscription.next_due_date || "—"}</p>
              <p className="mt-0.5 text-[11px] text-ink-600">Same recorded date as Next Due Date below.</p>
            </div>
            <div>
              <p className="text-xs font-medium text-ink-500">Next Due Date</p>
              <p className="mt-1 text-sm text-ink-100">{subscription.next_due_date || "—"}</p>
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

            <div>
              <p className="text-xs font-medium text-ink-500">Payment Status</p>
              <div className="mt-1.5">
                <PaymentStatusBadge status={paymentStatus} />
              </div>
            </div>
            <div className="sm:col-span-2">
              <p className="text-xs font-medium text-ink-500">Remaining Days</p>
              <p className="mt-1 flex items-center gap-1.5 text-sm font-medium text-ink-100">
                <Clock size={14} className="text-ink-500" />
                {remainingDaysLabel(subscription.next_due_date)}
              </p>
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

      {!checkoutLoading && checkoutItems.length > 0 && (
        <GlassCard className="mt-4 p-5">
          <div className="mb-4 flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-cyan/10 text-accent-cyan">
              <ShoppingCart size={19} />
            </span>
            <div>
              <p className="font-display text-sm font-semibold text-white">Choose Items & Billing Cycle</p>
              <p className="text-xs text-ink-500">
                Every item below is priced and unlocked or locked by your platform's Super Admin — pick a billing
                cycle and pay for whatever's currently unlocked.
              </p>
            </div>
          </div>

          <div className="mb-5 inline-flex rounded-lg border border-white/10 p-1">
            {["Monthly", "Yearly"].map((cycle) => (
              <button
                key={cycle}
                type="button"
                onClick={() => setBillingCycle(cycle)}
                className={`rounded-md px-4 py-1.5 text-sm font-medium transition ${
                  billingCycle === cycle ? "bg-accent-cyan/15 text-accent-cyan" : "text-ink-400 hover:text-ink-100"
                }`}
              >
                {cycle}
              </button>
            ))}
          </div>

          {grouped.map(({ category, rows }) => (
            <div key={category} className="mb-5 last:mb-0">
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-500">{category}</p>
              <div className="divide-y divide-white/5">
                {rows.map((item) => {
                  const qtyLabel = quantityLabel(item);
                  const lineTotal = item.quantity * (item[priceField] || 0);
                  const isModule = item.activation_type === "module";
                  // No item on this page has ever had a Company-Admin
                  // checkbox — a module is unlocked/locked by its
                  // permission grant, a non-module item (Additional
                  // Camera, Cloud Storage, Platform Hosting, WhatsApp
                  // items) by the Super Admin's per-company ON/OFF lock
                  // (Backend/api/billing.py's set_item_access,
                  // surfaced here as access_enabled). Both render the
                  // exact same lock/unlock status row.
                  const unlocked = item.always_active || (isModule ? item.currently_active : item.access_enabled !== false);

                  return (
                    <div
                      key={item.item_key}
                      className={`flex items-start justify-between gap-4 py-2.5 ${
                        item.always_active || !unlocked ? "opacity-70" : ""
                      }`}
                    >
                      <span className="flex items-start gap-2 text-sm text-ink-100">
                        {unlocked ? (
                          <Unlock size={16} className="mt-0.5 shrink-0 text-signal-green" />
                        ) : (
                          <Lock size={16} className="mt-0.5 shrink-0 text-ink-500" />
                        )}
                        <span>
                          <span className="flex items-center gap-2">
                            {item.name}
                            {item.always_active && <span className="text-[11px] text-ink-500">(Always included)</span>}
                            {!item.always_active && (
                              <span className={`text-[11px] ${unlocked ? "text-signal-green" : "text-ink-500"}`}>
                                {unlocked
                                  ? "(Unlocked by Super Admin)"
                                  : isModule
                                  ? "(Locked — assign via Super Admin)"
                                  : "(Locked by Super Admin)"}
                              </span>
                            )}
                          </span>
                          {item.description && <span className="block text-xs text-ink-500">{item.description}</span>}
                          {qtyLabel && (
                            <span className="block font-mono text-[11px] text-ink-500">
                              Your usage: {qtyLabel} × {formatAmount(item[priceField])}
                            </span>
                          )}
                        </span>
                      </span>
                      <span className="shrink-0 whitespace-nowrap font-mono text-xs text-ink-300">
                        {item.always_active ? "Free" : formatAmount(lineTotal)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          <div className="mt-5 space-y-1.5 border-t border-white/10 pt-4">
            <div className="flex items-center justify-between text-sm text-ink-400">
              <span>Subtotal</span>
              <span className="font-mono">{formatAmount(subtotal)}</span>
            </div>
            {taxPercent > 0 && (
              <div className="flex items-center justify-between text-sm text-ink-400">
                <span>Tax ({taxPercent}%)</span>
                <span className="font-mono">{formatAmount(taxAmount)}</span>
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <p className="text-sm text-ink-300">
                Total ({billingCycle}) — <span className="font-mono text-base font-semibold text-white">{formatAmount(total)}</span>
              </p>
              <button
                type="button"
                onClick={openConfirm}
                disabled={billedItems.length === 0}
                className="rounded-md bg-accent-cyan px-5 py-2.5 text-sm font-semibold text-black transition hover:bg-accent-cyan/90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Proceed to Payment
              </button>
            </div>
          </div>
        </GlassCard>
      )}

      {!loading && !error && subscription && (
        <>
          <GlassCard className="mt-4 p-5">
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
                            : subscription.plan_name}
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
        </>
      )}

      {/* Payment Gateway (simulated) */}
      <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Payment Gateway" size="lg">
        <div className="space-y-5">
          <div className="rounded-lg border border-white/10 p-4">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-500">Billing To</p>
            <p className="text-sm font-medium text-ink-100">{user?.name}</p>
            <p className="text-xs text-ink-400">{user?.email}</p>
          </div>

          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-500">Order Summary</p>
            <div className="divide-y divide-white/5 rounded-lg border border-white/10">
              {billedItems.map((item) => {
                const qtyLabel = quantityLabel(item);
                return (
                  <div key={item.item_key} className="flex items-center justify-between px-4 py-2.5 text-sm">
                    <span className="text-ink-200">
                      {item.name}
                      {qtyLabel && <span className="ml-1.5 text-xs text-ink-500">({qtyLabel})</span>}
                    </span>
                    <span className="font-mono text-ink-300">{formatAmount(item.quantity * (item[priceField] || 0))}</span>
                  </div>
                );
              })}
              {includedFreeItems.map((item) => (
                <div key={item.item_key} className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <span className="text-ink-400">{item.name} <span className="text-[11px]">(included free)</span></span>
                  <span className="font-mono text-ink-500">—</span>
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg bg-white/5 px-4 py-3">
            <span className="text-sm text-ink-300">Billing Cycle</span>
            <span className="text-sm font-medium text-ink-100">{billingCycle}</span>
          </div>

          <div className="space-y-1.5 rounded-lg bg-white/5 px-4 py-3">
            <div className="flex items-center justify-between text-sm text-ink-300">
              <span>Subtotal</span>
              <span className="font-mono">{formatAmount(subtotal)}</span>
            </div>
            {taxPercent > 0 && (
              <div className="flex items-center justify-between text-sm text-ink-300">
                <span>Tax ({taxPercent}%)</span>
                <span className="font-mono">{formatAmount(taxAmount)}</span>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between rounded-lg bg-accent-cyan/10 px-4 py-3">
            <span className="text-sm font-medium text-white">Total Due</span>
            <span className="font-mono text-lg font-semibold text-accent-cyan">{formatAmount(total)}</span>
          </div>

          {payError && (
            <div className="flex items-start gap-2 rounded-md border border-signal-red/30 bg-signal-red/10 px-3.5 py-2.5 text-xs text-signal-red">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{payError}</span>
            </div>
          )}

          <p className="text-[11px] text-ink-600">
            Simulated payment gateway — no real charge is made. This confirms item activation for your account only.
          </p>

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setConfirmOpen(false)}
              disabled={paying}
              className="rounded-md px-4 py-2.5 text-sm font-medium text-ink-300 hover:bg-white/5"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handlePay}
              disabled={paying}
              className="inline-flex items-center gap-2 rounded-md bg-accent-cyan px-5 py-2.5 text-sm font-semibold text-black transition hover:bg-accent-cyan/90 disabled:opacity-60"
            >
              {paying ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
              {paying ? "Processing…" : "Pay Now"}
            </button>
          </div>
        </div>
      </Modal>

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
