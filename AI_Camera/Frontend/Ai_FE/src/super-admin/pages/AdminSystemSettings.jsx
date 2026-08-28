import { useEffect, useRef, useState } from "react";
import axios from "axios";
import { Settings, ImageUp, Save, Sun, Moon, Trash2, AlertTriangle } from "lucide-react";
import AdminPageHeader from "../ui/AdminPageHeader";
import AdminCard from "../ui/AdminCard";
import AdminButton from "../ui/AdminButton";
import AdminToast from "../ui/AdminToast";
import AdminSelect from "../ui/AdminSelect";
import { useAdminTheme } from "../context/AdminThemeContext";
import { useAdminBranding } from "../context/AdminBrandingContext";
import { DATA_EVENTS, emitDataEvent } from "../../lib/dataEvents";
import { validateTextField, validateFileUpload, INVALID_INPUT_CLASS } from "../../lib/validation";
import { API_BASE_URL } from "../../lib/apiBase";

const inputClass =
  "w-full rounded-md admin-panel px-3.5 py-2.5 text-sm text-ink-100 placeholder:text-ink-500 outline-none focus:border-admin-accent/50 focus:ring-2 focus:ring-admin-accent/20";

const ACCEPTED_LOGO_EXTENSIONS = ["jpg", "jpeg", "png", "webp"];
const MAX_LOGO_BYTES = 5 * 1024 * 1024;
const APP_NAME_MIN = 3;
const APP_NAME_MAX = 50;

function Field({ label, children }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-ink-400">{label}</label>
      {children}
    </div>
  );
}

export default function AdminSystemSettings() {
  const { theme, setTheme } = useAdminTheme();
  const { branding, setBranding, loading } = useAdminBranding();

  const [appName, setAppName] = useState(branding.app_name);
  const [nameError, setNameError] = useState(null);
  const [nameTouched, setNameTouched] = useState(false);
  const [savingName, setSavingName] = useState(false);

  const [logoUploading, setLogoUploading] = useState(false);
  const [logoRemoving, setLogoRemoving] = useState(false);

  const [toast, setToast] = useState(null);
  const logoInputRef = useRef(null);

  // Keeps the editable field in sync with whatever the context currently
  // holds — the initial load once /branding resolves, and again right
  // after a successful save (so re-rendering from the canonical saved
  // value can never drift from what the Sidebar is now showing).
  useEffect(() => {
    setAppName(branding.app_name);
  }, [branding.app_name]);

  const trimmedName = appName.trim();
  const nameUnchanged = trimmedName === branding.app_name;
  const nameValidationError = validateTextField(appName, "Application Name", {
    minLen: APP_NAME_MIN,
    maxLen: APP_NAME_MAX,
    addressLike: true,
  });

  const handleSaveName = (e) => {
    e.preventDefault();
    setNameTouched(true);
    setNameError(null);

    if (nameValidationError) {
      return;
    }

    // Nothing actually changed (after trimming) — skip the network
    // round-trip entirely rather than saving an identical value again.
    if (nameUnchanged) {
      return;
    }

    setSavingName(true);

    axios
      .put(`${API_BASE_URL}/branding/app-name`, { name: trimmedName })
      .then((res) => {
        setBranding((prev) => ({ ...prev, app_name: res.data.app_name }));
        emitDataEvent(DATA_EVENTS.BRANDING_CHANGED);
        setToast({ type: "success", message: "Application Name saved successfully." });
      })
      .catch((err) => {
        const message = err.response?.data?.message || "Failed to save Application Name.";
        setNameError(message);
        setToast({ type: "error", message });
      })
      .finally(() => setSavingName(false));
  };

  const handleLogoFileChange = (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    const fileError = validateFileUpload(file, {
      allowedExtensions: ACCEPTED_LOGO_EXTENSIONS.map((ext) => `.${ext}`),
      maxBytes: MAX_LOGO_BYTES,
      label: "Logo",
    });

    if (fileError) {
      setToast({ type: "error", message: fileError });
      return;
    }

    setLogoUploading(true);

    const formData = new FormData();
    formData.append("logo", file);

    axios
      .put(`${API_BASE_URL}/branding/logo`, formData)
      .then((res) => {
        setBranding({ app_name: res.data.app_name, logo_url: res.data.logo_url });
        emitDataEvent(DATA_EVENTS.BRANDING_CHANGED);
        setToast({ type: "success", message: "Logo updated successfully." });
      })
      .catch((err) => {
        setToast({ type: "error", message: err.response?.data?.message || "Failed to update logo." });
      })
      .finally(() => setLogoUploading(false));
  };

  const handleRemoveLogo = () => {
    setLogoRemoving(true);

    axios
      .delete(`${API_BASE_URL}/branding/logo`)
      .then((res) => {
        setBranding({ app_name: res.data.app_name, logo_url: res.data.logo_url });
        emitDataEvent(DATA_EVENTS.BRANDING_CHANGED);
        setToast({ type: "success", message: "Logo removed successfully." });
      })
      .catch(() => {
        setToast({ type: "error", message: "Failed to remove logo." });
      })
      .finally(() => setLogoRemoving(false));
  };

  return (
    <div>
      <AdminPageHeader
        eyebrow="Configuration"
        title="System Settings"
        description="Platform-wide branding and appearance."
      />

      <AdminCard className="max-w-2xl p-5">
        <div className="mb-5 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-md bg-admin-accent/10 text-admin-accent">
            <Settings size={19} />
          </span>
          <div>
            <p className="font-display text-sm font-semibold text-white">General</p>
            <p className="text-xs text-ink-500">More settings can be added here over time</p>
          </div>
        </div>

        {/* Add future settings fields below, following the same <Field> pattern. */}
        <form className="space-y-4" onSubmit={handleSaveName}>
          <Field label="Application Name">
            <input
              type="text"
              value={appName}
              onChange={(e) => setAppName(e.target.value)}
              onBlur={() => setNameTouched(true)}
              disabled={loading}
              className={`${inputClass} ${nameTouched && nameValidationError ? INVALID_INPUT_CLASS : ""}`}
            />
            {nameTouched && nameValidationError && (
              <p className="mt-1.5 text-xs text-red-400">{nameValidationError}</p>
            )}
            {nameError && (
              <div className="mt-2 flex items-start gap-2 rounded-md border border-signal-red/30 bg-signal-red/10 px-3.5 py-2.5 text-xs text-signal-red">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>{nameError}</span>
              </div>
            )}
          </Field>

          <Field label="Logo">
            <div className="flex flex-wrap items-center gap-4">
              {branding.logo_url ? (
                <img
                  src={branding.logo_url}
                  alt="Platform logo"
                  className="h-14 w-14 rounded-md object-cover ring-1 ring-white/10"
                />
              ) : (
                <span className="flex h-14 w-14 items-center justify-center rounded-md bg-white/[0.03] text-ink-500 ring-1 ring-white/10">
                  <ImageUp size={20} />
                </span>
              )}
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap gap-3">
                  <AdminButton
                    type="button"
                    variant="secondary"
                    icon={ImageUp}
                    onClick={() => logoInputRef.current?.click()}
                    disabled={logoUploading || logoRemoving}
                  >
                    {logoUploading ? "Uploading…" : branding.logo_url ? "Change Logo" : "Upload Logo"}
                  </AdminButton>
                  {branding.logo_url && (
                    <AdminButton
                      type="button"
                      variant="danger"
                      icon={Trash2}
                      onClick={handleRemoveLogo}
                      disabled={logoUploading || logoRemoving}
                    >
                      {logoRemoving ? "Removing…" : "Remove Logo"}
                    </AdminButton>
                  )}
                </div>
                <p className="text-xs text-ink-500">JPG, JPEG, PNG, or WEBP. Maximum size 5MB.</p>
              </div>
              <input
                ref={logoInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={handleLogoFileChange}
              />
            </div>
          </Field>

          <Field label="Theme">
            <div className="relative">
              {theme === "dark" ? (
                <Moon size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-500" />
              ) : (
                <Sun size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-500" />
              )}
              <AdminSelect
                value={theme}
                onChange={setTheme}
                options={[
                  { value: "dark", label: "Dark" },
                  { value: "light", label: "Light" },
                ]}
                triggerClassName="pl-10"
              />
            </div>
            <p className="mt-1.5 text-xs text-ink-500">
              Applies immediately across the Super Admin Console and is remembered the next time you sign in.
            </p>
          </Field>

          <div className="pt-2">
            <AdminButton
              type="submit"
              icon={Save}
              disabled={savingName || nameUnchanged || loading || !!nameValidationError}
            >
              {savingName ? "Saving…" : "Save Settings"}
            </AdminButton>
          </div>
        </form>
      </AdminCard>

      <AdminToast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
