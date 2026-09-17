import { useEffect, useRef, useState } from "react";
import axios from "axios";
import {
  Sparkles,
  ShieldCheck,
  UserX,
  Flame,
  Headset,
  Globe,
  Layers,
  ImageUp,
  Save,
  Loader2,
  AlertTriangle,
  CreditCard,
} from "lucide-react";
import AdminPageHeader from "../ui/AdminPageHeader";
import AdminCard from "../ui/AdminCard";
import AdminButton from "../ui/AdminButton";
import AdminToast from "../ui/AdminToast";
import AdminToggle from "../ui/AdminToggle";
import { validateFileUpload } from "../../lib/validation";
import { API_BASE_URL } from "../../lib/apiBase";

// Super Admin > System Settings > Website Settings — every editable
// piece of the public Zynez landing page (Frontend/Ai_FE/src/pages/
// Landing.jsx), backed by Backend/api/website_content.py. Module Package
// pricing (PricingCard below) is DELIBERATELY not part of that module —
// it reads/writes the same GET/PUT /module-packages endpoints the
// existing Billing & Pricing page (/super-admin/billing/pricing) already
// uses, so there is exactly one place package prices are ever stored.
//
// ExtendPlatformCard (further down) is its own separate card — kept
// apart from PricingCard/Module Package pricing on purpose (explicit
// user request) — and itself has two independent halves:
//   1. The "starting from" banner figure: website_content's
//      "extend_platform" section (monthly_price/yearly_price), no
//      BillableItem behind it, saved via PUT /website-content/
//      extend_platform like every other text field on this page.
//   2. The actual per-item add-on grid shown on the landing page below
//      that banner (Additional Camera, Platform Hosting, WhatsApp Daily
//      Report, WhatsApp Unknown Person Alerts, Cloud Storage, and any
//      other item a Super Admin later adds) — this reads/writes the SAME
//      GET/PUT /billing/items endpoints AdminBillingPricing.jsx's
//      "Add-ons" section already uses. Editing a price here or there
//      changes the exact same BillableItem row; this is a second UI
//      surface onto that one existing catalog, not a second store, for
//      the Super Admin's convenience — everything shown in "Extend your
//      platform" on the landing page is now editable from one place.

const inputClass =
  "w-full rounded-md admin-panel px-3.5 py-2.5 text-sm text-ink-100 placeholder:text-ink-500 outline-none focus:border-admin-accent/50 focus:ring-2 focus:ring-admin-accent/20";

const ACCEPTED_IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// One entry per SectionCard rendered below — drives the generic form
// instead of writing near-identical Hero/AI/Unknown/Fire/General cards
// by hand. `image` names the slot key api/website_content.py's
// IMAGE_SLOTS expects (omitted for "contact", which has no image).
const SECTIONS = [
  {
    key: "hero",
    title: "Hero Section",
    icon: Sparkles,
    subtitle: "The first thing every visitor sees.",
    image: "hero",
    imageLabel: "Hero Image",
    fields: [
      { key: "heading", label: "Heading", type: "textarea", rows: 2, hint: "Press Enter for a manual line break, or leave it as one line and it will wrap on its own.", maxLen: 150 },
      { key: "description", label: "Description", type: "textarea", maxLen: 500 },
      { key: "cta_text", label: "CTA Text", type: "text", maxLen: 60 },
    ],
  },
  {
    key: "ai_detection",
    title: "AI Detection Section",
    icon: ShieldCheck,
    subtitle: "How Zynez detects and understands events.",
    image: "ai_detection",
    imageLabel: "Section Image / Visual",
    fields: [
      { key: "heading", label: "Heading", type: "textarea", rows: 2, hint: "Press Enter for a manual line break, or leave it as one line and it will wrap on its own.", maxLen: 150 },
      { key: "description", label: "Description", type: "textarea", maxLen: 500 },
      { key: "feature_text", label: "Detection Feature Text", type: "text", maxLen: 200 },
    ],
  },
  {
    key: "unknown_person",
    title: "Unknown Person Section",
    icon: UserX,
    subtitle: "Unknown-person detection and alerts.",
    image: "unknown_person",
    imageLabel: "Image",
    fields: [
      { key: "heading", label: "Heading", type: "textarea", rows: 2, hint: "Press Enter for a manual line break, or leave it as one line and it will wrap on its own.", maxLen: 150 },
      { key: "description", label: "Description", type: "textarea", maxLen: 500 },
      { key: "alert_text", label: "Alert Text", type: "text", maxLen: 100 },
    ],
  },
  {
    key: "fire_detection",
    title: "Fire Detection Section",
    icon: Flame,
    subtitle: "Fire and smoke detection and alerts.",
    image: "fire_detection",
    imageLabel: "Fire Image",
    fields: [
      { key: "heading", label: "Heading", type: "textarea", rows: 2, hint: "Press Enter for a manual line break, or leave it as one line and it will wrap on its own.", maxLen: 150 },
      { key: "description", label: "Description", type: "textarea", maxLen: 500 },
      { key: "alert_text", label: "Alert Text", type: "text", maxLen: 100 },
    ],
  },
  {
    key: "contact",
    title: "Contact Section",
    icon: Headset,
    subtitle: "Contact details shown on the landing page.",
    fields: [
      { key: "heading", label: "Heading", type: "textarea", rows: 2, hint: "Press Enter for a manual line break, or leave it as one line and it will wrap on its own.", maxLen: 150 },
      { key: "description", label: "Description", type: "textarea", maxLen: 500 },
      { key: "email", label: "Email", type: "text", maxLen: 150 },
      { key: "phone", label: "Phone", type: "text", maxLen: 30 },
      { key: "location", label: "Location", type: "text", maxLen: 150 },
      { key: "info_text", label: "Contact Information", type: "textarea", maxLen: 200 },
    ],
  },
  {
    key: "general",
    title: "General Website",
    icon: Globe,
    subtitle: "Site-wide name, logo, and footer text.",
    image: "logo",
    imageLabel: "Logo",
    fields: [
      { key: "website_name", label: "Website Name", type: "text", maxLen: 50 },
      { key: "footer_text", label: "Footer Text", type: "textarea", maxLen: 300 },
    ],
  },
];

function Field({ label, hint, children }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-ink-400">{label}</label>
      {children}
      {hint && <p className="mt-1.5 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

// One card per SECTIONS entry: its own local form state, its own Save
// (PUT /website-content/<section>), and — when `image` is set — its own
// image slot with an instant local preview (URL.createObjectURL) held
// until a separate "Save Image" click uploads it (PUT
// /website-content/image/<slot>). Previewing before uploading is a
// deliberate difference from AdminSystemSettings.jsx's Platform Logo
// (which uploads the moment a file is chosen) — this page's spec asks
// for a preview step before anything is saved.
function SectionCard({ section, content, onSaved, setToast }) {
  const { key, title, icon: Icon, subtitle, fields, image, imageLabel } = section;

  const [form, setForm] = useState(() =>
    Object.fromEntries(fields.map((f) => [f.key, content[key]?.[f.key] || ""])),
  );
  const [fieldError, setFieldError] = useState(null);
  const [saving, setSaving] = useState(false);

  const [imageFile, setImageFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [imageUploading, setImageUploading] = useState(false);
  const imageInputRef = useRef(null);

  // Re-sync from the canonical saved content whenever it changes
  // (initial load, or after this card's own successful save) — never
  // while the admin still has unsaved local edits mid-typing, since this
  // effect only fires on `content` identity changes, not on `form`.
  useEffect(() => {
    setForm(Object.fromEntries(fields.map((f) => [f.key, content[key]?.[f.key] || ""])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const handleFieldChange = (fieldKey, value) => {
    setForm((prev) => ({ ...prev, [fieldKey]: value }));
  };

  const handleSaveText = (e) => {
    e.preventDefault();
    setFieldError(null);
    setSaving(true);

    axios
      .put(`${API_BASE_URL}/website-content/${key}`, form)
      .then((res) => {
        onSaved(res.data);
        setToast({ type: "success", message: `${title} saved successfully.` });
      })
      .catch((err) => {
        const message = err.response?.data?.message || `Failed to save ${title}.`;
        setFieldError(message);
        setToast({ type: "error", message });
      })
      .finally(() => setSaving(false));
  };

  const handleImageFileChange = (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    const fileError = validateFileUpload(file, {
      allowedExtensions: ACCEPTED_IMAGE_EXTENSIONS,
      maxBytes: MAX_IMAGE_BYTES,
      label: imageLabel,
    });

    if (fileError) {
      setToast({ type: "error", message: fileError });
      return;
    }

    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setImageFile(file);
    setPreviewUrl(URL.createObjectURL(file));
  };

  const handleSaveImage = () => {
    if (!imageFile) return;
    setImageUploading(true);

    const formData = new FormData();
    formData.append("image", imageFile);

    axios
      .put(`${API_BASE_URL}/website-content/image/${image}`, formData)
      .then((res) => {
        onSaved(res.data);
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        setImageFile(null);
        setPreviewUrl(null);
        setToast({ type: "success", message: `${imageLabel} updated successfully.` });
      })
      .catch((err) => {
        setToast({ type: "error", message: err.response?.data?.message || `Failed to update ${imageLabel}.` });
      })
      .finally(() => setImageUploading(false));
  };

  const currentImageUrl = image
    ? content[key]?.[image === "logo" ? "logo_url" : "image_url"]
    : null;
  const displayedImageUrl = previewUrl || currentImageUrl;

  return (
    <AdminCard className="p-5">
      <div className="mb-5 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-md bg-admin-accent/10 text-admin-accent">
          <Icon size={19} />
        </span>
        <div>
          <p className="font-display text-sm font-semibold text-white">{title}</p>
          <p className="text-xs text-ink-500">{subtitle}</p>
        </div>
      </div>

      <form className="space-y-4" onSubmit={handleSaveText}>
        {fields.map((f) => (
          <Field key={f.key} label={f.label} hint={f.hint}>
            {f.type === "textarea" ? (
              <textarea
                rows={f.rows || 3}
                value={form[f.key]}
                maxLength={f.maxLen}
                onChange={(e) => handleFieldChange(f.key, e.target.value)}
                className={inputClass}
              />
            ) : (
              <input
                type="text"
                value={form[f.key]}
                maxLength={f.maxLen}
                onChange={(e) => handleFieldChange(f.key, e.target.value)}
                className={inputClass}
              />
            )}
          </Field>
        ))}

        {fieldError && (
          <div className="flex items-start gap-2 rounded-md border border-signal-red/30 bg-signal-red/10 px-3.5 py-2.5 text-xs text-signal-red">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{fieldError}</span>
          </div>
        )}

        <div className="pt-1">
          <AdminButton type="submit" icon={Save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </AdminButton>
        </div>
      </form>

      {image && (
        <div className="mt-5 border-t border-white/10 pt-5">
          <Field label={imageLabel}>
            <div className="flex flex-wrap items-center gap-4">
              {displayedImageUrl ? (
                <img
                  src={displayedImageUrl}
                  alt={imageLabel}
                  className="h-16 w-24 rounded-md object-cover ring-1 ring-white/10"
                />
              ) : (
                <span className="flex h-16 w-24 items-center justify-center rounded-md bg-white/[0.03] text-ink-500 ring-1 ring-white/10">
                  <ImageUp size={20} />
                </span>
              )}
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap gap-3">
                  <AdminButton
                    type="button"
                    variant="secondary"
                    icon={ImageUp}
                    onClick={() => imageInputRef.current?.click()}
                    disabled={imageUploading}
                  >
                    {currentImageUrl ? "Change Image" : "Upload Image"}
                  </AdminButton>
                  {imageFile && (
                    <AdminButton type="button" icon={Save} onClick={handleSaveImage} disabled={imageUploading}>
                      {imageUploading ? "Uploading…" : "Save Image"}
                    </AdminButton>
                  )}
                </div>
                <p className="text-xs text-ink-500">
                  {imageFile ? "Preview shown — click Save Image to publish it." : "JPG, JPEG, PNG, or WEBP. Maximum size 5MB."}
                </p>
              </div>
              <input
                ref={imageInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={handleImageFileChange}
              />
            </div>
          </Field>
        </div>
      )}
    </AdminCard>
  );
}

// Pricing / Module Packages — deliberately reuses the SAME endpoints
// AdminBillingPricing.jsx already calls (GET/PUT /module-packages),
// global scope (no customer_id), so this is a second view onto the one
// existing pricing store, never a second store.
function PricingCard({ setToast }) {
  const [packages, setPackages] = useState(null);
  const [loading, setLoading] = useState(true);
  const [forms, setForms] = useState({});
  const [savingKey, setSavingKey] = useState(null);

  const load = () => {
    setLoading(true);
    axios
      .get(`${API_BASE_URL}/module-packages`)
      .then((res) => {
        setPackages(res.data.packages);
        setForms(
          Object.fromEntries(
            res.data.packages.map((p) => [
              p.package_key,
              { monthly_price: String(p.monthly_price ?? 0), yearly_price: String(p.yearly_price ?? 0), enabled: p.enabled },
            ]),
          ),
        );
      })
      .catch(() => setToast({ type: "error", message: "Failed to load module package pricing." }))
      .finally(() => setLoading(false));
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, []);

  const setField = (key, field, value) => {
    setForms((prev) => ({ ...prev, [key]: { ...prev[key], [field]: value } }));
  };

  const handleSave = (packageKey) => {
    const form = forms[packageKey];
    const monthly = Number(form.monthly_price);
    const yearly = Number(form.yearly_price);

    if (form.monthly_price === "" || Number.isNaN(monthly) || monthly < 0) {
      setToast({ type: "error", message: "Enter a valid monthly price." });
      return;
    }
    if (form.yearly_price === "" || Number.isNaN(yearly) || yearly < 0) {
      setToast({ type: "error", message: "Enter a valid yearly price." });
      return;
    }

    setSavingKey(packageKey);

    axios
      .put(`${API_BASE_URL}/module-packages/${packageKey}`, {
        monthly_price: monthly,
        yearly_price: yearly,
        enabled: form.enabled,
      })
      .then(() => {
        setToast({ type: "success", message: "Pricing saved successfully." });
        load();
      })
      .catch((err) => {
        setToast({ type: "error", message: err.response?.data?.message || "Failed to save pricing." });
      })
      .finally(() => setSavingKey(null));
  };

  return (
    <AdminCard className="p-5">
      <div className="mb-5 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-md bg-admin-accent/10 text-admin-accent">
          <CreditCard size={19} />
        </span>
        <div>
          <p className="font-display text-sm font-semibold text-white">Pricing / Module Packages</p>
          <p className="text-xs text-ink-500">
            Cameras, People, Security &amp; Detection, and Reports — the same catalog as Billing &amp; Pricing.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-8 text-ink-500">
          <Loader2 size={18} className="animate-spin" />
          <span className="text-xs">Loading pricing…</span>
        </div>
      ) : (
        <div className="space-y-4">
          {packages.map((pkg) => {
            const form = forms[pkg.package_key];
            return (
              <div key={pkg.package_key} className="rounded-md border border-white/10 p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold text-white">{pkg.name}</p>
                  <AdminToggle
                    checked={form.enabled}
                    onChange={(v) => setField(pkg.package_key, "enabled", v)}
                    disabled={savingKey === pkg.package_key}
                  />
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Monthly Price">
                    <input
                      type="number"
                      min={0}
                      value={form.monthly_price}
                      onChange={(e) => setField(pkg.package_key, "monthly_price", e.target.value)}
                      className={inputClass}
                    />
                  </Field>
                  <Field label="Yearly Price">
                    <input
                      type="number"
                      min={0}
                      value={form.yearly_price}
                      onChange={(e) => setField(pkg.package_key, "yearly_price", e.target.value)}
                      className={inputClass}
                    />
                  </Field>
                </div>
                <div className="mt-3">
                  <AdminButton
                    icon={Save}
                    onClick={() => handleSave(pkg.package_key)}
                    disabled={savingKey === pkg.package_key}
                  >
                    {savingKey === pkg.package_key ? "Saving…" : "Save"}
                  </AdminButton>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </AdminCard>
  );
}

// Extend Your Platform Pricing — everything the landing page's "Extend
// your platform" section shows, in one card:
//   1. The "starting from" banner price (website_content's
//      "extend_platform" section, PUT /website-content/extend_platform,
//      `content`/`onSaved` props same as SectionCard receives).
//   2. Every add-on item in the grid below that banner — the SAME
//      GET/PUT /billing/items endpoints AdminBillingPricing.jsx's own
//      "Add-ons" section already uses (Additional Camera, Platform
//      Hosting, WhatsApp Daily Report, WhatsApp Unknown Person Alerts,
//      Cloud Storage today, plus anything added later). A second UI
//      surface onto that one existing catalog, never a second store —
//      editing a price here changes the exact same BillableItem row
//      Billing & Payments > Pricing edits.
function ExtendPlatformCard({ content, onSaved, setToast }) {
  const [bannerForm, setBannerForm] = useState({ monthly_price: "", yearly_price: "" });
  const [bannerSaving, setBannerSaving] = useState(false);

  useEffect(() => {
    setBannerForm({
      monthly_price: content?.extend_platform?.monthly_price || "",
      yearly_price: content?.extend_platform?.yearly_price || "",
    });
  }, [content]);

  const setBannerField = (field, value) => {
    setBannerForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleSaveBanner = (e) => {
    e.preventDefault();
    const monthly = Number(bannerForm.monthly_price);
    const yearly = Number(bannerForm.yearly_price);

    if (bannerForm.monthly_price === "" || Number.isNaN(monthly) || monthly < 0) {
      setToast({ type: "error", message: "Enter a valid banner monthly price." });
      return;
    }
    if (bannerForm.yearly_price === "" || Number.isNaN(yearly) || yearly < 0) {
      setToast({ type: "error", message: "Enter a valid banner yearly price." });
      return;
    }

    setBannerSaving(true);

    axios
      .put(`${API_BASE_URL}/website-content/extend_platform`, { monthly_price: monthly, yearly_price: yearly })
      .then((res) => {
        onSaved(res.data);
        setToast({ type: "success", message: "Banner price saved successfully." });
      })
      .catch((err) => {
        setToast({ type: "error", message: err.response?.data?.message || "Failed to save banner price." });
      })
      .finally(() => setBannerSaving(false));
  };

  const [items, setItems] = useState([]);
  const [itemsLoading, setItemsLoading] = useState(true);
  const [itemForms, setItemForms] = useState({});
  const [savingItemId, setSavingItemId] = useState(null);

  const loadItems = () => {
    setItemsLoading(true);
    axios
      .get(`${API_BASE_URL}/billing/items`)
      .then((res) => {
        const list = res.data.items || [];
        setItems(list);
        setItemForms(
          Object.fromEntries(
            list.map((item) => [
              item.id,
              { monthly_price: String(item.monthly_price ?? 0), yearly_price: String(item.yearly_price ?? 0), enabled: item.enabled },
            ]),
          ),
        );
      })
      .catch(() => setToast({ type: "error", message: "Failed to load add-on items." }))
      .finally(() => setItemsLoading(false));
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(loadItems, []);

  const setItemField = (id, field, value) => {
    setItemForms((prev) => ({ ...prev, [id]: { ...prev[id], [field]: value } }));
  };

  const handleSaveItem = (item) => {
    const form = itemForms[item.id];
    const monthly = Number(form.monthly_price);
    const yearly = Number(form.yearly_price);

    if (form.monthly_price === "" || Number.isNaN(monthly) || monthly < 0) {
      setToast({ type: "error", message: "Enter a valid monthly price." });
      return;
    }
    if (form.yearly_price === "" || Number.isNaN(yearly) || yearly < 0) {
      setToast({ type: "error", message: "Enter a valid yearly price." });
      return;
    }

    setSavingItemId(item.id);

    axios
      .put(`${API_BASE_URL}/billing/items/${item.id}`, {
        monthly_price: monthly,
        yearly_price: yearly,
        enabled: form.enabled,
      })
      .then((res) => {
        setItems(res.data.items || []);
        setToast({ type: "success", message: `${item.name} price saved successfully.` });
      })
      .catch((err) => {
        setToast({ type: "error", message: err.response?.data?.message || "Failed to save price." });
      })
      .finally(() => setSavingItemId(null));
  };

  return (
    <AdminCard className="p-5 lg:col-span-2">
      <div className="mb-5 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-md bg-admin-accent/10 text-admin-accent">
          <Layers size={19} />
        </span>
        <div>
          <p className="font-display text-sm font-semibold text-white">Extend Your Platform Pricing</p>
          <p className="text-xs text-ink-500">
            Everything shown in the landing page&apos;s “Extend your platform” section — the banner price and every
            add-on item.
          </p>
        </div>
      </div>

      <form className="space-y-4 border-b border-white/10 pb-5" onSubmit={handleSaveBanner}>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-300">Banner Price</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Monthly Price (₹)">
            <input
              type="number"
              min={0}
              step="0.01"
              value={bannerForm.monthly_price}
              onChange={(e) => setBannerField("monthly_price", e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Yearly Price (₹)">
            <input
              type="number"
              min={0}
              step="0.01"
              value={bannerForm.yearly_price}
              onChange={(e) => setBannerField("yearly_price", e.target.value)}
              className={inputClass}
            />
          </Field>
        </div>
        <div className="pt-1">
          <AdminButton type="submit" icon={Save} disabled={bannerSaving}>
            {bannerSaving ? "Saving…" : "Save Banner Price"}
          </AdminButton>
        </div>
      </form>

      <div className="mt-5">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-300">Add-on Items</p>
        {itemsLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-ink-500">
            <Loader2 size={18} className="animate-spin" />
            <span className="text-xs">Loading add-on items…</span>
          </div>
        ) : items.length === 0 ? (
          <p className="py-6 text-center text-xs text-ink-500">
            No add-on items yet — add one from Billing &amp; Payments &gt; Pricing.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {items.map((item) => {
              const form = itemForms[item.id];
              return (
                <div key={item.id} className="rounded-md border border-white/10 p-4">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-white">{item.name}</p>
                      <p className="text-[11px] text-ink-500">{item.category}</p>
                    </div>
                    <AdminToggle
                      checked={form.enabled}
                      onChange={(v) => setItemField(item.id, "enabled", v)}
                      disabled={savingItemId === item.id}
                    />
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field label="Monthly Price">
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={form.monthly_price}
                        onChange={(e) => setItemField(item.id, "monthly_price", e.target.value)}
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Yearly Price">
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={form.yearly_price}
                        onChange={(e) => setItemField(item.id, "yearly_price", e.target.value)}
                        className={inputClass}
                      />
                    </Field>
                  </div>
                  <div className="mt-3">
                    <AdminButton icon={Save} onClick={() => handleSaveItem(item)} disabled={savingItemId === item.id}>
                      {savingItemId === item.id ? "Saving…" : "Save"}
                    </AdminButton>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </AdminCard>
  );
}

export default function AdminWebsiteSettings() {
  const [content, setContent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const load = () => {
    setLoading(true);
    setError(null);
    axios
      .get(`${API_BASE_URL}/public/website-content`)
      .then((res) => setContent(res.data))
      .catch(() => setError("Unable to load website content. Please check the server and try again."))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  return (
    <div>
      <AdminPageHeader
        eyebrow="Configuration"
        title="Website Settings"
        description="Edit the public Zynez landing page — changes appear there automatically once saved."
      />

      {loading ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-ink-500">
          <Loader2 size={22} className="animate-spin" />
          <p className="text-xs">Loading website content…</p>
        </div>
      ) : error ? (
        <AdminCard className="p-6 text-center">
          <p className="text-sm text-ink-300">{error}</p>
          <div className="mt-4 flex justify-center">
            <AdminButton variant="secondary" onClick={load}>
              Retry
            </AdminButton>
          </div>
        </AdminCard>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {SECTIONS.map((section) => (
            <SectionCard key={section.key} section={section} content={content} onSaved={setContent} setToast={setToast} />
          ))}
          <PricingCard setToast={setToast} />
          <ExtendPlatformCard content={content} onSaved={setContent} setToast={setToast} />
        </div>
      )}

      <AdminToast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
