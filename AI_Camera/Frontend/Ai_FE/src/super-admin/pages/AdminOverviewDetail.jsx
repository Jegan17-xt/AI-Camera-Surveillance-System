import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import axios from "axios";
import { API_BASE_URL } from "../../lib/apiBase";
import {
  ArrowLeft,
  Building2,
  Loader2,
  AlertTriangle,
  UserRound,
  HardDrive,
  Video,
  Boxes,
  Lock,
  Unlock,
  Save,
  ChevronRight,
  ScanFace,
  CalendarClock,
  Infinity as InfinityIcon,
  Clock3,
  CalendarRange,
} from "lucide-react";
import AdminPageHeader from "../ui/AdminPageHeader";
import AdminCard from "../ui/AdminCard";
import AdminButton from "../ui/AdminButton";
import AdminBadge from "../ui/AdminBadge";
import AdminToast from "../ui/AdminToast";
import AdminToggle from "../ui/AdminToggle";

const formatGb = (gb) => `${(gb ?? 0).toFixed(2)} GB`;

// The 5 non-"module" billing catalog items seeded in
// Backend/api/billing.py's init_billing_tables() — explicit allowlist
// (rather than "every activation_type !== 'module' item") so a future
// custom catalog item a Super Admin adds on AdminBillingPricing.jsx
// doesn't silently show up here without a deliberate decision to add it.
const USAGE_BILLING_ITEM_KEYS = new Set([
  "additional_camera",
  "cloud_storage",
  "platform_hosting",
  "whatsapp_daily_report",
  "whatsapp_unknown_alerts",
]);

// Mirrors Backend/api/retention_settings.py's VALID_POLICIES/RETENTION_DAYS
// exactly — "permanent" is the only policy with automatic deletion
// disabled, and stays the default for every company until a Super Admin
// explicitly opts them into a time-based one.
const RETENTION_OPTIONS = [
  {
    value: "permanent",
    label: "Permanent / Manual Delete",
    icon: InfinityIcon,
    description: "Data stays permanently. Automatic deletion is fully disabled — only an authorized admin's manual delete removes it.",
  },
  {
    value: "7_days",
    label: "7 Days",
    icon: Clock3,
    description: "Automatically deletes captured/generated data older than 7 days, every day. Only the latest 7 days are kept.",
  },
  {
    value: "1_month",
    label: "1 Month",
    icon: CalendarRange,
    description: "Automatically deletes captured/generated data older than 30 days, every day. Only the latest 30 days are kept.",
  },
];

const formatAmount = (amount) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(amount || 0);

// Read-only Admin summary + a real per-User storage breakdown table,
// computed server-side (Backend/api/admin_overview.py) from actual DB
// rows and files on disk. The two writable things on this page are the
// Company Admin's storage cap, and — in "Modules Enabled" below — their
// module access, both Super-Admin-only. Module access reuses the exact
// same permission system AdminCustomers.jsx's Edit modal already writes
// through (GET/PUT /users/:id/permissions) — this is a second view onto
// the same data, never a separate/duplicate permission store.
export default function AdminOverviewDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [limitInput, setLimitInput] = useState("");
  const [savingLimit, setSavingLimit] = useState(false);

  // Camera Limit / Camera Quota Management — same "own writable field on
  // this Admin summary" pattern as the storage limit above, against
  // PUT /admin-overview/companies/:id/camera-limit (Backend/api/
  // admin_overview.py's set_admin_camera_limit — no upstream
  // constraint; reducing below current usage never deletes cameras, it
  // just surfaces "Over Limit" here and blocks new creation server-side).
  const [cameraLimitInput, setCameraLimitInput] = useState("");
  const [savingCameraLimit, setSavingCameraLimit] = useState(false);

  // Modules Enabled — ALL catalog modules (not just currently-granted
  // ones), each with its billing price and lock/unlock state, editable
  // right here by the Super Admin. Kept as its own fetch/state,
  // separate from `detail.modules_enabled` (a read-only GRANTED-only
  // list used elsewhere on this page and on AdminOverview.jsx/
  // AdminCompanyDetails.jsx as a simple count — left untouched).
  const [moduleAccess, setModuleAccess] = useState([]);
  const [moduleLoading, setModuleLoading] = useState(true);
  const [moduleSavingKey, setModuleSavingKey] = useState(null);

  // The catalog's non-"module" items (Additional Camera, Cloud Storage,
  // Platform Hosting, WhatsApp Daily Report, WhatsApp Unknown Person
  // Alerts, plus any custom ones a Super Admin adds later on
  // AdminBillingPricing.jsx) — real usage/price/total, view-only here.
  // These aren't lock/unlock permissions, so they're kept out of the
  // moduleAccess grid above entirely.
  const [usageBillingItems, setUsageBillingItems] = useState([]);
  const [billingSavingKey, setBillingSavingKey] = useState(null);

  // Data Retention — Super-Admin-only, per-Company-Admin auto-delete
  // policy for captured/generated data (Backend/api/retention_settings.py
  // + retention/scheduler.py's daily sweep). Its own fetch/state, kept
  // independent of everything else on this page. Two-value model:
  // retentionPolicy is the last value actually SAVED to the backend;
  // pendingRetentionPolicy is what's selected in the UI right now.
  // Clicking an option only moves pendingRetentionPolicy — the backend
  // value (retentionPolicy) changes ONLY on Save Changes.
  const [retentionPolicy, setRetentionPolicy] = useState("permanent");
  const [pendingRetentionPolicy, setPendingRetentionPolicy] = useState("permanent");
  const [retentionLoading, setRetentionLoading] = useState(true);
  const [retentionSaving, setRetentionSaving] = useState(false);

  const fetchDetail = () => {
    setLoading(true);
    setError(null);

    return axios
      .get(`${API_BASE_URL}/admin-overview/companies/${id}`)
      .then((res) => {
        setDetail(res.data);
        setLimitInput(res.data.storage_limit_gb ?? "");
        setCameraLimitInput(res.data.camera_quota?.camera_limit ?? "");
      })
      .catch((err) => {
        console.error("Admin Overview Detail API Error :", err);
        setError("Unable to load this Company Admin's overview. Please check the server and try again.");
      })
      .finally(() => setLoading(false));
  };

  const fetchModuleAccess = () => {
    setModuleLoading(true);

    return Promise.all([
      axios.get(`${API_BASE_URL}/users/${id}/permissions`),
      // This company's effective price per module (its own override if
      // the Super Admin set one, otherwise the global catalog price) —
      // same resolution AdminBillingPricing.jsx and the Company Admin's
      // own Subscription & Payment page already use.
      axios.get(`${API_BASE_URL}/billing/items`, { params: { customer_id: id } }),
    ])
      .then(([permRes, itemsRes]) => {
        const allItems = itemsRes.data.items || [];

        const priceByModuleKey = Object.fromEntries(
          allItems.filter((item) => item.activation_type === "module").map((item) => [item.activation_ref, item])
        );

        setModuleAccess(
          (permRes.data.permissions || []).map((p) => ({
            ...p,
            monthly_price: priceByModuleKey[p.module_key]?.monthly_price ?? 0,
            yearly_price: priceByModuleKey[p.module_key]?.yearly_price ?? 0,
          }))
        );

        // Usage-Based Billing shows exactly these 5 catalog items (seeded
        // in Backend/api/billing.py's init_billing_tables()) — every
        // other module (locked or unlocked) stays in Module Access only.
        setUsageBillingItems(
          allItems.filter((item) => USAGE_BILLING_ITEM_KEYS.has(item.item_key) && item.enabled)
        );
      })
      .catch((err) => {
        console.error("Module Access API Error :", err);
        setToast({ type: "error", message: "Failed to load module access & billing details." });
      })
      .finally(() => setModuleLoading(false));
  };

  const fetchRetentionSettings = () => {
    setRetentionLoading(true);

    return axios
      .get(`${API_BASE_URL}/users/${id}/retention-settings`)
      .then((res) => {
        const policy = res.data.retention_settings?.policy || "permanent";
        setRetentionPolicy(policy);
        setPendingRetentionPolicy(policy);
      })
      .catch((err) => {
        console.error("Retention Settings API Error :", err);
        setToast({ type: "error", message: "Failed to load data retention settings." });
      })
      .finally(() => setRetentionLoading(false));
  };

  useEffect(() => {
    fetchDetail();
    fetchModuleAccess();
    fetchRetentionSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const toggleModuleAccess = (moduleKey, nextGranted, alwaysActive) => {
    // Dashboard and Subscription & Payment can never be locked — see
    // Backend/auth/database.py's ALWAYS_ACTIVE_MODULE_KEYS. Enforced
    // again server-side regardless of this guard.
    if (alwaysActive) return;

    const previous = moduleAccess;
    const next = moduleAccess.map((m) => (m.module_key === moduleKey ? { ...m, granted: nextGranted } : m));
    setModuleAccess(next);
    setModuleSavingKey(moduleKey);

    const moduleKeys = next.filter((m) => m.granted).map((m) => m.module_key);

    axios
      .put(`${API_BASE_URL}/users/${id}/permissions`, { module_keys: moduleKeys })
      .then((res) => {
        const updated = res.data.permissions || [];
        setModuleAccess((current) =>
          current.map((m) => {
            const match = updated.find((u) => u.module_key === m.module_key);
            return match ? { ...m, granted: match.granted, always_active: match.always_active } : m;
          })
        );
        setToast({ type: "success", message: "Module access updated." });
      })
      .catch((err) => {
        console.error("Module Access Update API Error :", err);
        setModuleAccess(previous);
        setToast({ type: "error", message: err.response?.data?.message || "Failed to update module access." });
      })
      .finally(() => setModuleSavingKey(null));
  };

  // Super-Admin-only ON/OFF lock for one of the 5 Usage-Based Billing
  // cards — mirrors toggleModuleAccess above, but against
  // /billing/items/:itemId/access/:customerId (Backend/api/billing.py's
  // set_item_access) instead of /users/:id/permissions, since these 5
  // items have no permission grant of their own. Locking is enforced
  // server-side (checkout() excludes it, get_checkout_context() forces
  // currently_active false) — this toggle only reflects that state.
  const toggleItemAccess = (item) => {
    const nextEnabled = !item.access_enabled;

    const previous = usageBillingItems;
    setUsageBillingItems((current) =>
      current.map((i) => (i.item_key === item.item_key ? { ...i, access_enabled: nextEnabled } : i))
    );
    setBillingSavingKey(item.item_key);

    axios
      .put(`${API_BASE_URL}/billing/items/${item.id}/access/${id}`, { enabled: nextEnabled })
      .then(() => {
        setToast({ type: "success", message: nextEnabled ? `${item.name} turned ON.` : `${item.name} turned OFF.` });
      })
      .catch((err) => {
        console.error("Billing Item Access Update API Error :", err);
        setUsageBillingItems(previous);
        setToast({ type: "error", message: err.response?.data?.message || "Failed to update billing access." });
      })
      .finally(() => setBillingSavingKey(null));
  };

  // Selecting a card only moves the PENDING value — never calls the
  // backend. The saved value (retentionPolicy) is untouched until Save
  // Changes is clicked below, so navigating away or refreshing without
  // saving leaves the backend exactly as it was.
  const selectRetentionPolicy = (policy) => {
    setPendingRetentionPolicy(policy);
  };

  const saveRetentionSettings = () => {
    if (pendingRetentionPolicy === retentionPolicy) return;

    setRetentionSaving(true);

    axios
      .put(`${API_BASE_URL}/users/${id}/retention-settings`, { policy: pendingRetentionPolicy })
      .then(() => {
        setRetentionPolicy(pendingRetentionPolicy);
        setToast({ type: "success", message: "Data retention settings saved." });
      })
      .catch((err) => {
        console.error("Retention Settings Update API Error :", err);
        setToast({ type: "error", message: err.response?.data?.message || "Failed to save retention settings." });
      })
      .finally(() => setRetentionSaving(false));
  };

  const saveLimit = () => {
    setSavingLimit(true);

    const value = limitInput === "" ? null : Number(limitInput);

    axios
      .put(`${API_BASE_URL}/admin-overview/companies/${id}/storage-limit`, { storage_limit_gb: value })
      .then((res) => {
        setDetail((prev) => ({ ...prev, ...res.data }));
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
        setDetail((prev) => ({ ...prev, ...res.data }));
        setToast({ type: "success", message: "Camera limit updated." });
      })
      .catch((err) => {
        console.error("Camera Limit Update API Error :", err);
        setToast({ type: "error", message: err.response?.data?.message || "Failed to update camera limit." });
      })
      .finally(() => setSavingCameraLimit(false));
  };

  const hasLimit = detail && detail.storage_limit_gb !== null && detail.storage_limit_gb !== undefined;

  // Real quantity for a usage-billing item — same resolution
  // Backend/api/billing.py's _quantity_for() uses at checkout, just read
  // here from the summary this page already fetched (detail.camera_count
  // / detail.storage_used_gb) instead of a second API call.
  const usageFor = (item) => {
    if (item.unit_type === "per_camera") return detail?.camera_count ?? 0;
    if (item.unit_type === "per_gb") return detail?.storage_used_gb ?? 0;
    return 1;
  };

  const usageLabelFor = (item) => {
    const qty = usageFor(item);
    if (item.unit_type === "per_camera") return `${qty} Camera${qty === 1 ? "" : "s"}`;
    if (item.unit_type === "per_gb") return `${qty.toFixed(3)} GB`;
    return "Flat fee";
  };

  const priceLabelFor = (item) => {
    if (item.unit_type === "per_camera") return `${formatAmount(item.monthly_price)} / Camera`;
    if (item.unit_type === "per_gb") return `${formatAmount(item.monthly_price)} / GB`;
    return `${formatAmount(item.monthly_price)} / month`;
  };

  // Super Admin view only: the configured price itself, shown as a
  // flat, stable figure — deliberately never multiplied by usage here.
  // Usage stays fully dynamic/live (usageFor/usageLabelFor above); the
  // configured price does not move because of it. This is a display
  // decision for this page only — it doesn't touch or reflect
  // Backend/api/billing.py's checkout() line-item math (quantity *
  // unit_price), which remains exactly as it was for the Company
  // Admin's own Subscription & Payment page.
  const billingAmountFor = (item) => item.monthly_price || 0;

  // Usage-Based Billing shows only USAGE_BILLING_ITEM_KEYS's 5 items
  // (already filtered into usageBillingItems above). The Module Enabled
  // control above no longer adds or removes a card here — every module,
  // Enabled or Disabled, stays in Module Access only.
  const visibleBillingItems = usageBillingItems;

  return (
    <div>
      <AdminPageHeader
        eyebrow="Admin & User Overview"
        title="Admin Overview"
        description="Real usage for this Company Admin and every User under them."
        actions={
          <AdminButton variant="ghost" icon={ArrowLeft} onClick={() => navigate("/super-admin/admin-overview")}>
            Back to Overview
          </AdminButton>
        }
      />

      {loading && (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-ink-500">
          <Loader2 size={22} className="animate-spin text-admin-accent" />
          <p className="text-xs">Loading admin overview…</p>
        </div>
      )}

      {!loading && error && (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center text-ink-500">
          <AlertTriangle size={22} className="text-red-400" />
          <p className="text-xs">{error}</p>
        </div>
      )}

      {!loading && !error && detail && (
        <>
          <AdminCard className="p-4 sm:p-5">
            <div className="mb-4 flex items-start gap-3 border-b border-white/5 pb-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-white/[0.04] text-admin-accent">
                <Building2 size={20} strokeWidth={2} />
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <p className="font-display text-lg font-semibold text-white">{detail.name}</p>
                  <AdminBadge status={detail.status} />
                </div>
                <p className="text-xs text-ink-500">{detail.email}</p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-3">
              <div>
                <p className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-ink-500">
                  <Video size={12} /> Cameras
                </p>
                <p className="mt-1 font-mono text-sm text-ink-100">{detail.camera_count}</p>
              </div>
              <div>
                <p className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-ink-500">
                  <UserRound size={12} /> Users
                </p>
                <p className="mt-1 font-mono text-sm text-ink-100">{detail.user_count}</p>
              </div>
              <div>
                <p className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-ink-500">
                  <Boxes size={12} /> Modules Enabled
                </p>
                <p className="mt-1 font-mono text-sm text-ink-100">{detail.modules_enabled?.length ?? 0}</p>
              </div>
            </div>
            {/* Registered Persons is deliberately not shown here at the
                Admin level — the correct hierarchy is Admin -> User ->
                Registered Persons, so that count only ever appears per
                User below, in "User List". Total storage lives in the
                "Storage" block right below instead of being duplicated
                as a 4th tile here. */}

            <div className="mt-5 border-t border-white/5 pt-4">
              <p className="mb-3 flex items-center gap-1.5 text-xs uppercase tracking-wide text-ink-500">
                <HardDrive size={12} /> Storage
              </p>
              <div className="flex flex-wrap items-end gap-6">
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-ink-500">Used</p>
                  <p className="mt-1 font-mono text-sm text-ink-100">{formatGb(detail.storage_used_gb)}</p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-ink-500">Remaining</p>
                  <p className="mt-1 font-mono text-sm text-ink-100">
                    {hasLimit ? formatGb(detail.storage_remaining_gb) : "Unlimited"}
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
                <Video size={12} /> Camera Quota
                {detail.camera_quota?.status === "Over Limit" && (
                  <span className="rounded-full border border-signal-red/30 bg-signal-red/10 px-2 py-0.5 text-[10px] font-medium normal-case tracking-normal text-signal-red">
                    Over Limit by {detail.camera_quota.over_limit_by}
                  </span>
                )}
              </p>
              <div className="flex flex-wrap items-end gap-6">
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-ink-500">Used</p>
                  <p className="mt-1 font-mono text-sm text-ink-100">{detail.camera_quota?.used ?? 0}</p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-ink-500">Remaining</p>
                  <p className="mt-1 font-mono text-sm text-ink-100">
                    {detail.camera_quota?.camera_limit === null || detail.camera_quota?.camera_limit === undefined
                      ? "Unlimited"
                      : detail.camera_quota.remaining}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-ink-500">Allocated to Users</p>
                  <p className="mt-1 font-mono text-sm text-ink-100">{detail.camera_quota?.allocated_to_users ?? 0}</p>
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
              {detail.camera_quota?.camera_limit !== null && detail.camera_quota?.camera_limit !== undefined && (
                <div className="mt-3 h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-white/5">
                  <div
                    className={`h-full rounded-full ${
                      detail.camera_quota.usage_percent >= 100
                        ? "bg-signal-red"
                        : detail.camera_quota.usage_percent >= 90
                        ? "bg-amber-400"
                        : "bg-admin-accent"
                    }`}
                    style={{ width: `${Math.min(100, detail.camera_quota.usage_percent)}%` }}
                  />
                </div>
              )}
            </div>
          </AdminCard>

          {/* Data Retention — Super-Admin-only, per-Company-Admin policy
              controlling how long CAPTURED/GENERATED data (Unknown
              Person detections, generated Daily Report PDFs, generated
              Attendance CSV exports) is kept before Backend/retention/
              scheduler.py's daily background sweep deletes it. Never
              touches Registered Person enrollment faces, Attendance
              check-in/check-out records, Users/permissions/modules/
              billing, or the Company Admin account itself. Runs
              server-side on a schedule, independent of this page ever
              being open. */}
          <p className="mb-3 mt-6 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-ink-500">
            <CalendarClock size={13} /> Data Retention
          </p>
          <AdminCard className="p-4 sm:p-5">
            <p className="mb-4 text-xs text-ink-500">
              Controls how long this Company Admin's stored photos/captured data (unknown-person detections,
              generated report PDFs, generated attendance CSV exports) is kept. Registered Person faces, Attendance
              records, Users, permissions, modules, and billing data are never affected by this setting. Only a
              Super Admin can change this.
            </p>

            {retentionLoading ? (
              <div className="flex items-center gap-2 py-3 text-ink-500">
                <Loader2 size={16} className="animate-spin" />
                <p className="text-xs">Loading data retention settings…</p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  {RETENTION_OPTIONS.map((option) => {
                    const isSelected = pendingRetentionPolicy === option.value;
                    const Icon = option.icon;

                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={isSelected}
                        disabled={retentionSaving}
                        onClick={() => selectRetentionPolicy(option.value)}
                        className={`flex flex-col items-start gap-1.5 rounded-md border p-4 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${
                          isSelected
                            ? "border-admin-accent/50 bg-admin-accent/10"
                            : "admin-panel border-white/10 hover:border-white/20"
                        }`}
                      >
                        <span className="flex w-full items-center justify-between gap-2">
                          <span className={`flex items-center gap-1.5 text-sm font-medium ${isSelected ? "text-admin-accent" : "text-ink-100"}`}>
                            <Icon size={14} />
                            {option.label}
                          </span>
                          {isSelected && <AdminBadge status="Active" />}
                        </span>
                        <span className="text-xs text-ink-500">{option.description}</span>
                      </button>
                    );
                  })}
                </div>

                <div className="mt-4 flex items-center justify-end gap-3 border-t border-white/5 pt-4">
                  {pendingRetentionPolicy !== retentionPolicy && (
                    <span className="text-[11px] text-ink-500">Unsaved changes</span>
                  )}
                  <AdminButton
                    icon={Save}
                    onClick={saveRetentionSettings}
                    disabled={retentionSaving || pendingRetentionPolicy === retentionPolicy}
                  >
                    {retentionSaving ? "Saving…" : "Save Changes"}
                  </AdminButton>
                </div>
              </>
            )}
          </AdminCard>

          <p className="mb-3 mt-6 text-xs font-medium uppercase tracking-wide text-ink-500">Modules Enabled</p>
          <AdminCard className="p-4 sm:p-5">
            <p className="mb-4 text-xs text-ink-500">
              Every payment module, always visible here — locked ones stay visible but inaccessible and unbilled for
              this Company Admin. Unlock to grant access and include its price in their Total Amount; lock to remove
              access. Only a Super Admin can change this — the Company Admin sees the same status, view-only, on
              their own Subscription &amp; Payment page.
            </p>

            {moduleLoading ? (
              <div className="flex items-center gap-2 py-3 text-ink-500">
                <Loader2 size={16} className="animate-spin" />
                <p className="text-xs">Loading module access…</p>
              </div>
            ) : (
              <div className="divide-y divide-white/5">
                {moduleAccess.map((m) => (
                  <AdminToggle
                    key={m.module_key}
                    label={
                      <span className="flex items-center gap-2">
                        {m.granted ? (
                          <Unlock size={14} className="text-signal-green" />
                        ) : (
                          <Lock size={14} className="text-ink-500" />
                        )}
                        {m.module_label}
                        {m.always_active && <span className="text-[11px] text-ink-500">(Always Unlocked)</span>}
                      </span>
                    }
                    description={
                      m.always_active
                        ? "Free — always included, never billed."
                        : `${formatAmount(m.monthly_price)} / mo · ${formatAmount(m.yearly_price)} / yr — ${
                            m.granted ? "Enabled, included in Total Amount" : "Locked, excluded from Total Amount"
                          }`
                    }
                    checked={m.granted}
                    disabled={m.always_active || moduleSavingKey === m.module_key}
                    onChange={(value) => toggleModuleAccess(m.module_key, value, m.always_active)}
                  />
                ))}
              </div>
            )}
          </AdminCard>

          {/* Usage-Based Billing — fixed to exactly USAGE_BILLING_ITEM_KEYS's
              5 catalog items (Additional Camera, Platform Hosting,
              WhatsApp Daily Report, WhatsApp Unknown Person Alerts, Cloud
              Storage): real usage, price, and billing amount, plus each
              card's own ON/OFF lock (Backend/api/billing.py's
              set_item_access) — independent per item, persisted per
              company. OFF keeps the card visible but locked: excluded
              from this company's bill and, server-side, blocked from
              being active at all. No other module ever gets a card here,
              granted or not — the Modules Enabled toggles above only
              control Module Access. Same catalog and prices the Company
              Admin's own Subscription & Payment page shows. */}
          {visibleBillingItems.length > 0 && (
            <>
              <p className="mb-3 mt-6 text-xs font-medium uppercase tracking-wide text-ink-500">Usage-Based Billing</p>
              <AdminCard className="p-4 sm:p-5">
                <p className="mb-4 text-xs text-ink-500">
                  Usage updates live and is tracked per item. The billing amount is the configured price and stays
                  stable — it is not recalculated from usage. Turn a card OFF to lock it: it stays visible but is
                  excluded from this Company Admin's bill and cannot be active for them.
                </p>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {visibleBillingItems.map((item) => {
                    const isOn = item.access_enabled !== false;

                    return (
                      <div
                        key={item.item_key}
                        className={`rounded-md admin-panel p-4 transition-opacity duration-200 ${isOn ? "" : "opacity-60"}`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-sm font-medium text-ink-100">{item.name}</p>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={isOn}
                            aria-label={`${item.name} — ${isOn ? "ON" : "OFF"}`}
                            disabled={billingSavingKey === item.item_key}
                            onClick={() => toggleItemAccess(item)}
                            className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide transition disabled:cursor-not-allowed disabled:opacity-60 ${
                              isOn
                                ? "border-signal-green/30 bg-signal-green/10 text-signal-green"
                                : "border-white/10 bg-white/[0.04] text-ink-500"
                            }`}
                          >
                            {isOn ? <Unlock size={11} /> : <Lock size={11} />}
                            {isOn ? "ON" : "OFF"}
                          </button>
                        </div>
                        {!isOn && <p className="mt-1 text-[11px] text-ink-500">Locked — excluded from billing.</p>}
                        <div className="mt-3 space-y-1.5">
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-ink-500">Usage</span>
                            <span className="font-mono text-ink-200">{usageLabelFor(item)}</span>
                          </div>
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-ink-500">Price</span>
                            <span className="font-mono text-ink-200">{priceLabelFor(item)}</span>
                          </div>
                          <div className="flex items-center justify-between border-t border-white/5 pt-1.5 text-xs">
                            <span className="text-ink-400">Billing Amount</span>
                            <span className="font-mono font-semibold text-ink-100">{formatAmount(billingAmountFor(item))}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </AdminCard>
            </>
          )}

          {/* User List — hierarchy is Admin -> User -> Registered
              Persons: each User's own Registered Persons/Attendance/
              Unknown Persons/Cameras/Storage lives only here, one clean
              card per User, never rolled up as a single Admin-level
              "Registered Persons" number above. */}
          <p className="mb-3 mt-6 text-xs font-medium uppercase tracking-wide text-ink-500">User List</p>

          {detail.users.length === 0 ? (
            <AdminCard className="p-4 sm:p-5">
              <div className="flex flex-col items-center gap-2 py-12 text-ink-500">
                <UserRound size={22} />
                <p className="text-xs">This company has no Users yet.</p>
              </div>
            </AdminCard>
          ) : (
            <div className="space-y-3">
              {detail.users.map((u) => (
                <AdminCard
                  key={u.id}
                  className="cursor-pointer p-4 transition hover:border-admin-accent/30 sm:p-5"
                  onClick={() => navigate(`/super-admin/admin-overview/${id}/users/${u.id}`)}
                >
                  <div className="mb-4 flex items-center justify-between gap-3 border-b border-white/5 pb-3">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-white/[0.04] text-admin-accent">
                        <UserRound size={16} strokeWidth={2} />
                      </div>
                      <div>
                        <p className="font-medium text-ink-100">{u.name}</p>
                        <p className="text-xs text-ink-500">{u.email}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <AdminBadge status={u.status} />
                      <ChevronRight size={16} className="text-ink-500" />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
                    <div>
                      <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-ink-500">
                        <ScanFace size={11} /> Registered Persons
                      </p>
                      <p className="mt-1 font-mono text-lg font-semibold text-ink-100">{u.registered_persons.count}</p>
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-wide text-ink-500">Attendance</p>
                      <p className="mt-1 font-mono text-lg font-semibold text-ink-100" title={u.attendance.note}>
                        {u.attendance.count}
                      </p>
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-wide text-ink-500">Unknown Persons</p>
                      <p className="mt-1 font-mono text-lg font-semibold text-ink-100">{u.unknown_persons.count}</p>
                    </div>
                    <div>
                      <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-ink-500">
                        <Video size={11} /> Cameras
                      </p>
                      <p
                        className={`mt-1 font-mono text-lg font-semibold ${
                          u.camera_quota?.status === "Over Limit" ? "text-signal-red" : "text-ink-100"
                        }`}
                      >
                        {u.cameras.count}
                        {u.camera_quota?.camera_limit !== null && u.camera_quota?.camera_limit !== undefined && (
                          <span className="text-xs font-normal text-ink-500"> / {u.camera_quota.camera_limit}</span>
                        )}
                      </p>
                    </div>
                    <div>
                      <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-ink-500">
                        <HardDrive size={11} /> Storage Used
                      </p>
                      <p className="mt-1 font-mono text-lg font-semibold text-ink-100">{formatGb(u.total_gb)}</p>
                    </div>
                  </div>
                </AdminCard>
              ))}
            </div>
          )}
        </>
      )}

      <AdminToast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
