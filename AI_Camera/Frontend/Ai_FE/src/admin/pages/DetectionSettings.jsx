import { useEffect, useState } from "react";
import axios from "axios";
import { Camera, ShieldAlert, Save, Loader2, RotateCcw } from "lucide-react";
import PageHeader from "../../components/ui/PageHeader";
import GlassCard from "../../components/ui/GlassCard";
import Toggle from "../../components/ui/Toggle";
import Button from "../../components/ui/Button";
import Modal from "../../components/ui/Modal";
import Toast from "../../components/ui/Toast";
import Select from "../../components/ui/Select";
import { API_BASE_URL } from "../../lib/apiBase";
import { DATA_EVENTS, emitDataEvent } from "../../lib/dataEvents";
import { validateNumberRange, hasNoErrors, INVALID_INPUT_CLASS } from "../../lib/validation";
import { Field, ManagingSettingsFor, SectionHeading, inputClass, useSettingsTarget } from "../../components/settings/settingsShared";

export default function DetectionSettings() {
  const { targetUserId, setTargetUserId, selectedUser, settingsParams, companyUsers, isCompanyAdmin } = useSettingsTarget();

  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [toast, setToast] = useState(null);
  const [touched, setTouched] = useState({});

  useEffect(() => {
    setLoading(true);
    setError(null);
    setTouched({});
    axios
      .get(`${API_BASE_URL}/settings`, { params: settingsParams })
      .then((res) => setSettings(res.data.settings))
      .catch((err) => {
        console.error("Settings API Error :", err);
        setError("Unable to load detection settings. Please check the server and try again.");
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetUserId]);

  const setField = (key, value) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const errors = settings
    ? { ai_retry_interval_minutes: validateNumberRange(settings.ai_retry_interval_minutes, "Unknown Person Save Cooldown", { min: 0, max: 1440 }) }
    : {};

  const handleSave = () => {
    setTouched({ ai_retry_interval_minutes: true });
    if (!hasNoErrors(errors)) return;

    setSaving(true);
    axios
      .put(
        `${API_BASE_URL}/settings`,
        {
          camera_resolution: settings.camera_resolution,
          camera_frame_rate: settings.camera_frame_rate,
          camera_continuous_recording: settings.camera_continuous_recording,
          camera_night_vision: settings.camera_night_vision,
          camera_auto_reconnect: settings.camera_auto_reconnect,
          ai_retry_interval_minutes: settings.ai_retry_interval_minutes,
        },
        { params: settingsParams }
      )
      .then((res) => {
        setSettings(res.data.settings);
        emitDataEvent(DATA_EVENTS.SETTINGS_CHANGED);
        setToast({
          type: "success",
          message: targetUserId ? `Detection settings saved for ${selectedUser?.name || "this user"}.` : "Detection settings saved successfully.",
        });
      })
      .catch((err) => {
        console.error("Save Detection Settings API Error :", err);
        setToast({ type: "error", message: err.response?.data?.message || "Failed to save detection settings." });
      })
      .finally(() => setSaving(false));
  };

  const handleReset = () => {
    setResetting(true);
    axios
      .post(`${API_BASE_URL}/settings/reset`, null, { params: settingsParams })
      .then((res) => {
        setSettings(res.data.settings);
        setTouched({});
        emitDataEvent(DATA_EVENTS.SETTINGS_CHANGED);
        setToast({ type: "success", message: "Detection settings reset to defaults." });
      })
      .catch((err) => {
        console.error("Reset Detection Settings API Error :", err);
        setToast({ type: "error", message: "Failed to reset detection settings." });
      })
      .finally(() => {
        setResetting(false);
        setConfirmReset(false);
      });
  };

  return (
    <div>
      <PageHeader eyebrow="Settings" title="Detection Settings" description="Camera capture behavior and detection/alert sensitivity." />
      <ManagingSettingsFor
        targetUserId={targetUserId}
        setTargetUserId={setTargetUserId}
        companyUsers={companyUsers}
        isCompanyAdmin={isCompanyAdmin}
        selectedUser={selectedUser}
      />

      {loading ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-ink-500">
          <Loader2 size={22} className="animate-spin" />
          <p className="text-xs">Loading detection settings…</p>
        </div>
      ) : error ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-center text-ink-500">
          <p className="text-xs text-red-400">{error}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          <GlassCard className="p-5">
            <SectionHeading icon={Camera} title="Camera" subtitle="Stream quality and recording behavior" />
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Default Resolution">
                <Select
                  value={settings.camera_resolution}
                  onChange={(e) => setField("camera_resolution", e.target.value)}
                  options={["1080p (Full HD)", "720p (HD)", "4K (Ultra HD)"]}
                />
              </Field>
              <Field label="Frame Rate (FPS)">
                <Select
                  value={settings.camera_frame_rate}
                  onChange={(e) => setField("camera_frame_rate", e.target.value)}
                  options={["15 fps", "24 fps", "30 fps", "60 fps"]}
                />
              </Field>
              <div className="divide-y divide-white/5 sm:col-span-2">
                <Toggle
                  label="Continuous Recording"
                  description="Record 24/7 instead of motion-triggered clips"
                  checked={settings.camera_continuous_recording}
                  onChange={(value) => setField("camera_continuous_recording", value)}
                />
                <Toggle
                  label="Night Vision"
                  description="Auto-switch to infrared in low light"
                  checked={settings.camera_night_vision}
                  onChange={(value) => setField("camera_night_vision", value)}
                />
                <Toggle
                  label="Auto Camera Reconnect"
                  description="Automatically reconnect a stream after it drops"
                  checked={settings.camera_auto_reconnect}
                  onChange={(value) => setField("camera_auto_reconnect", value)}
                />
              </div>
            </div>
          </GlassCard>

          <GlassCard className="p-5">
            <SectionHeading icon={ShieldAlert} title="Detection & Alert Behavior" subtitle="How repeated detections are handled" />
            <div className="mt-4">
              <Field
                label="Unknown Person Save Cooldown (Minutes)"
                hint="Prevents the same unknown person from being saved repeatedly within the selected time interval."
              >
                <input
                  type="number"
                  min="0"
                  value={settings.ai_retry_interval_minutes}
                  onChange={(e) => setField("ai_retry_interval_minutes", Number(e.target.value))}
                  onBlur={() => setTouched((t) => ({ ...t, ai_retry_interval_minutes: true }))}
                  className={`${inputClass} ${touched.ai_retry_interval_minutes && errors.ai_retry_interval_minutes ? INVALID_INPUT_CLASS : ""}`}
                />
                {touched.ai_retry_interval_minutes && errors.ai_retry_interval_minutes && (
                  <p className="mt-1.5 text-xs text-red-400">{errors.ai_retry_interval_minutes}</p>
                )}
              </Field>
            </div>
          </GlassCard>
        </div>
      )}

      <div className="mt-4 flex flex-wrap justify-end gap-3">
        <Button icon={RotateCcw} variant="ghost" onClick={() => setConfirmReset(true)} disabled={resetting || saving || loading}>
          Reset to Defaults
        </Button>
        <Button icon={Save} onClick={handleSave} disabled={saving || loading || !hasNoErrors(errors)}>
          {saving ? "Saving…" : "Save Changes"}
        </Button>
      </div>

      <Modal open={confirmReset} onClose={() => setConfirmReset(false)} title="Reset Detection Settings to Defaults">
        <p className="text-sm text-ink-300">
          {targetUserId
            ? `This resets ${selectedUser?.name || "this User"}'s Camera and detection/alert settings back to their factory defaults — this also includes their Company Settings > Dashboard Refresh Interval, since both are stored together.`
            : "This resets your Camera and detection/alert settings back to their factory defaults — this also includes Company Settings > Dashboard Refresh Interval, since both are stored together."}
        </p>
        <div className="flex justify-end gap-3 pt-5">
          <Button type="button" variant="ghost" onClick={() => setConfirmReset(false)} disabled={resetting}>
            Cancel
          </Button>
          <Button type="button" variant="danger" onClick={handleReset} disabled={resetting}>
            {resetting ? "Resetting…" : "Reset"}
          </Button>
        </div>
      </Modal>

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
