import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { Boxes, Loader2, AlertTriangle, CheckCircle2, Lock } from "lucide-react";
import PageHeader from "../../components/ui/PageHeader";
import GlassCard from "../../components/ui/GlassCard";
import Modal from "../../components/ui/Modal";
import Toast from "../../components/ui/Toast";
import { usePolling } from "../../lib/usePolling";
import { useAuth } from "../../context/AuthContext";
import { API_BASE_URL } from "../../lib/apiBase";
import { POLL_MS, formatAmount } from "../../components/subscription/subscriptionShared";

// Company Admin Subscription & Payment → Billing & Payment — its own page/
// route, separate from Current Plan and Payment History. Module Packages +
// Add-ons are read-only info/pricing cards: access, lock state and price all
// come from the Super Admin, nothing here is selectable. "Proceed to
// Payment" settles the bill for whatever's already active/assigned via the
// two EXISTING checkout endpoints (POST /company/module-packages/checkout
// for packages, POST /company/checkout for add-ons) — every price /
// enabled-locked / active decision is server-authoritative, this page only
// mirrors it.
const ADDON_CATEGORY_ORDER = [
  "Camera / Hardware",
  "Storage",
  "Hosting / Infrastructure",
  "Notifications / Communication",
];

// Only two statuses are ever shown to the Company Admin: Active (currently
// on the account) or Locked (disabled/locked by Super Admin). An unlocked
// item that isn't yet active reads as "Not Assigned" so it's never mistaken
// for something already being billed.
function EntitlementStatusBadge({ locked, owned }) {
  if (locked) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-signal-red/30 bg-signal-red/10 px-2.5 py-1 text-xs font-medium text-signal-red">
        <Lock size={11} />
        Locked
      </span>
    );
  }
  if (owned) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-signal-green/30 bg-signal-green/10 px-2.5 py-1 text-xs font-medium text-signal-green">
        <CheckCircle2 size={11} />
        Active
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-ink-500/30 bg-ink-500/10 px-2.5 py-1 text-xs font-medium text-ink-500">
      Not Assigned
    </span>
  );
}

export default function BillingPayment() {
  const { user, updateUser } = useAuth();

  const [billingCycle, setBillingCycle] = useState("Monthly");
  const [taxPercent, setTaxPercent] = useState(0);

  // Module packages (Backend/api/module_packages.py) — Company Admin cannot
  // select these; the billed set is always exactly what's owned + enabled
  // (assigned by the Super Admin).
  const [pkgList, setPkgList] = useState([]);
  const [pkgLoading, setPkgLoading] = useState(true);
  const [pkgError, setPkgError] = useState(null);

  // Add-on modules (Backend/api/billing.py — GET /company/checkout-context)
  // — Company Admin cannot select these either; the billed set is always
  // exactly what's currently active/granted for this company.
  const [addonItems, setAddonItems] = useState([]);
  const [addonLoading, setAddonLoading] = useState(true);
  const [addonError, setAddonError] = useState(null);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState(null);
  const [toast, setToast] = useState(null);

  const fetchPackages = useCallback((isPoll = false) => {
    if (!isPoll) {
      setPkgLoading(true);
      setPkgError(null);
    }

    return axios
      .get(`${API_BASE_URL}/company/module-packages`)
      .then((res) => {
        const list = res.data.packages || [];
        setPkgList(list);
        setBillingCycle(res.data.billing_cycle || "Monthly");
        setTaxPercent(res.data.tax_percent || 0);
        setPkgError(null);
      })
      .catch((err) => {
        console.error("Module Packages API Error :", err);
        if (!isPoll) {
          setPkgError(
            err.response?.status === 404
              ? "Module packages are unavailable — the backend may need a restart to load the package billing API."
              : err.response?.data?.message || "Unable to load module packages. Please try again."
          );
        }
      })
      .finally(() => {
        if (!isPoll) setPkgLoading(false);
      });
  }, []);

  const fetchAddons = useCallback((isPoll = false) => {
    if (!isPoll) {
      setAddonLoading(true);
      setAddonError(null);
    }

    return axios
      .get(`${API_BASE_URL}/company/checkout-context`)
      .then((res) => {
        const items = res.data.items || [];
        setAddonItems(items);
        // Cycle/tax also come here — same value as the packages call; set
        // as a fallback so the toggle still shows the right cycle even if
        // the packages call failed.
        setBillingCycle((prev) => res.data.billing_cycle || prev);
        setTaxPercent((prev) => (res.data.tax_percent != null ? res.data.tax_percent : prev));
        setAddonError(null);
      })
      .catch((err) => {
        console.error("Add-ons API Error :", err);
        if (!isPoll) {
          setAddonError(err.response?.data?.message || "Unable to load add-on modules. Please try again.");
        }
      })
      .finally(() => {
        if (!isPoll) setAddonLoading(false);
      });
  }, []);

  useEffect(() => {
    fetchPackages();
    fetchAddons();
  }, [fetchPackages, fetchAddons]);

  // The Super Admin edits pricing / access from a different session —
  // polling reflects that here without a manual refresh.
  usePolling(() => fetchPackages(true), POLL_MS);
  usePolling(() => fetchAddons(true), POLL_MS);

  const priceField = billingCycle === "Yearly" ? "yearly_price" : "monthly_price";
  const cycleUnit = billingCycle === "Yearly" ? "yr" : "mo";

  // --- Module packages: not selectable — the billed set is always exactly
  //     what the Super Admin has assigned + enabled for this company.
  //     checkout_packages enforces the same rule server-side. ---
  const pkgBilled = pkgList.filter((p) => p.owned && p.enabled);
  const pkgSubtotal = pkgBilled.reduce((sum, p) => sum + (p[priceField] || 0), 0);

  // --- Add-ons: not selectable — the billed set is always exactly what's
  //     currently active and not locked for this company. checkout()
  //     enforces the same access_enabled rule server-side. ---
  const addonGrouped = ADDON_CATEGORY_ORDER.map((category) => ({
    category,
    rows: addonItems.filter((i) => i.category === category),
  })).filter((g) => g.rows.length > 0);

  const addonLineTotal = (item) => (item.quantity ?? 1) * (item[priceField] || 0);
  const addonBilled = addonItems.filter((i) => i.currently_active && i.access_enabled !== false);
  const addonSubtotal = addonBilled.reduce((sum, i) => sum + addonLineTotal(i), 0);

  // --- Combined billing total ---
  const combinedSubtotal = pkgSubtotal + addonSubtotal;
  const combinedTax = (combinedSubtotal * taxPercent) / 100;
  const combinedTotal = combinedSubtotal + combinedTax;
  // Nothing here is "changed" (there's nothing to tick) — paying always
  // settles the current bill for whatever's active/assigned.
  const anythingChanged = pkgBilled.length > 0 || addonBilled.length > 0;

  // One Proceed-to-Payment for the combined total — calls the two EXISTING
  // checkout endpoints for whichever part(s) are billable. Each endpoint
  // leaves the other's subscription_items untouched.
  const handleCombinedPay = async () => {
    setPaying(true);
    setPayError(null);

    try {
      if (pkgBilled.length > 0) {
        await axios.post(`${API_BASE_URL}/company/module-packages/checkout`, {
          package_keys: pkgBilled.map((p) => p.package_key),
          billing_cycle: billingCycle,
        });
      }
      if (addonBilled.length > 0) {
        await axios.post(`${API_BASE_URL}/company/checkout`, {
          item_keys: addonBilled.map((i) => i.item_key),
          billing_cycle: billingCycle,
        });
      }

      setConfirmOpen(false);
      setToast({ type: "success", message: "Payment successful — your billing is now up to date." });
      fetchPackages();
      fetchAddons();
      // Refresh this session's own module list so the sidebar reflects any
      // newly-purchased package/module without a re-login.
      axios
        .get(`${API_BASE_URL}/me`)
        .then((res) => updateUser(res.data.user))
        .catch(() => {});
    } catch (err) {
      setPayError(err.response?.data?.message || "Payment failed. Please try again.");
    } finally {
      setPaying(false);
    }
  };

  return (
    <div>
      <PageHeader
        eyebrow="Account"
        title="Billing & Payment"
        description="The module packages and add-ons on your account, priced and assigned by your Super Admin — scoped to your account only."
      />

      <GlassCard className="p-5">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-cyan/10 text-accent-cyan">
            <Boxes size={19} />
          </span>
          <div>
            <p className="font-display text-sm font-semibold text-white">Billing &amp; Payment</p>
            <p className="text-xs text-ink-500">
              Module packages and add-ons are assigned and priced by your Super Admin — review what's active below
              and pay your current bill. A <Lock size={11} className="inline align-[-1px] text-signal-red" /> Locked
              item is disabled by your Super Admin and is never billed. Dashboard, Settings and Subscription &amp;
              Payment are always included, free.
            </p>
          </div>
        </div>

        {/* Billing cycle — drives both sub-sections. */}
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

        {/* -- Module Packages -- */}
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">Module Packages</p>
        {pkgLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-ink-500">
            <Loader2 size={16} className="animate-spin" />
            Loading module packages…
          </div>
        ) : pkgError ? (
          <div className="flex flex-col items-start gap-3 py-4">
            <div className="flex items-start gap-2 text-sm text-signal-red">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>{pkgError}</span>
            </div>
            <button
              type="button"
              onClick={() => fetchPackages()}
              className="rounded-md border border-white/15 px-4 py-2 text-sm font-medium text-ink-200 hover:bg-white/5"
            >
              Retry
            </button>
          </div>
        ) : pkgList.length === 0 ? (
          <div className="py-4 text-sm text-ink-500">
            No module packages are configured yet. Your Super Admin sets these up under Billing &amp; Pricing.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {pkgList.map((p) => {
              // `p.enabled` (global_enabled AND access_enabled) is the
              // Super Admin's package toggle — never hardcoded here. These
              // cards are informational only: no click handlers, nothing
              // for the Company Admin to select.
              const locked = !p.enabled;

              return (
                <div
                  key={p.package_key}
                  className={`flex flex-col rounded-xl border p-4 text-left ${
                    locked
                      ? "border-signal-red/40 bg-signal-red/[0.06]"
                      : p.owned
                      ? "border-signal-green/30 bg-white/[0.02]"
                      : "border-white/10 bg-white/[0.02]"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className={`text-sm font-semibold ${locked ? "text-ink-300" : "text-white"}`}>
                      {p.name}
                    </span>
                    <EntitlementStatusBadge locked={locked} owned={p.owned} />
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs">
                    <span className={locked ? "text-signal-red/70" : "text-ink-200"}>
                      {formatAmount(p.monthly_price)} <span className="text-ink-500">/ mo</span>
                    </span>
                    <span className={locked ? "text-signal-red/70" : "text-ink-200"}>
                      {formatAmount(p.yearly_price)} <span className="text-ink-500">/ yr</span>
                    </span>
                  </div>

                  {locked && (
                    <p className="mt-1.5 text-[11px] font-medium text-signal-red">Locked by Super Admin</p>
                  )}

                  {p.description && (
                    <p className={`mt-1.5 text-xs ${locked ? "text-ink-600" : "text-ink-500"}`}>{p.description}</p>
                  )}

                  <ul className="mt-2.5 space-y-1">
                    {p.submodules.map((s) => {
                      // A sub-module is locked when the Super Admin
                      // disabled it individually (s.enabled === false,
                      // never for kind "always") OR when its whole
                      // package is locked — you can't use any sub-module
                      // of a disabled package.
                      const subLocked = locked || (s.kind !== "always" && !s.enabled);
                      return (
                        <li
                          key={s.submodule_key}
                          className={`flex items-center gap-1.5 text-[11px] ${
                            subLocked ? "text-signal-red/70" : "text-ink-400"
                          }`}
                        >
                          {subLocked ? (
                            <Lock size={11} className="shrink-0 text-signal-red" />
                          ) : (
                            <CheckCircle2 size={11} className="shrink-0 text-signal-green" />
                          )}
                          <span>
                            {s.label}
                            {subLocked && <span className="text-signal-red/60"> — Locked</span>}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        )}

        {/* -- Additional Modules / Add-ons -- */}
        <p className="mb-2 mt-6 text-xs font-semibold uppercase tracking-wide text-ink-400">
          Additional Modules / Add-ons
        </p>
        {addonLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-ink-500">
            <Loader2 size={16} className="animate-spin" />
            Loading add-on modules…
          </div>
        ) : addonError ? (
          <div className="flex flex-col items-start gap-3 py-4">
            <div className="flex items-start gap-2 text-sm text-signal-red">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>{addonError}</span>
            </div>
            <button
              type="button"
              onClick={() => fetchAddons()}
              className="rounded-md border border-white/15 px-4 py-2 text-sm font-medium text-ink-200 hover:bg-white/5"
            >
              Retry
            </button>
          </div>
        ) : addonGrouped.length === 0 ? (
          <div className="py-4 text-sm text-ink-500">No add-on modules are available for your account.</div>
        ) : (
          <div className="space-y-4">
            {addonGrouped.map(({ category, rows }) => (
              <div key={category}>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-500">{category}</p>
                <div className="space-y-2">
                  {rows.map((item) => {
                    // `access_enabled` is the Super Admin's per-company
                    // add-on lock (billing.set_item_access); `currently_active`
                    // is this company's real grant/checkout state — neither
                    // is ever set from a click here, these are info cards.
                    const locked = item.access_enabled === false;

                    return (
                      <div
                        key={item.item_key}
                        className={`rounded-lg border p-3 ${
                          locked ? "border-signal-red/40 bg-signal-red/[0.06]" : "border-white/10 bg-white/[0.02]"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-4">
                          <span className={`text-sm font-medium ${locked ? "text-ink-300" : "text-ink-100"}`}>
                            {item.name}
                          </span>
                          <div className="flex shrink-0 items-center gap-3">
                            <span className={`whitespace-nowrap font-mono text-xs ${locked ? "text-signal-red/70" : "text-ink-200"}`}>
                              {formatAmount(addonLineTotal(item))}
                              <span className={locked ? "text-signal-red/50" : "text-ink-500"}> / {cycleUnit}</span>
                            </span>
                            <EntitlementStatusBadge locked={locked} owned={item.currently_active} />
                          </div>
                        </div>

                        {item.description && (
                          <p className={`mt-1 text-xs ${locked ? "text-ink-600" : "text-ink-500"}`}>
                            {item.description}
                          </p>
                        )}
                        {item.unit_type === "per_camera" && (
                          <p className="mt-1 font-mono text-[11px] text-ink-500">
                            Your usage: {item.quantity} camera{item.quantity === 1 ? "" : "s"} ×{" "}
                            {formatAmount(item[priceField])}
                          </p>
                        )}
                        {item.unit_type === "per_gb" && (
                          <p className="mt-1 font-mono text-[11px] text-ink-500">
                            Your usage: {(item.quantity || 0).toFixed(3)} GB × {formatAmount(item[priceField])}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* -- Combined Billing Total -- */}
        <div className="mt-6 space-y-1.5 border-t border-white/10 pt-4">
          <div className="flex items-center justify-between text-sm text-ink-400">
            <span>Module Packages subtotal</span>
            <span className="font-mono">{formatAmount(pkgSubtotal)}</span>
          </div>
          <div className="flex items-center justify-between text-sm text-ink-400">
            <span>Add-ons subtotal</span>
            <span className="font-mono">{formatAmount(addonSubtotal)}</span>
          </div>
          <div className="flex items-center justify-between border-t border-white/5 pt-1.5 text-sm text-ink-300">
            <span>Subtotal</span>
            <span className="font-mono">{formatAmount(combinedSubtotal)}</span>
          </div>
          {taxPercent > 0 && (
            <div className="flex items-center justify-between text-sm text-ink-400">
              <span>Tax ({taxPercent}%)</span>
              <span className="font-mono">{formatAmount(combinedTax)}</span>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <p className="text-sm text-ink-300">
              Billing Total ({billingCycle}) —{" "}
              <span className="font-mono text-base font-semibold text-white">{formatAmount(combinedTotal)}</span>
            </p>
            <button
              type="button"
              onClick={() => {
                setPayError(null);
                setConfirmOpen(true);
              }}
              disabled={!anythingChanged}
              className="rounded-md bg-accent-cyan px-5 py-2.5 text-sm font-semibold text-black transition hover:bg-accent-cyan/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Proceed to Payment
            </button>
          </div>
          {!anythingChanged && (
            <p className="text-[11px] text-ink-600">This matches your current billing — nothing to pay.</p>
          )}
        </div>
      </GlassCard>

      {/* Payment Gateway (simulated) — combined order summary; only opens on Proceed to Payment. */}
      <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Payment Gateway" size="lg">
        <div className="space-y-5">
          <div className="rounded-lg border border-white/10 p-4">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-500">Billing To</p>
            <p className="text-sm font-medium text-ink-100">{user?.name}</p>
            <p className="text-xs text-ink-400">{user?.email}</p>
          </div>

          {pkgBilled.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-500">Module Packages</p>
              <div className="divide-y divide-white/5 rounded-lg border border-white/10">
                {pkgBilled.map((p) => (
                  <div key={p.package_key} className="flex items-center justify-between px-4 py-2.5 text-sm">
                    <span className="text-ink-200">{p.name}</span>
                    <span className="font-mono text-ink-300">{formatAmount(p[priceField] || 0)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {addonBilled.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-500">Add-ons</p>
              <div className="divide-y divide-white/5 rounded-lg border border-white/10">
                {addonBilled.map((i) => (
                  <div key={i.item_key} className="flex items-center justify-between px-4 py-2.5 text-sm">
                    <span className="text-ink-200">{i.name}</span>
                    <span className="font-mono text-ink-300">{formatAmount(addonLineTotal(i))}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {pkgBilled.length === 0 && addonBilled.length === 0 && (
            <p className="text-sm text-ink-400">No active packages or add-ons on your account.</p>
          )}

          <div className="flex items-center justify-between rounded-lg bg-white/5 px-4 py-3">
            <span className="text-sm text-ink-300">Billing Cycle</span>
            <span className="text-sm font-medium text-ink-100">{billingCycle}</span>
          </div>

          <div className="space-y-1.5 rounded-lg bg-white/5 px-4 py-3">
            <div className="flex items-center justify-between text-sm text-ink-300">
              <span>Subtotal</span>
              <span className="font-mono">{formatAmount(combinedSubtotal)}</span>
            </div>
            {taxPercent > 0 && (
              <div className="flex items-center justify-between text-sm text-ink-300">
                <span>Tax ({taxPercent}%)</span>
                <span className="font-mono">{formatAmount(combinedTax)}</span>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between rounded-lg bg-accent-cyan/10 px-4 py-3">
            <span className="text-sm font-medium text-white">Total Due</span>
            <span className="font-mono text-lg font-semibold text-accent-cyan">{formatAmount(combinedTotal)}</span>
          </div>

          {payError && (
            <div className="flex items-start gap-2 rounded-md border border-signal-red/30 bg-signal-red/10 px-3.5 py-2.5 text-xs text-signal-red">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{payError}</span>
            </div>
          )}

          <p className="text-[11px] text-ink-600">
            Simulated payment gateway — no real charge is made. This confirms activation for your account only.
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
              onClick={handleCombinedPay}
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
