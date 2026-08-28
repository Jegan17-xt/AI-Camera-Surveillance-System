import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import axios from "axios";
import { API_BASE_URL } from "../../lib/apiBase";
import {
  ArrowLeft,
  Building2,
  Camera,
  Loader2,
  AlertTriangle,
  UserRound,
  Receipt,
  HardDrive,
  Video,
  Boxes,
  Save,
  ScanFace,
  UserX,
  FileText,
} from "lucide-react";
import AdminPageHeader from "../ui/AdminPageHeader";
import AdminCard from "../ui/AdminCard";
import AdminButton from "../ui/AdminButton";
import AdminBadge from "../ui/AdminBadge";
import AdminToast from "../ui/AdminToast";

const formatGb = (gb) => `${(gb ?? 0).toFixed(2)} GB`;

const formatAmount = (amount) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(amount || 0);

// Read-only Company Admin profile + a real Users/Cameras/Storage usage
// rollup — company-wide AND per-User — computed server-side from actual
// DB rows and files on disk (Backend/api/admin_overview.py), the same
// source AdminOverview*.jsx's separate flow already uses. Nothing here
// can create/edit/delete a User (that stays the Company Admin's own
// job, see Backend/api/company_users.py) — the one writable field is
// the storage cap, a Super-Admin-only setting. Module access/pricing is
// edited from AdminCustomers.jsx's Edit modal, not this page.
export default function AdminCompanyDetails() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [subscriptionStatus, setSubscriptionStatus] = useState(null);

  const [billing, setBilling] = useState(null);
  const [billingLoading, setBillingLoading] = useState(true);
  const [billingError, setBillingError] = useState(null);

  const [limitInput, setLimitInput] = useState("");
  const [savingLimit, setSavingLimit] = useState(false);

  // Camera Limit / Camera Quota Management — same pattern as the storage
  // cap above, against PUT /admin-overview/companies/:id/camera-limit.
  const [cameraLimitInput, setCameraLimitInput] = useState("");
  const [savingCameraLimit, setSavingCameraLimit] = useState(false);

  const fetchOverview = () => {
    setLoading(true);
    setError(null);

    return axios
      .get(`${API_BASE_URL}/admin-overview/companies/${id}`)
      .then((res) => {
        setOverview(res.data);
        setLimitInput(res.data.storage_limit_gb ?? "");
        setCameraLimitInput(res.data.camera_quota?.camera_limit ?? "");
      })
      .catch((err) => {
        console.error("Admin Overview API Error :", err);
        setError("Unable to load this Company Admin. Please check the server and try again.");
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchOverview();

    // Reuses the same "every company's subscription" endpoint the
    // Subscription & Payment page lists from, filtered down to this one
    // company — no separate single-company subscription route exists yet.
    axios
      .get(`${API_BASE_URL}/subscriptions`)
      .then((res) => {
        const match = (res.data.subscriptions || []).find((s) => String(s.customer_id) === String(id));
        setSubscriptionStatus(match ? match.status : null);
      })
      .catch((err) => {
        console.error("Subscriptions API Error :", err);
      });

    setBillingLoading(true);
    setBillingError(null);

    axios
      .get(`${API_BASE_URL}/billing/overview/${id}`)
      .then((res) => setBilling(res.data))
      .catch((err) => {
        console.error("Billing Detail API Error :", err);
        setBillingError("Unable to load this company's billing details. Please check the server and try again.");
      })
      .finally(() => setBillingLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const saveLimit = () => {
    setSavingLimit(true);

    const value = limitInput === "" ? null : Number(limitInput);

    axios
      .put(`${API_BASE_URL}/admin-overview/companies/${id}/storage-limit`, { storage_limit_gb: value })
      .then((res) => {
        setOverview((prev) => ({ ...prev, ...res.data }));
        setToast({ type: "success", message: "Storage limit updated." });
      })
      .catch((err) => {
        console.error("Storage Limit Update API Error :", err);
        setToast({ type: "error", message: err.response?.data?.message || "Failed to update storage limit." });
      })
      .finally(() => setSavingLimit(false));
  };

  const saveCameraLimit = () => {
    setSavingCameraLimit(true);

    const value = cameraLimitInput === "" ? null : Number(cameraLimitInput);

    axios
      .put(`${API_BASE_URL}/admin-overview/companies/${id}/camera-limit`, { camera_limit: value })
      .then((res) => {
        setOverview((prev) => ({ ...prev, ...res.data }));
        setToast({ type: "success", message: "Camera limit updated." });
      })
      .catch((err) => {
        console.error("Camera Limit Update API Error :", err);
        setToast({ type: "error", message: err.response?.data?.message || "Failed to update camera limit." });
      })
      .finally(() => setSavingCameraLimit(false));
  };

  const hasLimit = overview && overview.storage_limit_gb !== null && overview.storage_limit_gb !== undefined;

  return (
    <div>
      <AdminPageHeader
        eyebrow="Company Admins"
        title="Company Details"
        description="Real usage for this Company Admin and every User under them."
        actions={
          <AdminButton variant="ghost" icon={ArrowLeft} onClick={() => navigate("/super-admin/company-management")}>
            Back to Company Admins
          </AdminButton>
        }
      />

      {loading && (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-ink-500">
          <Loader2 size={22} className="animate-spin text-admin-accent" />
          <p className="text-xs">Loading company…</p>
        </div>
      )}

      {!loading && error && (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center text-ink-500">
          <AlertTriangle size={22} className="text-red-400" />
          <p className="text-xs">{error}</p>
        </div>
      )}

      {!loading && !error && overview && (
        <>
          {/* Company Information */}
          <AdminCard className="p-4 sm:p-5">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Company Information</p>
              <AdminButton
                variant="secondary"
                icon={Camera}
                onClick={() => navigate(`/super-admin/company-management/${id}`)}
                className="whitespace-nowrap"
              >
                Manage Cameras
              </AdminButton>
            </div>

            <div className="flex items-start gap-3 border-b border-white/5 pb-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-white/[0.04] text-admin-accent">
                <Building2 size={20} strokeWidth={2} />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <p className="font-display text-lg font-semibold text-white">{overview.name}</p>
                  <AdminBadge status={overview.status} />
                </div>
                <p className="text-xs text-ink-500">{overview.email}</p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-x-6 gap-y-4 pt-4 sm:grid-cols-2">
              <div>
                <p className="text-xs uppercase tracking-wide text-ink-500">Username</p>
                <p className="mt-1 font-mono text-sm text-ink-100">{overview.username}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-ink-500">Phone Number</p>
                <p className="mt-1 text-sm text-ink-100">{overview.phone_number || "—"}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-ink-500">Subscription Status</p>
                <div className="mt-1">
                  {subscriptionStatus ? <AdminBadge status={subscriptionStatus} /> : <p className="text-sm text-ink-500">—</p>}
                </div>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-ink-500">Modules Enabled</p>
                <p className="mt-1 font-mono text-sm text-ink-100">{overview.modules_enabled?.length ?? 0}</p>
              </div>
            </div>
          </AdminCard>

          {/* Usage & Storage Summary */}
          <p className="mb-3 mt-6 text-xs font-medium uppercase tracking-wide text-ink-500">Usage &amp; Storage Summary</p>

          <AdminCard className="p-4 sm:p-5">
            <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
              <div>
                <p className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-ink-500">
                  <Video size={12} /> Cameras
                </p>
                <p className="mt-1 font-mono text-sm text-ink-100">{overview.camera_count}</p>
              </div>
              <div>
                <p className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-ink-500">
                  <UserRound size={12} /> Users
                </p>
                <p className="mt-1 font-mono text-sm text-ink-100">{overview.user_count}</p>
              </div>
              <div>
                <p className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-ink-500">
                  <ScanFace size={12} /> Registered Persons
                </p>
                <p className="mt-1 font-mono text-sm text-ink-100">{overview.registered_persons_count}</p>
              </div>
              <div>
                <p className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-ink-500">
                  <Boxes size={12} /> Total Storage Used
                </p>
                <p className="mt-1 font-mono text-sm text-ink-100">{formatGb(overview.storage_used_gb)}</p>
              </div>
            </div>

            <div className="mt-5 border-t border-white/5 pt-4">
              <p className="mb-3 flex items-center gap-1.5 text-xs uppercase tracking-wide text-ink-500">
                <HardDrive size={12} /> Storage By Category (company-wide, incl. unassigned)
              </p>
              <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
                <div>
                  <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-ink-500">
                    <ScanFace size={11} /> Registered Faces
                  </p>
                  <p className="mt-1 font-mono text-sm text-ink-100">
                    {formatGb(overview.storage_breakdown?.registered_persons?.gb)}
                  </p>
                  <p className="text-[11px] text-ink-600">{overview.storage_breakdown?.registered_persons?.count ?? 0} persons</p>
                </div>
                <div>
                  <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-ink-500">
                    <FileText size={11} /> Attendance
                  </p>
                  <p className="mt-1 font-mono text-sm text-ink-100">{formatGb(overview.storage_breakdown?.attendance?.gb)}</p>
                  <p className="text-[11px] text-ink-600">{overview.storage_breakdown?.attendance?.count ?? 0} records</p>
                </div>
                <div>
                  <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-ink-500">
                    <UserX size={11} /> Unknown Persons
                  </p>
                  <p className="mt-1 font-mono text-sm text-ink-100">
                    {formatGb(overview.storage_breakdown?.unknown_persons?.gb)}
                  </p>
                  <p className="text-[11px] text-ink-600">{overview.storage_breakdown?.unknown_persons?.count ?? 0} captures</p>
                </div>
                <div>
                  <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-ink-500">
                    <Receipt size={11} /> Reports
                  </p>
                  <p className="mt-1 font-mono text-sm text-ink-100">{formatGb(overview.storage_breakdown?.reports?.gb)}</p>
                  <p className="text-[11px] text-ink-600">{overview.storage_breakdown?.reports?.count ?? 0} files</p>
                </div>
              </div>
            </div>

            <div className="mt-5 border-t border-white/5 pt-4">
              <p className="mb-3 flex items-center gap-1.5 text-xs uppercase tracking-wide text-ink-500">
                <HardDrive size={12} /> Storage Cap
              </p>
              <div className="flex flex-wrap items-end gap-6">
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-ink-500">Used</p>
                  <p className="mt-1 font-mono text-sm text-ink-100">{formatGb(overview.storage_used_gb)}</p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-ink-500">Remaining</p>
                  <p className="mt-1 font-mono text-sm text-ink-100">
                    {hasLimit ? formatGb(overview.storage_remaining_gb) : "Unlimited"}
                  </p>
                </div>
                <div className="flex items-end gap-2">
                  <div>
                    <label className="text-[11px] uppercase tracking-wide text-ink-500" htmlFor="storage-limit-input">
                      Limit (GB, blank = unlimited)
                    </label>
                    <input
                      id="storage-limit-input"
                      type="number"
                      min="0"
                      step="0.1"
                      value={limitInput}
                      onChange={(e) => setLimitInput(e.target.value)}
                      className="mt-1 w-36 rounded-md admin-panel px-3 py-2 text-sm text-ink-100 outline-none focus:border-admin-accent/50 focus:ring-2 focus:ring-admin-accent/20"
                    />
                  </div>
                  <AdminButton variant="secondary" icon={Save} onClick={saveLimit} disabled={savingLimit}>
                    {savingLimit ? "Saving…" : "Save"}
                  </AdminButton>
                </div>
              </div>
            </div>

            {/* Camera Limit / Camera Quota Management */}
            <div className="mt-5 border-t border-white/5 pt-4">
              <p className="mb-3 flex items-center gap-1.5 text-xs uppercase tracking-wide text-ink-500">
                <Video size={12} /> Camera Cap
                {overview.camera_quota?.status === "Over Limit" && (
                  <span className="rounded-full border border-signal-red/30 bg-signal-red/10 px-2 py-0.5 text-[10px] font-medium normal-case tracking-normal text-signal-red">
                    Over Limit by {overview.camera_quota.over_limit_by}
                  </span>
                )}
              </p>
              <div className="flex flex-wrap items-end gap-6">
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-ink-500">Used</p>
                  <p className="mt-1 font-mono text-sm text-ink-100">{overview.camera_quota?.used ?? 0}</p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-ink-500">Remaining</p>
                  <p className="mt-1 font-mono text-sm text-ink-100">
                    {overview.camera_quota?.camera_limit === null || overview.camera_quota?.camera_limit === undefined
                      ? "Unlimited"
                      : overview.camera_quota.remaining}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-ink-500">Allocated to Users</p>
                  <p className="mt-1 font-mono text-sm text-ink-100">{overview.camera_quota?.allocated_to_users ?? 0}</p>
                </div>
                <div className="flex items-end gap-2">
                  <div>
                    <label className="text-[11px] uppercase tracking-wide text-ink-500" htmlFor="camera-limit-input">
                      Limit (cameras, blank = unlimited)
                    </label>
                    <input
                      id="camera-limit-input"
                      type="number"
                      min="0"
                      step="1"
                      value={cameraLimitInput}
                      onChange={(e) => setCameraLimitInput(e.target.value)}
                      className="mt-1 w-36 rounded-md admin-panel px-3 py-2 text-sm text-ink-100 outline-none focus:border-admin-accent/50 focus:ring-2 focus:ring-admin-accent/20"
                    />
                  </div>
                  <AdminButton variant="secondary" icon={Save} onClick={saveCameraLimit} disabled={savingCameraLimit}>
                    {savingCameraLimit ? "Saving…" : "Save"}
                  </AdminButton>
                </div>
              </div>
            </div>
          </AdminCard>

          {/* Users & Storage Usage — one row per User, full per-category
              breakdown, no drill-down click needed. */}
          <p className="mb-3 mt-6 text-xs font-medium uppercase tracking-wide text-ink-500">Users &amp; Storage Usage</p>

          <AdminCard className="p-4 sm:p-5">
            <div className="custom-scroll overflow-x-auto">
              <table className="w-full min-w-[900px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-admin-accent/10 text-xs uppercase tracking-wide text-ink-500">
                    <th className="px-3 py-3 font-medium">User</th>
                    <th className="px-3 py-3 font-medium">Status</th>
                    <th className="px-3 py-3 font-medium">Cameras</th>
                    <th className="px-3 py-3 font-medium">Registered Persons</th>
                    <th className="px-3 py-3 font-medium">Attendance</th>
                    <th className="px-3 py-3 font-medium">Unknown Persons</th>
                    <th className="px-3 py-3 font-medium">Reports</th>
                    <th className="px-3 py-3 font-medium">Total Storage</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.users.map((u) => (
                    <tr key={u.id} className="border-b border-white/5">
                      <td className="px-3 py-3">
                        <p className="font-medium text-ink-100">{u.name}</p>
                        <p className="text-xs text-ink-500">{u.email}</p>
                      </td>
                      <td className="px-3 py-3">
                        <AdminBadge status={u.status} />
                      </td>
                      <td className={`px-3 py-3 font-mono text-xs ${u.camera_quota?.status === "Over Limit" ? "text-signal-red" : "text-ink-300"}`}>
                        {u.cameras.count}
                        {u.camera_quota?.camera_limit !== null && u.camera_quota?.camera_limit !== undefined && (
                          <span className="text-ink-500"> / {u.camera_quota.camera_limit}</span>
                        )}
                      </td>
                      <td className="px-3 py-3 font-mono text-xs text-ink-300">
                        {u.registered_persons.count} · {formatGb(u.registered_persons.gb)}
                      </td>
                      <td className="px-3 py-3 font-mono text-xs text-ink-300" title={u.attendance.note}>
                        {u.attendance.count} · ~{formatGb(u.attendance.gb_estimated)}
                      </td>
                      <td className="px-3 py-3 font-mono text-xs text-ink-300">
                        {u.unknown_persons.count} · {formatGb(u.unknown_persons.gb)}
                      </td>
                      <td className="px-3 py-3 font-mono text-xs text-ink-300">
                        {u.reports.count} · {formatGb(u.reports.gb)}
                      </td>
                      <td className="px-3 py-3 font-mono text-xs font-semibold text-ink-100">{formatGb(u.total_gb)}</td>
                    </tr>
                  ))}

                  {overview.users.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-3 py-16 text-center text-ink-500">
                        <div className="flex flex-col items-center gap-2">
                          <UserRound size={22} />
                          <p>This company has no Users yet.</p>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-[11px] text-ink-600">
              Attendance storage per User is an estimated proportional share — attendance reports are stored one CSV
              per date for the whole company, not one file per user.
            </p>
          </AdminCard>

          {/* Billing & Payment History */}
          <p className="mb-3 mt-6 text-xs font-medium uppercase tracking-wide text-ink-500">Billing & Payment History</p>

          <AdminCard className="p-4 sm:p-5">
            {billingLoading && (
              <div className="flex flex-col items-center justify-center gap-3 py-16 text-ink-500">
                <Loader2 size={22} className="animate-spin text-admin-accent" />
                <p className="text-xs">Loading billing details…</p>
              </div>
            )}

            {!billingLoading && billingError && (
              <div className="flex flex-col items-center justify-center gap-3 py-16 text-center text-ink-500">
                <AlertTriangle size={22} className="text-red-400" />
                <p className="text-xs">{billingError}</p>
              </div>
            )}

            {!billingLoading && !billingError && billing && (
              <>
                <div className="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <div>
                    <p className="text-xs uppercase tracking-wide text-ink-500">Plan</p>
                    <p className="mt-1 text-sm font-medium text-ink-100">{billing.subscription.plan_name}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wide text-ink-500">Amount</p>
                    <p className="mt-1 font-mono text-sm text-ink-100">
                      {formatAmount(billing.subscription.amount)} / {billing.subscription.billing_cycle}
                    </p>
                  </div>
                  <div>
                    <p className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-ink-500">
                      <Video size={12} /> Cameras
                    </p>
                    <p className="mt-1 font-mono text-sm text-ink-100">{billing.camera_count}</p>
                  </div>
                  <div>
                    <p className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-ink-500">
                      <HardDrive size={12} /> Storage Used
                    </p>
                    <p className="mt-1 font-mono text-sm text-ink-100">{billing.storage_gb} GB</p>
                  </div>
                </div>

                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-500">Active Items</p>
                {billing.active_items.length === 0 ? (
                  <p className="mb-5 text-xs text-ink-500">No items currently active.</p>
                ) : (
                  <div className="mb-5 divide-y divide-white/5 rounded-md border border-white/10">
                    {billing.active_items.map((item) => (
                      <div key={item.item_key} className="flex items-center justify-between px-3 py-2 text-sm">
                        <span className="text-ink-200">
                          {item.item_name} <span className="text-xs text-ink-500">({item.category})</span>
                        </span>
                        <span className="font-mono text-xs text-ink-400">
                          {item.quantity !== 1 ? `${item.quantity.toFixed(2)} × ` : ""}
                          {formatAmount(item.unit_price)} = {formatAmount(item.price)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-ink-500">
                  <Receipt size={12} /> Payment History
                </p>
                {billing.payments.length === 0 ? (
                  <p className="text-xs text-ink-500">No payments logged yet.</p>
                ) : (
                  <div className="custom-scroll overflow-x-auto">
                    <table className="w-full min-w-[600px] border-collapse text-left text-sm">
                      <thead>
                        <tr className="border-b border-admin-accent/10 text-xs uppercase tracking-wide text-ink-500">
                          <th className="px-3 py-2.5 font-medium">Date</th>
                          <th className="px-3 py-2.5 font-medium">Amount</th>
                          <th className="px-3 py-2.5 font-medium">Method</th>
                          <th className="px-3 py-2.5 font-medium">Status</th>
                          <th className="px-3 py-2.5 font-medium">Transaction ID</th>
                        </tr>
                      </thead>
                      <tbody>
                        {billing.payments.map((p) => (
                          <tr key={p.id} className="border-b border-white/5">
                            <td className="px-3 py-2.5 font-mono text-xs text-ink-500">{p.paid_on}</td>
                            <td className="px-3 py-2.5 font-mono text-xs text-signal-green">{formatAmount(p.amount)}</td>
                            <td className="px-3 py-2.5 text-xs text-ink-400">{p.method || "—"}</td>
                            <td className="px-3 py-2.5">
                              <AdminBadge status={p.status || "Success"} />
                            </td>
                            <td className="px-3 py-2.5 font-mono text-xs text-ink-500">{p.transaction_id || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </AdminCard>
        </>
      )}

      <AdminToast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
