import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { API_BASE_URL } from "../../lib/apiBase";
import {
  Loader2,
  AlertTriangle,
  Tag,
  Plus,
  Pencil,
  Trash2,
  CheckCircle2,
  Percent,
  Video,
  HardDrive,
  Server,
  Bell,
  LayoutGrid,
  Clock,
  Users,
  RotateCcw,
} from "lucide-react";
import AdminPageHeader from "../ui/AdminPageHeader";
import AdminCard from "../ui/AdminCard";
import AdminStatCard from "../ui/AdminStatCard";
import AdminButton from "../ui/AdminButton";
import AdminModal from "../ui/AdminModal";
import AdminToast from "../ui/AdminToast";
import AdminSelect from "../ui/AdminSelect";
import AdminSearchInput from "../ui/AdminSearchInput";
import AdminBadge from "../ui/AdminBadge";
import AdminToggle from "../ui/AdminToggle";

const formatAmount = (amount) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(amount || 0);

const formatDate = (value) => {
  if (!value) return null;
  // Backend stores "%Y-%m-%d %H:%M:%S" strings — parse manually rather
  // than trusting `new Date(str)` across browsers with a space separator.
  const [datePart, timePart] = value.split(" ");
  const iso = timePart ? `${datePart}T${timePart}` : datePart;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};

const CATEGORY_ORDER = [
  "AI / Camera Modules",
  "Camera / Hardware",
  "Storage",
  "Hosting / Infrastructure",
  "Notifications / Communication",
];

const CATEGORY_ICONS = {
  "AI / Camera Modules": LayoutGrid,
  "Camera / Hardware": Video,
  Storage: HardDrive,
  "Hosting / Infrastructure": Server,
  "Notifications / Communication": Bell,
};

// unit_type is a real, backend-meaningful field (what quantity a price
// multiplies against at checkout — Backend/api/billing.py's
// _quantity_for) — these are display labels only, the 3 underlying
// values are unchanged.
const UNIT_TYPE_OPTIONS = [
  { value: "flat", label: "Flat Rate" },
  { value: "per_camera", label: "Per Camera" },
  { value: "per_gb", label: "Per GB" },
];
const UNIT_TYPE_LABELS = Object.fromEntries(UNIT_TYPE_OPTIONS.map((o) => [o.value, o.label]));

const CATEGORY_FILTER_OPTIONS = [{ value: "all", label: "All Categories" }, ...CATEGORY_ORDER.map((c) => ({ value: c, label: c }))];
const STATUS_FILTER_OPTIONS = [
  { value: "all", label: "All Statuses" },
  { value: "active", label: "Active Only" },
  { value: "inactive", label: "Inactive Only" },
];

const priceInputClass =
  "w-full rounded-md admin-panel py-2.5 pl-7 pr-16 text-sm text-ink-100 outline-none focus:border-admin-accent/50 focus:ring-2 focus:ring-admin-accent/20";
const inputClass =
  "w-full rounded-md admin-panel px-3.5 py-2.5 text-sm text-ink-100 placeholder:text-ink-500 outline-none focus:border-admin-accent/50 focus:ring-2 focus:ring-admin-accent/20";

function PriceField({ label, suffix, value, onChange, error }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-ink-400">{label}</label>
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-ink-500">₹</span>
        <input
          type="number"
          min={0}
          step="0.01"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={priceInputClass}
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-ink-500">{suffix}</span>
      </div>
      {error && <p className="mt-1 text-xs text-signal-red">{error}</p>}
    </div>
  );
}

function emptyEditForm(item) {
  return {
    name: item.name,
    description: item.description || "",
    category: item.category,
    unit_type: item.unit_type,
    monthly_price: String(item.monthly_price ?? 0),
    yearly_price: String(item.yearly_price ?? 0),
    yearly_discount_percent: item.yearly_discount_percent ?? "",
    enabled: item.enabled,
  };
}

const emptyNewItem = {
  item_key: "",
  category: CATEGORY_ORDER[0],
  name: "",
  description: "",
  unit_type: "flat",
  monthly_price: "0",
  yearly_price: "0",
  yearly_discount_percent: "",
  enabled: true,
};

// Super Admin's full CRUD over every billable item across every
// category — the single source of truth Company Admin's checkout page
// (admin/pages/SubscriptionPayment.jsx) reads prices/availability from.
// Backed by Backend/api/billing.py (GET/POST /billing/items, PUT/DELETE
// /billing/items/<id>). Pure UI/UX redesign — no pricing calculation,
// no schema, and no API contract changed from the previous version of
// this page.
const SCOPE_ALL = "all";

export default function AdminBillingPricing() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  // Pricing scope: "all" edits the global default price every company
  // without its own override pays; a specific customer_id edits ONLY
  // that one company's price (Backend/api/billing.py's
  // BillableItemPriceOverride) — never touches the global row or any
  // other company's own override.
  const [scope, setScope] = useState(SCOPE_ALL);
  const [admins, setAdmins] = useState([]);

  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");

  const [editTarget, setEditTarget] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [editErrors, setEditErrors] = useState({});
  const [saving, setSaving] = useState(false);

  const [addOpen, setAddOpen] = useState(false);
  const [newItem, setNewItem] = useState(emptyNewItem);
  const [addErrors, setAddErrors] = useState({});
  const [adding, setAdding] = useState(false);

  const isGlobalScope = scope === SCOPE_ALL;
  const selectedAdmin = isGlobalScope ? null : admins.find((a) => String(a.customer_id) === String(scope));

  const fetchItems = (currentScope) => {
    setLoading(true);
    setError(null);

    const url =
      currentScope && currentScope !== SCOPE_ALL
        ? `${API_BASE_URL}/billing/items?customer_id=${currentScope}`
        : `${API_BASE_URL}/billing/items`;

    return axios
      .get(url)
      .then((res) => setItems(res.data.items || []))
      .catch((err) => {
        console.error("Billing Items API Error :", err);
        setError("Unable to load billing items. Please check the server and try again.");
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    axios
      .get(`${API_BASE_URL}/subscriptions`)
      .then((res) => setAdmins(res.data.subscriptions || []))
      .catch((err) => console.error("Subscriptions API Error :", err));
  }, []);

  useEffect(() => {
    fetchItems(scope);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();

    return items.filter((item) => {
      if (categoryFilter !== "all" && item.category !== categoryFilter) return false;
      if (statusFilter === "active" && !item.enabled) return false;
      if (statusFilter === "inactive" && item.enabled) return false;
      if (q && !item.name.toLowerCase().includes(q) && !(item.description || "").toLowerCase().includes(q)) return false;
      return true;
    });
  }, [items, search, categoryFilter, statusFilter]);

  const grouped = useMemo(() => {
    const byCategory = CATEGORY_ORDER.map((category) => ({
      category,
      rows: filteredItems.filter((i) => i.category === category),
    }));

    const extra = [...new Set(filteredItems.map((i) => i.category))].filter((c) => !CATEGORY_ORDER.includes(c));
    for (const category of extra) byCategory.push({ category, rows: filteredItems.filter((i) => i.category === category) });

    return byCategory.filter((g) => g.rows.length > 0);
  }, [filteredItems]);

  const summary = useMemo(() => {
    const total = items.length;
    const activeCount = items.filter((i) => i.enabled).length;
    const avgMonthly = total > 0 ? items.reduce((sum, i) => sum + (i.monthly_price || 0), 0) / total : 0;

    return {
      total,
      active: activeCount,
      inactive: total - activeCount,
      avgMonthly,
    };
  }, [items]);

  // --- Edit ---

  const openEdit = (item) => {
    setEditTarget(item);
    setEditForm(emptyEditForm(item));
    setEditErrors({});
  };

  const closeEdit = () => {
    setEditTarget(null);
    setEditForm(null);
  };

  const validatePrices = (monthly, yearly) => {
    const errs = {};

    if (monthly === "" || Number.isNaN(Number(monthly))) errs.monthly_price = "Enter a valid monthly price.";
    else if (Number(monthly) < 0) errs.monthly_price = "Monthly price cannot be negative.";

    if (yearly === "" || Number.isNaN(Number(yearly))) errs.yearly_price = "Enter a valid yearly price.";
    else if (Number(yearly) < 0) errs.yearly_price = "Yearly price cannot be negative.";

    return errs;
  };

  const handleSaveEdit = (e) => {
    e.preventDefault();
    if (!editTarget || !editForm) return;

    const errs = validatePrices(editForm.monthly_price, editForm.yearly_price);
    if (isGlobalScope && !editForm.name.trim()) errs.name = "Item name is required.";

    if (Object.keys(errs).length > 0) {
      setEditErrors(errs);
      return;
    }

    setEditErrors({});
    setSaving(true);

    const request = isGlobalScope
      ? axios.put(`${API_BASE_URL}/billing/items/${editTarget.id}`, {
          name: editForm.name.trim(),
          description: editForm.description.trim(),
          category: editForm.category,
          unit_type: editForm.unit_type,
          monthly_price: Number(editForm.monthly_price),
          yearly_price: Number(editForm.yearly_price),
          yearly_discount_percent: editForm.yearly_discount_percent === "" ? null : Number(editForm.yearly_discount_percent),
          enabled: editForm.enabled,
        })
      : axios.put(`${API_BASE_URL}/billing/items/${editTarget.id}/override/${scope}`, {
          monthly_price: Number(editForm.monthly_price),
          yearly_price: Number(editForm.yearly_price),
          yearly_discount_percent: editForm.yearly_discount_percent === "" ? null : Number(editForm.yearly_discount_percent),
        });

    request
      .then(() => {
        const who = isGlobalScope ? "" : ` for ${selectedAdmin?.customer_name || "this Admin"}`;
        setToast({ type: "success", message: `${editForm.name} pricing saved successfully${who}.` });
        closeEdit();
        fetchItems(scope);
      })
      .catch((err) => {
        setToast({ type: "error", message: err.response?.data?.message || "Failed to save pricing." });
      })
      .finally(() => setSaving(false));
  };

  const handleDelete = (item) => {
    if (!window.confirm(`Delete "${item.name}"? This cannot be undone.`)) return;

    axios
      .delete(`${API_BASE_URL}/billing/items/${item.id}`)
      .then(() => {
        setToast({ type: "success", message: `${item.name} deleted.` });
        fetchItems(scope);
      })
      .catch((err) => {
        setToast({ type: "error", message: err.response?.data?.message || "Failed to delete item." });
      });
  };

  const handleResetOverride = (item) => {
    if (!selectedAdmin) return;
    if (!window.confirm(`Reset "${item.name}" back to the global price for ${selectedAdmin.customer_name}?`)) return;

    axios
      .delete(`${API_BASE_URL}/billing/items/${item.id}/override/${scope}`)
      .then(() => {
        setToast({ type: "success", message: `${item.name} reverted to global pricing for ${selectedAdmin.customer_name}.` });
        fetchItems(scope);
      })
      .catch((err) => {
        setToast({ type: "error", message: err.response?.data?.message || "Failed to reset pricing." });
      });
  };

  // --- Add ---

  const openAdd = () => {
    setNewItem(emptyNewItem);
    setAddErrors({});
    setAddOpen(true);
  };

  const handleAdd = (e) => {
    e.preventDefault();

    const errs = validatePrices(newItem.monthly_price, newItem.yearly_price);
    if (!newItem.item_key.trim()) errs.item_key = "Item key is required.";
    if (!newItem.name.trim()) errs.name = "Item name is required.";

    if (Object.keys(errs).length > 0) {
      setAddErrors(errs);
      return;
    }

    setAddErrors({});
    setAdding(true);

    axios
      .post(`${API_BASE_URL}/billing/items`, {
        item_key: newItem.item_key.trim(),
        category: newItem.category,
        name: newItem.name.trim(),
        description: newItem.description.trim(),
        unit_type: newItem.unit_type,
        monthly_price: Number(newItem.monthly_price),
        yearly_price: Number(newItem.yearly_price),
        yearly_discount_percent: newItem.yearly_discount_percent === "" ? null : Number(newItem.yearly_discount_percent),
        enabled: newItem.enabled,
        display_order: 0,
        // A brand-new item has nothing real to unlock yet — see
        // BillableItem.activation_type's docstring in auth/models.py.
        // Still an honest, real billed line either way.
        activation_type: "record_only",
        activation_ref: null,
      })
      .then(() => {
        setToast({ type: "success", message: `${newItem.name} added.` });
        setAddOpen(false);
        fetchItems(scope);
      })
      .catch((err) => {
        setToast({ type: "error", message: err.response?.data?.message || "Failed to add item." });
      })
      .finally(() => setAdding(false));
  };

  // --- Live pricing preview (used by both Edit and Add forms) ---

  const pricingPreview = (monthly, yearly) => {
    const m = Number(monthly);
    const y = Number(yearly);
    const valid = !Number.isNaN(m) && !Number.isNaN(y);
    const saving = valid ? m * 12 - y : 0;

    return { monthly: valid ? m : 0, yearly: valid ? y : 0, saving, hasSaving: valid && saving > 0 };
  };

  return (
    <div>
      <AdminPageHeader
        eyebrow="Billing & Payments"
        title="Billing & Pricing"
        description={
          isGlobalScope
            ? "Set the Monthly and Yearly price for every billable item. Company Admins can only view enabled items, select what they need, and pay — pricing is controlled entirely from here."
            : `Editing pricing for ${selectedAdmin?.customer_name || "this Admin"} only — other Admins keep their own pricing (global or custom) untouched.`
        }
      />

      <AdminCard className="mb-4 p-4 sm:p-5">
        <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-ink-400">
          <Users size={13} /> Pricing Scope
        </label>
        <div className="sm:w-80">
          <AdminSelect
            value={scope}
            onChange={setScope}
            options={[
              { value: SCOPE_ALL, label: "All Admins (global default pricing)" },
              ...admins.map((a) => ({ value: String(a.customer_id), label: a.customer_name })),
            ]}
          />
        </div>
        <p className="mt-2 text-[11px] text-ink-500">
          {isGlobalScope
            ? "Prices set here apply to every Admin who doesn't have a custom override."
            : "Only Monthly/Yearly pricing can be customized per Admin — the item catalog itself stays global."}
        </p>
      </AdminCard>

      <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <AdminStatCard label="Total Billable Items" value={loading ? "—" : summary.total} delta="Across every category" icon="Package" tone="violet" />
        <AdminStatCard label="Active Items" value={loading ? "—" : summary.active} delta="Visible to Company Admins" icon="CheckCircle2" tone="green" />
        <AdminStatCard label="Inactive Items" value={loading ? "—" : summary.inactive} delta="Hidden from checkout" icon="EyeOff" tone="amber" />
        <AdminStatCard label="Average Monthly Price" value={loading ? "—" : formatAmount(summary.avgMonthly)} delta="Across all items" icon="TrendingUp" tone="gold" />
      </div>

      <AdminCard className="mb-4 p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-center">
            <AdminSearchInput value={search} onChange={setSearch} placeholder="Search modules/services…" className="sm:w-64" />
            <div className="w-full sm:w-52">
              <AdminSelect value={categoryFilter} onChange={setCategoryFilter} options={CATEGORY_FILTER_OPTIONS} />
            </div>
            <div className="w-full sm:w-44">
              <AdminSelect value={statusFilter} onChange={setStatusFilter} options={STATUS_FILTER_OPTIONS} />
            </div>
          </div>
          {isGlobalScope && (
            <AdminButton icon={Plus} onClick={openAdd} className="shrink-0">
              Add Item
            </AdminButton>
          )}
        </div>
      </AdminCard>

      {loading && (
        <AdminCard className="p-4 sm:p-5">
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-ink-500">
            <Loader2 size={22} className="animate-spin text-admin-accent" />
            <p className="text-xs">Loading billing catalog…</p>
          </div>
        </AdminCard>
      )}

      {!loading && error && (
        <AdminCard className="p-4 sm:p-5">
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-center text-ink-500">
            <AlertTriangle size={22} className="text-red-400" />
            <p className="text-xs">{error}</p>
          </div>
        </AdminCard>
      )}

      {!loading && !error && grouped.length === 0 && (
        <AdminCard className="p-4 sm:p-5">
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-center text-ink-500">
            <Tag size={22} />
            <p className="text-sm">No billing items match your filters.</p>
          </div>
        </AdminCard>
      )}

      {!loading &&
        !error &&
        grouped.map(({ category, rows }) => {
          const CategoryIcon = CATEGORY_ICONS[category] || Tag;

          return (
            <div key={category} className="mb-6 last:mb-0">
              <div className="mb-3 flex items-center gap-2">
                <CategoryIcon size={15} className="text-admin-accent" />
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-300">{category}</p>
                <span className="font-mono text-[11px] text-ink-600">({rows.length})</span>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {rows.map((item) => {
                  const yearlySaving = item.monthly_price * 12 - item.yearly_price;
                  const lastUpdated = formatDate(item.updated_at);

                  return (
                    <AdminCard key={item.id} className={`flex flex-col p-4 sm:p-5 ${!item.enabled ? "opacity-60" : ""}`}>
                      <div className="mb-1 flex items-start justify-between gap-3">
                        <p className="font-display text-sm font-semibold text-white">{item.name}</p>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {!isGlobalScope && (
                            <span
                              className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium font-mono tracking-wide ${
                                item.is_override
                                  ? "border-admin-gold/30 bg-admin-gold/10 text-admin-gold"
                                  : "border-ink-500/30 bg-ink-500/10 text-ink-400"
                              }`}
                            >
                              <span className="h-1.5 w-1.5 rounded-full bg-current" />
                              {item.is_override ? "Custom" : "Global"}
                            </span>
                          )}
                          <AdminBadge status={item.enabled ? "Active" : "Inactive"} />
                        </div>
                      </div>

                      <p className="mb-3 line-clamp-2 text-xs text-ink-500">
                        {item.description || "No description provided."}
                      </p>

                      <p className="mb-4 inline-flex w-fit items-center gap-1.5 rounded-md bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-ink-300">
                        <Tag size={11} />
                        {UNIT_TYPE_LABELS[item.unit_type] || item.unit_type}
                      </p>

                      <div className="mb-4 grid grid-cols-2 gap-3 rounded-lg border border-white/8 bg-white/[0.02] p-3">
                        <div>
                          <p className="text-[10px] uppercase tracking-wide text-ink-500">Monthly</p>
                          <p className="mt-0.5 font-mono text-sm font-semibold text-white">{formatAmount(item.monthly_price)}</p>
                        </div>
                        <div>
                          <p className="text-[10px] uppercase tracking-wide text-ink-500">Yearly</p>
                          <p className="mt-0.5 font-mono text-sm font-semibold text-white">{formatAmount(item.yearly_price)}</p>
                        </div>
                      </div>

                      {!isGlobalScope && item.is_override && (
                        <p className="mb-4 text-[11px] text-ink-500">
                          Global price is {formatAmount(item.global_monthly_price)}/mo, {formatAmount(item.global_yearly_price)}/yr
                        </p>
                      )}

                      {yearlySaving > 0 && (
                        <p className="mb-4 inline-flex w-fit items-center gap-1 rounded-md bg-signal-green/10 px-2.5 py-1 text-[11px] font-medium text-signal-green">
                          <Percent size={11} />
                          Save {formatAmount(yearlySaving)}/yr vs. paying monthly
                        </p>
                      )}

                      <div className="mt-auto flex items-center justify-between gap-3 border-t border-white/5 pt-3">
                        <p className="flex items-center gap-1 text-[11px] text-ink-600">
                          <Clock size={11} />
                          {lastUpdated ? `Updated ${lastUpdated}` : "Not yet updated"}
                        </p>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => openEdit(item)}
                            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-admin-accent hover:bg-admin-accent/10"
                          >
                            <Pencil size={13} /> Edit
                          </button>
                          {!isGlobalScope && item.is_override && (
                            <button
                              type="button"
                              onClick={() => handleResetOverride(item)}
                              className="inline-flex rounded-md p-1.5 text-ink-500 hover:bg-white/5 hover:text-ink-200"
                              title="Reset to global price"
                            >
                              <RotateCcw size={14} />
                            </button>
                          )}
                          {isGlobalScope && (
                            <button
                              type="button"
                              onClick={() => handleDelete(item)}
                              className="inline-flex rounded-md p-1.5 text-ink-500 hover:bg-signal-red/10 hover:text-signal-red"
                              title="Delete"
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      </div>
                    </AdminCard>
                  );
                })}
              </div>
            </div>
          );
        })}

      {/* Edit Pricing */}
      <AdminModal
        open={!!editTarget}
        onClose={closeEdit}
        title={
          editTarget
            ? isGlobalScope
              ? `Edit Pricing — ${editTarget.name}`
              : `Set Price — ${editTarget.name}`
            : "Edit Pricing"
        }
        size="lg"
      >
        {editForm && (
          <form className="space-y-5" onSubmit={handleSaveEdit}>
            {!isGlobalScope && (
              <div className="rounded-lg border border-admin-gold/20 bg-admin-gold/5 px-4 py-3">
                <p className="text-xs text-ink-300">
                  Setting a custom price for <span className="font-medium text-white">{selectedAdmin?.customer_name}</span> only.
                  Every other Admin keeps their own pricing (global or custom) exactly as it is.
                </p>
              </div>
            )}

            {isGlobalScope ? (
              <>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-ink-400">Item Name</label>
                    <input
                      type="text"
                      required
                      value={editForm.name}
                      onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                      className={inputClass}
                    />
                    {editErrors.name && <p className="mt-1 text-xs text-signal-red">{editErrors.name}</p>}
                  </div>
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-ink-400">Category</label>
                    <AdminSelect
                      value={editForm.category}
                      onChange={(value) => setEditForm((f) => ({ ...f, category: value }))}
                      options={CATEGORY_ORDER.map((c) => ({ value: c, label: c }))}
                    />
                  </div>
                </div>

                <div>
                  <label className="mb-1.5 block text-xs font-medium text-ink-400">Description</label>
                  <input
                    type="text"
                    value={editForm.description}
                    onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
                    placeholder="Shown to Company Admins on their checkout page"
                    className={inputClass}
                  />
                </div>
              </>
            ) : (
              <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
                <p className="text-sm font-medium text-ink-100">{editForm.name}</p>
                {editForm.description && <p className="mt-0.5 text-xs text-ink-500">{editForm.description}</p>}
                <p className="mt-1.5 text-[11px] text-ink-600">{editForm.category} — name, category, and description are global and edited from the "All Admins" scope.</p>
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <PriceField
                label="Monthly Pricing"
                suffix="/ month"
                value={editForm.monthly_price}
                onChange={(v) => setEditForm((f) => ({ ...f, monthly_price: v }))}
                error={editErrors.monthly_price}
              />
              <PriceField
                label="Yearly Pricing"
                suffix="/ year"
                value={editForm.yearly_price}
                onChange={(v) => setEditForm((f) => ({ ...f, yearly_price: v }))}
                error={editErrors.yearly_price}
              />
            </div>

            {isGlobalScope && (
              <div>
                <label className="mb-1.5 block text-xs font-medium text-ink-400">Billing Unit</label>
                <AdminSelect
                  value={editForm.unit_type}
                  onChange={(value) => setEditForm((f) => ({ ...f, unit_type: value }))}
                  options={UNIT_TYPE_OPTIONS}
                />
                <p className="mt-1.5 text-[11px] text-ink-500">
                  What the price multiplies against — a flat charge, or per camera / per GB of this company's actual usage.
                </p>
              </div>
            )}

            {isGlobalScope && (
              <div className="rounded-lg border border-white/10 bg-white/[0.02] px-4 py-1">
                <AdminToggle
                  checked={editForm.enabled}
                  onChange={(checked) => setEditForm((f) => ({ ...f, enabled: checked }))}
                  label="Status"
                  description={editForm.enabled ? "Active — visible on the Company Admin checkout page" : "Inactive — hidden from Company Admins"}
                />
              </div>
            )}

            {(() => {
              const preview = pricingPreview(editForm.monthly_price, editForm.yearly_price);
              return (
                <div className="rounded-lg border border-admin-accent/20 bg-admin-accent/5 p-4">
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-admin-accent">Pricing Preview</p>
                  <div className="space-y-1 text-sm text-ink-200">
                    <p>
                      Monthly: <span className="font-mono font-semibold text-white">{formatAmount(preview.monthly)}/month</span>
                    </p>
                    <p>
                      Yearly: <span className="font-mono font-semibold text-white">{formatAmount(preview.yearly)}/year</span>
                    </p>
                    {preview.hasSaving && (
                      <p className="text-signal-green">
                        Yearly saving: <span className="font-mono font-semibold">{formatAmount(preview.saving)}</span> vs. 12× monthly
                      </p>
                    )}
                  </div>
                </div>
              );
            })()}

            <div className="flex justify-end gap-3 pt-1">
              <AdminButton type="button" variant="ghost" onClick={closeEdit} disabled={saving}>
                Cancel
              </AdminButton>
              <AdminButton type="submit" icon={CheckCircle2} disabled={saving}>
                {saving ? "Saving…" : "Save Pricing"}
              </AdminButton>
            </div>
          </form>
        )}
      </AdminModal>

      {/* Add Item */}
      <AdminModal open={addOpen} onClose={() => setAddOpen(false)} title="Add Billing Item" size="lg">
        <form className="space-y-5" onSubmit={handleAdd}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink-400">Item Key</label>
              <input
                type="text"
                required
                placeholder="e.g. priority_support"
                value={newItem.item_key}
                onChange={(e) => setNewItem((f) => ({ ...f, item_key: e.target.value }))}
                className={inputClass}
              />
              {addErrors.item_key && <p className="mt-1 text-xs text-signal-red">{addErrors.item_key}</p>}
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink-400">Category</label>
              <AdminSelect
                value={newItem.category}
                onChange={(value) => setNewItem((f) => ({ ...f, category: value }))}
                options={CATEGORY_ORDER.map((c) => ({ value: c, label: c }))}
              />
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-400">Item Name</label>
            <input
              type="text"
              required
              value={newItem.name}
              onChange={(e) => setNewItem((f) => ({ ...f, name: e.target.value }))}
              className={inputClass}
            />
            {addErrors.name && <p className="mt-1 text-xs text-signal-red">{addErrors.name}</p>}
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-400">Description</label>
            <input
              type="text"
              value={newItem.description}
              onChange={(e) => setNewItem((f) => ({ ...f, description: e.target.value }))}
              placeholder="Shown to Company Admins on their checkout page"
              className={inputClass}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <PriceField
              label="Monthly Pricing"
              suffix="/ month"
              value={newItem.monthly_price}
              onChange={(v) => setNewItem((f) => ({ ...f, monthly_price: v }))}
              error={addErrors.monthly_price}
            />
            <PriceField
              label="Yearly Pricing"
              suffix="/ year"
              value={newItem.yearly_price}
              onChange={(v) => setNewItem((f) => ({ ...f, yearly_price: v }))}
              error={addErrors.yearly_price}
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-400">Billing Unit</label>
            <AdminSelect
              value={newItem.unit_type}
              onChange={(value) => setNewItem((f) => ({ ...f, unit_type: value }))}
              options={UNIT_TYPE_OPTIONS}
            />
          </div>

          <div className="rounded-lg border border-white/10 bg-white/[0.02] px-4 py-1">
            <AdminToggle
              checked={newItem.enabled}
              onChange={(checked) => setNewItem((f) => ({ ...f, enabled: checked }))}
              label="Status"
              description={newItem.enabled ? "Active — visible on the Company Admin checkout page" : "Inactive — hidden from Company Admins"}
            />
          </div>

          {(() => {
            const preview = pricingPreview(newItem.monthly_price, newItem.yearly_price);
            return (
              <div className="rounded-lg border border-admin-accent/20 bg-admin-accent/5 p-4">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-admin-accent">Pricing Preview</p>
                <div className="space-y-1 text-sm text-ink-200">
                  <p>
                    Monthly: <span className="font-mono font-semibold text-white">{formatAmount(preview.monthly)}/month</span>
                  </p>
                  <p>
                    Yearly: <span className="font-mono font-semibold text-white">{formatAmount(preview.yearly)}/year</span>
                  </p>
                  {preview.hasSaving && (
                    <p className="text-signal-green">
                      Yearly saving: <span className="font-mono font-semibold">{formatAmount(preview.saving)}</span> vs. 12× monthly
                    </p>
                  )}
                </div>
              </div>
            );
          })()}

          <div className="flex justify-end gap-3 pt-1">
            <AdminButton type="button" variant="ghost" onClick={() => setAddOpen(false)} disabled={adding}>
              Cancel
            </AdminButton>
            <AdminButton type="submit" icon={Plus} disabled={adding}>
              {adding ? "Adding…" : "Add Item"}
            </AdminButton>
          </div>
        </form>
      </AdminModal>

      <AdminToast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
