import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import { Loader2, AlertTriangle, Building2, Video, HardDrive } from "lucide-react";
import AdminPageHeader from "../ui/AdminPageHeader";
import AdminSearchInput from "../ui/AdminSearchInput";
import AdminCard from "../ui/AdminCard";

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

// Every company's billing standing in one table — a superset view over
// the same per-company Subscription/Payment/SubscriptionItem records
// AdminSubscriptions.jsx (manual override) and the Company Admin's own
// checkout page both read/write. Read-only here; click a row for the
// full breakdown on AdminCompanyDetails.jsx's new Billing section.
export default function AdminBillingOverview() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);

    axios
      .get("http://localhost:5000/billing/overview")
      .then((res) => setCompanies(res.data.companies || []))
      .catch((err) => {
        console.error("Billing Overview API Error :", err);
        setError("Unable to load billing overview. Please check the server and try again.");
      })
      .finally(() => setLoading(false));
  }, []);

  const filtered = companies.filter((c) => c.customer_name.toLowerCase().includes(query.toLowerCase()));

  return (
    <div>
      <AdminPageHeader
        eyebrow="Billing"
        title="Billing Overview"
        description="Every company's plan, active items, usage, and payment standing — independent per company, click a row for the full breakdown."
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
            <p className="text-xs">Loading billing overview…</p>
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
            <table className="w-full min-w-[1180px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-admin-accent/10 text-xs uppercase tracking-wide text-ink-500">
                  <th className="px-3 py-3 font-medium">Company</th>
                  <th className="px-3 py-3 font-medium">Plan</th>
                  <th className="px-3 py-3 font-medium">Active Items</th>
                  <th className="px-3 py-3 font-medium">Cameras</th>
                  <th className="px-3 py-3 font-medium">Storage</th>
                  <th className="px-3 py-3 font-medium">Monthly</th>
                  <th className="px-3 py-3 font-medium">Yearly</th>
                  <th className="px-3 py-3 font-medium">Next Billing</th>
                  <th className="px-3 py-3 font-medium">Status</th>
                  <th className="px-3 py-3 font-medium">Total Paid</th>
                  <th className="px-3 py-3 font-medium">Latest Transaction</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <tr
                    key={c.customer_id}
                    onClick={() => navigate(`/super-admin/company-management/${c.customer_id}/details`)}
                    className="cursor-pointer border-b border-white/5 hover:bg-white/[0.03] transition"
                  >
                    <td className="px-3 py-3 font-medium text-ink-100">{c.customer_name}</td>
                    <td className="px-3 py-3 text-ink-200">{c.plan_name}</td>
                    <td className="px-3 py-3 max-w-[220px] truncate text-xs text-ink-400" title={c.active_items.join(", ")}>
                      {c.active_items.length > 0 ? c.active_items.join(", ") : "—"}
                    </td>
                    <td className="px-3 py-3">
                      <span className="inline-flex items-center gap-1 font-mono text-xs text-ink-300">
                        <Video size={12} /> {c.camera_count}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <span className="inline-flex items-center gap-1 font-mono text-xs text-ink-300">
                        <HardDrive size={12} /> {c.storage_gb} GB
                      </span>
                    </td>
                    <td className="px-3 py-3 font-mono text-xs text-ink-300">
                      {c.monthly_amount > 0 ? formatAmount(c.monthly_amount) : "—"}
                    </td>
                    <td className="px-3 py-3 font-mono text-xs text-ink-300">
                      {c.yearly_amount > 0 ? formatAmount(c.yearly_amount) : "—"}
                    </td>
                    <td className="px-3 py-3 text-xs text-ink-400">{c.next_due_date || "—"}</td>
                    <td className="px-3 py-3">
                      <PaymentStatusBadge status={c.payment_status} />
                    </td>
                    <td className="px-3 py-3 font-mono text-xs text-signal-green">{formatAmount(c.total_paid)}</td>
                    <td className="px-3 py-3 text-xs text-ink-400">
                      {c.latest_transaction ? (
                        <>
                          {formatAmount(c.latest_transaction.amount)}
                          <span className="text-ink-600"> · {c.latest_transaction.paid_on}</span>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}

                {companies.length === 0 && (
                  <tr>
                    <td colSpan={11} className="px-3 py-16 text-center text-ink-500">
                      <div className="flex flex-col items-center gap-2">
                        <Building2 size={22} />
                        <p>No companies found.</p>
                      </div>
                    </td>
                  </tr>
                )}

                {companies.length > 0 && filtered.length === 0 && (
                  <tr>
                    <td colSpan={11} className="px-3 py-12 text-center text-ink-500">
                      No companies match “{query}”.
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
