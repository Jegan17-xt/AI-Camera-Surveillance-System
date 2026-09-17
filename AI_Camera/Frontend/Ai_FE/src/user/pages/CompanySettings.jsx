import { useEffect, useRef, useState } from "react";
import axios from "axios";
import { UserCircle, Monitor, HardDrive, Save, Loader2 } from "lucide-react";
import PageHeader from "../../components/ui/PageHeader";
import GlassCard from "../../components/ui/GlassCard";
import Button from "../../components/ui/Button";
import Modal from "../../components/ui/Modal";
import Toast from "../../components/ui/Toast";
import { useAuth } from "../../context/AuthContext";
import { API_BASE_URL } from "../../lib/apiBase";
import { DATA_EVENTS, emitDataEvent } from "../../lib/dataEvents";
import { validateNumberRange, validateFileUpload, hasNoErrors, INVALID_INPUT_CLASS } from "../../lib/validation";
import { Field, ManagingSettingsFor, SectionHeading, inputClass, useSettingsTarget } from "../../components/settings/settingsShared";

// User-portal counterpart of admin/pages/CompanySettings.jsx — Profile
// photo + System refresh interval + Storage clear-data actions, none of
// which were admin-gated on the old combined page. No reset button here
// either (same reasoning as the Admin page: its one resettable field,
// Dashboard Refresh Interval, is covered by Detection Settings' reset,
// disclosed there).
const CLEAR_ACTIONS = {
  unknownImages: {
    label: "Clear Unknown Images",
    confirmTitle: "Clear Unknown Images",
    confirmText: "This permanently deletes every unknown person record, face image, frame image, and embedding. This action cannot be undone.",
    method: "delete",
    url: `${API_BASE_URL}/unknown-persons`,
    successMessage: "Unknown images cleared successfully.",
    event: DATA_EVENTS.UNKNOWN_PERSONS_CHANGED,
  },
  attendanceLogs: {
    label: "Clear Attendance Logs",
    confirmTitle: "Clear Attendance Logs",
    confirmText: "This permanently deletes every attendance record. This action cannot be undone.",
    method: "delete",
    url: `${API_BASE_URL}/attendance`,
    successMessage: "Attendance logs cleared successfully.",
    event: DATA_EVENTS.ATTENDANCE_CHANGED,
  },
  activityLogs: {
    label: "Clear Activity Logs",
    confirmTitle: "Clear Activity Logs",
    confirmText: "This permanently deletes every activity log entry. This action cannot be undone.",
    method: "delete",
    url: `${API_BASE_URL}/activity-logs`,
    successMessage: "Activity logs cleared successfully.",
    event: DATA_EVENTS.ACTIVITY_LOGS_CHANGED,
  },
};

export default function CompanySettings() {
  const { user, updateUser } = useAuth();
  const { targetUserId, setTargetUserId, selectedUser, settingsParams, companyUsers, isCompanyAdmin } = useSettingsTarget();

  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);
  const [touched, setTouched] = useState({});

  const [confirmKey, setConfirmKey] = useState(null);
  const [clearing, setClearing] = useState(false);

  const avatarInputRef = useRef(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarRemoving, setAvatarRemoving] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setTouched({});
    axios
      .get(`${API_BASE_URL}/settings`, { params: settingsParams })
      .then((res) => setSettings(res.data.settings))
      .catch((err) => {
        console.error("Settings API Error :", err);
        setError("Unable to load account settings. Please check the server and try again.");
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetUserId]);

  const setField = (key, value) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const errors = settings
    ? { system_dashboard_refresh_seconds: validateNumberRange(settings.system_dashboard_refresh_seconds, "Dashboard Auto Refresh Interval", { min: 5, max: 3600 }) }
    : {};

  const handleSave = () => {
    setTouched({ system_dashboard_refresh_seconds: true });
    if (!hasNoErrors(errors)) return;

    setSaving(true);
    axios
      .put(`${API_BASE_URL}/settings`, { system_dashboard_refresh_seconds: settings.system_dashboard_refresh_seconds }, { params: settingsParams })
      .then((res) => {
        setSettings(res.data.settings);
        emitDataEvent(DATA_EVENTS.SETTINGS_CHANGED);
        setToast({ type: "success", message: "Settings saved successfully." });
      })
      .catch((err) => {
        console.error("Save Company Settings API Error :", err);
        setToast({ type: "error", message: err.response?.data?.message || "Failed to save settings." });
      })
      .finally(() => setSaving(false));
  };

  const handleConfirmClear = () => {
    const action = CLEAR_ACTIONS[confirmKey];
    if (!action) return;
    setClearing(true);
    axios[action.method](action.url)
      .then(() => {
        setToast({ type: "success", message: action.successMessage });
        emitDataEvent(action.event);
      })
      .catch((err) => {
        console.error("Clear Data API Error :", err);
        setToast({ type: "error", message: `Failed to clear: ${action.label}.` });
      })
      .finally(() => {
        setClearing(false);
        setConfirmKey(null);
      });
  };

  const avatarTargetName = targetUserId ? selectedUser?.name : user?.name;
  const avatarTargetUrl = targetUserId ? selectedUser?.avatar_url : user?.avatar_url;

  const handleAvatarFileChange = (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    const fileError = validateFileUpload(file, { allowedExtensions: [".jpg", ".jpeg", ".png", ".webp"], maxBytes: 5 * 1024 * 1024, label: "Photo" });
    if (fileError) {
      setToast({ type: "error", message: fileError });
      return;
    }

    setAvatarUploading(true);
    const formData = new FormData();
    formData.append("avatar", file);
    const url = targetUserId ? `${API_BASE_URL}/company/users/${targetUserId}/avatar` : `${API_BASE_URL}/account/avatar`;

    axios
      .put(url, formData)
      .then((res) => {
        if (targetUserId) {
          emitDataEvent(DATA_EVENTS.COMPANY_USERS_CHANGED);
        } else {
          updateUser(res.data.user);
        }
        emitDataEvent(DATA_EVENTS.PROFILE_CHANGED);
        setToast({ type: "success", message: "Profile photo updated." });
      })
      .catch((err) => {
        console.error("Avatar Upload API Error :", err);
        setToast({ type: "error", message: err.response?.data?.message || "Failed to update profile photo." });
      })
      .finally(() => setAvatarUploading(false));
  };

  const handleRemoveAvatar = () => {
    setAvatarRemoving(true);
    const url = targetUserId ? `${API_BASE_URL}/company/users/${targetUserId}/avatar` : `${API_BASE_URL}/account/avatar`;

    axios
      .delete(url)
      .then((res) => {
        if (targetUserId) {
          emitDataEvent(DATA_EVENTS.COMPANY_USERS_CHANGED);
        } else {
          updateUser(res.data.user);
        }
        emitDataEvent(DATA_EVENTS.PROFILE_CHANGED);
        setToast({ type: "success", message: "Profile photo removed." });
      })
      .catch((err) => {
        console.error("Avatar Remove API Error :", err);
        setToast({ type: "error", message: "Failed to remove profile photo." });
      })
      .finally(() => setAvatarRemoving(false));
  };

  return (
    <div>
      <PageHeader eyebrow="Settings" title="Company Settings" description="Profile, account preferences, and data management." />
      <ManagingSettingsFor
        targetUserId={targetUserId}
        setTargetUserId={setTargetUserId}
        companyUsers={companyUsers}
        isCompanyAdmin={isCompanyAdmin}
        selectedUser={selectedUser}
      />

      <div className="grid grid-cols-1 gap-4">
        <GlassCard className="p-5">
          <SectionHeading icon={UserCircle} title="Profile" subtitle={`Profile photo for ${avatarTargetName || "this account"}`} />
          <div className="mt-4 flex flex-wrap items-center gap-5">
            {avatarTargetUrl ? (
              <img src={avatarTargetUrl} alt="Profile" className="h-20 w-20 rounded-2xl object-cover ring-1 ring-white/10" />
            ) : (
              <span className="flex h-20 w-20 items-center justify-center rounded-2xl bg-accent-cyan/10 text-2xl font-semibold text-accent-cyan ring-1 ring-white/10">
                {(avatarTargetName || "?").trim().charAt(0).toUpperCase()}
              </span>
            )}
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-3">
                <Button type="button" variant="secondary" onClick={() => avatarInputRef.current?.click()} disabled={avatarUploading || avatarRemoving}>
                  {avatarUploading ? "Uploading…" : avatarTargetUrl ? "Change Photo" : "Upload Photo"}
                </Button>
                {avatarTargetUrl && (
                  <Button type="button" variant="danger" onClick={handleRemoveAvatar} disabled={avatarUploading || avatarRemoving}>
                    {avatarRemoving ? "Removing…" : "Remove Photo"}
                  </Button>
                )}
              </div>
              <p className="text-xs text-ink-500">JPG, PNG, or WEBP. Maximum size 5MB.</p>
            </div>
            <input ref={avatarInputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={handleAvatarFileChange} />
          </div>
        </GlassCard>

        {loading ? (
          <GlassCard className="p-5">
            <div className="flex items-center gap-2 text-xs text-ink-500">
              <Loader2 size={16} className="animate-spin" />
              Loading settings…
            </div>
          </GlassCard>
        ) : error ? (
          <GlassCard className="p-5">
            <p className="text-xs text-red-400">{error}</p>
          </GlassCard>
        ) : (
          <GlassCard className="p-5">
            <SectionHeading icon={Monitor} title="System" subtitle="Application-wide refresh behavior" />
            <div className="mt-4">
              <Field label="Dashboard Refresh Interval (seconds)">
                <input
                  type="number"
                  value={settings.system_dashboard_refresh_seconds}
                  onChange={(e) => setField("system_dashboard_refresh_seconds", Number(e.target.value))}
                  onBlur={() => setTouched((t) => ({ ...t, system_dashboard_refresh_seconds: true }))}
                  className={`${inputClass} ${touched.system_dashboard_refresh_seconds && errors.system_dashboard_refresh_seconds ? INVALID_INPUT_CLASS : ""}`}
                />
                {touched.system_dashboard_refresh_seconds && errors.system_dashboard_refresh_seconds && (
                  <p className="mt-1.5 text-xs text-red-400">{errors.system_dashboard_refresh_seconds}</p>
                )}
              </Field>
            </div>
            <div className="mt-5 flex justify-end">
              <Button icon={Save} onClick={handleSave} disabled={saving || !hasNoErrors(errors)}>
                {saving ? "Saving…" : "Save Changes"}
              </Button>
            </div>
          </GlassCard>
        )}

        <GlassCard className="p-5">
          <SectionHeading icon={HardDrive} title="Storage" subtitle="Permanently clear stored data" />
          <div className="mt-4 flex flex-col gap-3">
            <Button variant="danger" onClick={() => setConfirmKey("unknownImages")}>
              Clear Unknown Images
            </Button>
            <Button variant="danger" onClick={() => setConfirmKey("attendanceLogs")}>
              Clear Attendance Logs
            </Button>
            <Button variant="danger" onClick={() => setConfirmKey("activityLogs")}>
              Clear Activity Logs
            </Button>
          </div>
        </GlassCard>
      </div>

      <Modal open={!!confirmKey} onClose={() => setConfirmKey(null)} title={confirmKey ? CLEAR_ACTIONS[confirmKey].confirmTitle : ""}>
        <p className="text-sm text-ink-300">{confirmKey ? CLEAR_ACTIONS[confirmKey].confirmText : ""}</p>
        <div className="flex justify-end gap-3 pt-5">
          <Button type="button" variant="ghost" onClick={() => setConfirmKey(null)} disabled={clearing}>
            Cancel
          </Button>
          <Button type="button" variant="danger" onClick={handleConfirmClear} disabled={clearing}>
            {clearing ? "Clearing…" : "Clear"}
          </Button>
        </div>
      </Modal>

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
