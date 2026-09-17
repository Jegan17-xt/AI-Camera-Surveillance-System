// Shared by the split Subscription & Payment pages (admin/pages/{CurrentPlan,
// BillingPayment,PaymentHistory}.jsx) — each is its own route/page (no shared
// anchor-scroll, no shared state), but the small presentational bits below
// (money formatting, the payment-status pill) are identical across them, so
// they live here once instead of being duplicated per page.

export const POLL_MS = 15000;

export const formatAmount = (amount) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(amount || 0);

const paymentStatusTone = {
  Paid: "bg-signal-green/10 text-signal-green border-signal-green/30",
  Pending: "bg-signal-amber/10 text-signal-amber border-signal-amber/30",
  Overdue: "bg-signal-red/10 text-signal-red border-signal-red/30",
};

export function PaymentStatusBadge({ status }) {
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
