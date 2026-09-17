import { useEffect, useState } from "react";
import axios from "axios";
import { ScanFace, Target, Save, Loader2, RotateCcw } from "lucide-react";
import PageHeader from "../../components/ui/PageHeader";
import GlassCard from "../../components/ui/GlassCard";
import Button from "../../components/ui/Button";
import Modal from "../../components/ui/Modal";
import Toast from "../../components/ui/Toast";
import { API_BASE_URL } from "../../lib/apiBase";
import { DATA_EVENTS, emitDataEvent } from "../../lib/dataEvents";
import { AiControlToggle, Field, ManagingSettingsFor, SectionHeading, inputClass, useSettingsTarget } from "../../components/settings/settingsShared";

// AI Detection master on/off switches — keys match the
// customer_ai_settings columns (Backend/api/ai_config.py)
// COMPANY_ADMIN_AI_KEYS 1:1. Each saves immediately via
// PUT /ai-detection-settings (not part of this page's Save Changes) —
// copied verbatim from the old single Settings page's AI_DETECTION_FIELDS.
const AI_DETECTION_FIELDS = [
  {
    key: "face_recognition_enabled",
    label: "Face Recognition",
    description:
      "Master switch. When OFF: disables all face recognition features below — no registered recognition, no unknown detection, no attendance.",
  },
  {
    key: "registered_detection_enabled",
    label: "Registered Person Detection",
    description: "When ON: recognizes registered persons normally. When OFF: registered person recognition does not run.",
  },
  {
    key: "unknown_detection_enabled",
    label: "Unknown Person Detection",
    description: "When ON: detects unknown persons. When OFF: unknown persons are ignored completely.",
  },
  {
    key: "save_unknown_persons",
    label: "Unknown Person Auto Save",
    description: "When ON: every detected unknown person is automatically saved to the database. When OFF: unknown persons may be detected, but are not saved.",
  },
  {
    key: "attendance_enabled",
    label: "Attendance Tracking",
    description: "When ON: attendance is marked automatically for registered persons. When OFF: no attendance is recorded.",
  },
  {
    key: "object_detection_enabled",
    label: "Vehicle Detection",
    description: "When ON: cars, motorcycles, buses, trucks, and bicycles are detected and recorded as events. When OFF: vehicles are ignored.",
  },
  {
    key: "animal_detection_enabled",
    label: "Animal Detection",
    description: "When ON: common animals (dog, cat, cow, horse, sheep, bird…) are detected and recorded as events. When OFF: animals are ignored.",
  },
  {
    key: "fire_detection_enabled",
    label: "Fire / Smoke Detection",
    description: "When ON: the fire/smoke model (if installed) runs and raises a FIRE DETECTED alert + snapshot. When OFF: the fire model never runs.",
  },
];

// The 3 flags api/ai_config.py's get_ai_flag_locks reports on — gated by
// whether this company owns (and the Super Admin has enabled) the
// Security & Detection package. Every other field above is never locked.
const PACKAGE_LOCKED_MESSAGE =
  "Locked — the Security & Detection package isn't enabled for your company. Ask your Super Admin to enable it.";

// Recognition thresholds — keys match COMPANY_ADMIN_AI_SETTINGS_KEYS
// (api/ai_config.py) 1:1, saved together via PUT /company/settings/ai on
// this page's own Save Changes button. Copied verbatim from the old
// single Settings page's RECOGNITION_NUMBER_FIELDS.
const RECOGNITION_NUMBER_FIELDS = [
  { key: "recognition_threshold", label: "Recognition Threshold", min: 0, max: 1, step: 0.01, hint: "Cosine similarity (0-1) a face must clear to be recognized as a registered person." },
  { key: "min_face_size", label: "Minimum Face Size (px)", min: 1, max: 2000, step: 1 },
  { key: "blur_threshold", label: "Blur Threshold", min: 0, max: 10000, step: 1, hint: "Laplacian variance floor — lower accepts softer/more compressed video." },
  { key: "brightness_min", label: "Minimum Brightness", min: 0, max: 255, step: 1 },
  { key: "brightness_max", label: "Maximum Brightness", min: 0, max: 255, step: 1 },
  { key: "max_yaw", label: "Maximum Yaw (deg)", min: 0, max: 90, step: 1, hint: "How far a face may turn sideways and still be processed." },
  { key: "max_roll", label: "Maximum Roll (deg)", min: 0, max: 90, step: 1, hint: "How far a head may tilt and still be processed." },
  { key: "attendance_cooldown_seconds", label: "Attendance Cooldown (seconds)", min: 0, max: 86400, step: 1, hint: "Minimum time between two attendance writes for the same person." },
  { key: "unknown_duplicate_threshold", label: "Unknown Duplicate Threshold", min: 0, max: 1, step: 0.01, hint: "Similarity above which a new detection is treated as an already-saved unknown person, not a new one." },
];

export default function AISettings() {
  const { targetUserId, setTargetUserId, selectedUser, settingsParams, companyUsers, isCompanyAdmin } = useSettingsTarget();

  const [aiDetection, setAiDetection] = useState(null);
  const [aiLocked, setAiLocked] = useState({});
  const [aiDetectionLoading, setAiDetectionLoading] = useState(true);
  const [aiDetectionError, setAiDetectionError] = useState(null);
  const [savingKey, setSavingKey] = useState(null);

  const [aiSettings, setAiSettings] = useState(null);
  const [aiSettingsLoading, setAiSettingsLoading] = useState(true);
  const [aiSettingsError, setAiSettingsError] = useState(null);

  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    setAiDetectionLoading(true);
    setAiDetectionError(null);
    axios
      .get(`${API_BASE_URL}/ai-detection-settings`, { params: settingsParams })
      .then((res) => {
        setAiDetection(res.data.ai_config);
        setAiLocked(res.data.locked || {});
      })
      .catch((err) => {
        console.error("AI Detection Settings API Error :", err);
        setAiDetectionError("Unable to load AI detection controls. Please check the server and try again.");
      })
      .finally(() => setAiDetectionLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetUserId]);

  useEffect(() => {
    setAiSettingsLoading(true);
    setAiSettingsError(null);
    axios
      .get(`${API_BASE_URL}/company/settings/ai`, { params: settingsParams })
      .then((res) => setAiSettings(res.data.settings))
      .catch((err) => {
        console.error("AI Settings API Error :", err);
        setAiSettingsError("Unable to load Recognition settings. Please check the server and try again.");
      })
      .finally(() => setAiSettingsLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetUserId]);

  const handleAiDetectionToggle = (key, value) => {
    if (aiLocked[key]) return;
    const previous = aiDetection;
    setAiDetection((prev) => ({ ...prev, [key]: value }));
    setSavingKey(key);
    axios
      .put(`${API_BASE_URL}/ai-detection-settings`, { [key]: value }, { params: settingsParams })
      .then((res) => {
        setAiDetection(res.data.ai_config);
        setAiLocked(res.data.locked || {});
        emitDataEvent(DATA_EVENTS.SETTINGS_CHANGED);
      })
      .catch((err) => {
        console.error("Update AI Detection Settings API Error :", err);
        setAiDetection(previous);
        setToast({ type: "error", message: "Failed to update AI detection setting." });
      })
      .finally(() => setSavingKey(null));
  };

  const setAiSettingField = (key, value) => {
    setAiSettings((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = () => {
    setSaving(true);
    axios
      .put(`${API_BASE_URL}/company/settings/ai`, aiSettings, { params: settingsParams })
      .then((res) => {
        setAiSettings(res.data.settings);
        emitDataEvent(DATA_EVENTS.SETTINGS_CHANGED);
        setToast({
          type: "success",
          message: targetUserId ? `AI settings saved for ${selectedUser?.name || "this user"}.` : "AI settings saved successfully.",
        });
      })
      .catch((err) => {
        console.error("Save AI Settings API Error :", err);
        setToast({ type: "error", message: err.response?.data?.message || "Failed to save AI settings." });
      })
      .finally(() => setSaving(false));
  };

  const handleReset = () => {
    setResetting(true);
    Promise.all([
      axios.post(`${API_BASE_URL}/ai-detection-settings/reset`, null, { params: settingsParams }),
      axios.post(`${API_BASE_URL}/company/settings/ai/reset`, null, { params: settingsParams }),
    ])
      .then(([detectionRes, aiSettingsRes]) => {
        setAiDetection(detectionRes.data.ai_config);
        setAiLocked(detectionRes.data.locked || {});
        setAiSettings(aiSettingsRes.data.settings);
        emitDataEvent(DATA_EVENTS.SETTINGS_CHANGED);
        setToast({ type: "success", message: "AI settings reset to defaults." });
      })
      .catch((err) => {
        console.error("Reset AI Settings API Error :", err);
        setToast({ type: "error", message: "Failed to reset AI settings." });
      })
      .finally(() => {
        setResetting(false);
        setConfirmReset(false);
      });
  };

  const loading = aiDetectionLoading || aiSettingsLoading;

  return (
    <div>
      <PageHeader
        eyebrow="Settings"
        title="AI Settings"
        description="Face recognition, object/animal/fire detection, and recognition quality thresholds."
      />
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
          <p className="text-xs">Loading AI settings…</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          <GlassCard className="p-5">
            <SectionHeading icon={ScanFace} title="AI Detection" subtitle="Enable or disable AI detection features — applies immediately" />
            {aiDetectionError ? (
              <p className="mt-4 text-xs text-red-400">{aiDetectionError}</p>
            ) : (
              <div className="mt-4 divide-y divide-white/5">
                {AI_DETECTION_FIELDS.map((field) => (
                  <AiControlToggle
                    key={field.key}
                    label={field.label}
                    description={field.description}
                    checked={!!aiDetection[field.key]}
                    disabled={savingKey === field.key}
                    locked={!!aiLocked[field.key]}
                    lockedMessage={PACKAGE_LOCKED_MESSAGE}
                    onChange={(value) => handleAiDetectionToggle(field.key, value)}
                  />
                ))}
              </div>
            )}
          </GlassCard>

          <GlassCard className="p-5">
            <SectionHeading icon={Target} title="Recognition" subtitle="Recognition, quality, and unknown-person thresholds" />
            {aiSettingsError ? (
              <p className="mt-4 text-xs text-red-400">{aiSettingsError}</p>
            ) : (
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                {RECOGNITION_NUMBER_FIELDS.map((field) => (
                  <Field key={field.key} label={field.label} hint={field.hint}>
                    <input
                      type="number"
                      min={field.min}
                      max={field.max}
                      step={field.step}
                      value={aiSettings[field.key]}
                      onChange={(e) => setAiSettingField(field.key, e.target.value === "" ? "" : Number(e.target.value))}
                      className={inputClass}
                    />
                  </Field>
                ))}
              </div>
            )}
          </GlassCard>
        </div>
      )}

      <div className="mt-4 flex flex-wrap justify-end gap-3">
        <Button icon={RotateCcw} variant="ghost" onClick={() => setConfirmReset(true)} disabled={resetting || saving || loading}>
          Reset to Defaults
        </Button>
        <Button icon={Save} onClick={handleSave} disabled={saving || loading}>
          {saving ? "Saving…" : "Save Changes"}
        </Button>
      </div>

      <Modal open={confirmReset} onClose={() => setConfirmReset(false)} title="Reset AI Settings to Defaults">
        <p className="text-sm text-ink-300">
          {targetUserId
            ? `This resets ${selectedUser?.name || "this User"}'s AI Detection and Recognition settings back to their factory defaults. This only affects this User — no one else's settings change.`
            : "This resets your AI Detection and Recognition settings back to their factory defaults."}
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
