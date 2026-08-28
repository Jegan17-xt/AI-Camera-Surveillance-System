import { useEffect, useRef, useState } from "react";
import axios from "axios";
import { API_BASE_URL } from "../lib/apiBase";
import {
  Camera,
  ScanFace,
  Target,
  MessageSquareWarning,
  Monitor,
  HardDrive,
  UserCircle,
  Save,
  Loader2,
  AlertTriangle,
  Users,
  RotateCcw,
  History,
  Send,
  Trash2,
} from "lucide-react";
import PageHeader from "../components/ui/PageHeader";
import GlassCard from "../components/ui/GlassCard";
import Toggle from "../components/ui/Toggle";
import Button from "../components/ui/Button";
import Modal from "../components/ui/Modal";
import Toast from "../components/ui/Toast";
import Select from "../components/ui/Select";
import UserSelect from "../components/ui/UserSelect";
import { useAuth } from "../context/AuthContext";
import { useSelectedUser } from "../context/SelectedUserContext";
import { DATA_EVENTS, emitDataEvent } from "../lib/dataEvents";
import {
  validateNumberRange,
  validateFileUpload,
  validateWhatsappNumber,
  hasNoErrors,
  INVALID_INPUT_CLASS,
} from "../lib/validation";

// Every setting on this page belongs to exactly ONE section — nothing
// appears twice. Which account it belongs to is decided entirely by the
// "Managing Settings For" selector at the top: no selection = the
// logged-in Admin's own settings, a selected User = that User's own
// settings only, never a mix and never copied from one to the other.

function SectionHeading({ icon: Icon, title, subtitle }) {
  return (
    <div className="mb-1 flex items-center gap-3">
      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-cyan/10 text-accent-cyan">
        <Icon size={19} />
      </span>
      <div>
        <p className="font-display text-sm font-semibold text-white">{title}</p>
        <p className="text-xs text-ink-500">{subtitle}</p>
      </div>
    </div>
  );
}

function Field({ label, children, hint }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-ink-400">{label}</label>
      {children}
      {hint && <p className="mt-1.5 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

// Wraps the shared Toggle with a 🟢/🔴 status pill, kept local to this
// card only — the shared Toggle component itself is used unmodified
// everywhere else in this page.
function AiControlToggle({ label, description, checked, onChange, disabled }) {
  return (
    <div className="py-3">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-ink-100">{label}</p>
          <span
            className={`mt-0.5 inline-flex items-center gap-1 text-xs font-medium ${
              checked ? "text-signal-green" : "text-red-400"
            }`}
          >
            {checked ? "🟢 Enabled" : "🔴 Disabled"}
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          disabled={disabled}
          onClick={() => onChange(!checked)}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-300 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/60 focus-visible:ring-offset-2 focus-visible:ring-offset-base-950 disabled:opacity-50 ${
            checked ? "bg-signal-green" : "bg-white/15"
          }`}
        >
          <span
            className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition-transform duration-300 ease-in-out ${
              checked ? "translate-x-[22px]" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>
      {description && <p className="mt-1.5 text-xs text-ink-500">{description}</p>}
    </div>
  );
}

// 🤖 AI Detection — master on/off switches. Keys match the
// customer_ai_settings columns (api/ai_config.py) 1:1. Saved immediately
// on toggle (not part of the bottom Save Changes) — a delayed AI-behavior
// change is exactly what "must take effect immediately on every camera"
// rules out.
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
];

// 🎯 Recognition — thresholds only (no toggles here; every toggle above
// already lives in AI Detection, never duplicated). Keys match
// COMPANY_ADMIN_AI_SETTINGS_KEYS (api/ai_config.py) 1:1, saved via
// /company/settings/ai as part of the bottom Save Changes.
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

const inputClass =
  "w-full rounded-xl glass px-3.5 py-2.5 text-sm text-ink-100 placeholder:text-ink-500 outline-none focus:border-accent-cyan/50 focus:ring-2 focus:ring-accent-cyan/20";

// Legacy app_settings-backed values still shown on this page: Camera
// section fields, System's dashboard refresh interval, and the Unknown
// Person Save Cooldown (ai_retry_interval_minutes — a real, load-bearing
// setting consulted by face/unknown_manager.py, distinct from both
// Recognition's Unknown Duplicate Threshold and WhatsApp's alert
// cooldown, so it lives here rather than being dropped).
const computeSettingsErrors = (settings) => ({
  ai_retry_interval_minutes: validateNumberRange(settings.ai_retry_interval_minutes, "Unknown Person Save Cooldown", {
    min: 0,
    max: 1440,
  }),
  system_dashboard_refresh_seconds: validateNumberRange(
    settings.system_dashboard_refresh_seconds,
    "Dashboard Auto Refresh Interval",
    { min: 5, max: 3600 }
  ),
});

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

// Persists the Settings page's own "Managing Settings For" choice across
// a refresh — deliberately a SEPARATE key from SelectedUserContext's own
// "view as" filter (sessionStorage "selected_user_id"): viewing a User's
// DATA elsewhere in the app and editing a User's SETTINGS here are two
// independent choices, so switching one must never silently switch the
// other.
const SETTINGS_TARGET_KEY = "settings_target_user_id";

// Company-level NotificationSettings <-> the same flat 5-field shape a
// per-User's own settings already use — one WhatsApp Number field
// covers both alert types at the company level too, exactly like a
// User's own single whatsapp_number does. Keeps the WhatsApp & Reports
// card's fields IDENTICAL regardless of which scope is selected.
const normalizeCompanyWhatsapp = (s) => ({
  whatsapp_number: s.unknown_alert_recipient || s.daily_report_recipient || "",
  unknown_alert_enabled: s.unknown_alert_enabled,
  send_unknown_image: s.unknown_alert_send_image,
  daily_report_enabled: s.daily_report_enabled,
  daily_report_time: s.daily_report_time,
  // Company-level only — UserNotificationSettings has no format field of
  // its own, so this (and its Select below) never appears in the
  // per-User WhatsApp & Reports scope.
  daily_report_format: s.daily_report_format,
});

// Mirrors Backend/api/notification_settings.py's ALLOWED_REPORT_FORMATS
// exactly — PDF is the only format the Daily Report generator
// (reports/pdf_generator.py) actually builds today.
const REPORT_FORMAT_OPTIONS = [{ value: "pdf", label: "PDF" }];

export default function Settings() {
  const { user, updateUser } = useAuth();
  const { users: companyUsers, isCompanyAdmin } = useSelectedUser();

  // ---------------- Managing Settings For ----------------
  // null = the logged-in account's own settings (the default, and the
  // only option a User ever has — this selector never renders for a
  // User). A Company Admin may pick one of their own Users here — every
  // section below then loads, saves, and resets ONLY that User's own
  // settings, never the Admin's own and never another User's.
  const [targetUserId, setTargetUserIdState] = useState(() => {
    const stored = sessionStorage.getItem(SETTINGS_TARGET_KEY);
    const parsed = Number(stored);
    return stored && Number.isInteger(parsed) ? parsed : null;
  });

  const setTargetUserId = (value) => {
    setTargetUserIdState(value);
    if (value === null) {
      sessionStorage.removeItem(SETTINGS_TARGET_KEY);
    } else {
      sessionStorage.setItem(SETTINGS_TARGET_KEY, String(value));
    }
  };

  // A User selected on a previous visit may since have been removed —
  // fall back to "My Own Settings" rather than silently operating on a
  // stale id (same guard SelectedUserContext uses for its own filter).
  useEffect(() => {
    if (targetUserId !== null && companyUsers.length > 0 && !companyUsers.some((u) => u.id === targetUserId)) {
      setTargetUserId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyUsers]);

  const selectedUser = targetUserId ? companyUsers.find((u) => u.id === targetUserId) : null;
  const settingsParams = targetUserId ? { user_id: targetUserId } : undefined;
  const [resetting, setResetting] = useState(false);

  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);

  const [confirmKey, setConfirmKey] = useState(null);
  const [clearing, setClearing] = useState(false);

  const avatarInputRef = useRef(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarRemoving, setAvatarRemoving] = useState(false);

  const [touched, setTouched] = useState({});

  // AI Detection — own fetch/save cycle, independent of the batch-saved
  // state below (these toggles save individually and immediately).
  const [aiDetection, setAiDetection] = useState(null);
  const [aiDetectionLoading, setAiDetectionLoading] = useState(true);
  const [aiDetectionError, setAiDetectionError] = useState(null);
  const [savingKey, setSavingKey] = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setTouched({});

    axios
      .get(`${API_BASE_URL}/settings`, { params: settingsParams })
      .then((res) => {
        setSettings(res.data.settings);
      })
      .catch((err) => {
        console.error("Settings API Error :", err);
        setError("Unable to load settings. Please check the server and try again.");
      })
      .finally(() => {
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetUserId]);

  useEffect(() => {
    setAiDetectionLoading(true);
    setAiDetectionError(null);

    axios
      .get(`${API_BASE_URL}/ai-detection-settings`, { params: settingsParams })
      .then((res) => setAiDetection(res.data.ai_config))
      .catch((err) => {
        console.error("AI Detection Settings API Error :", err);
        setAiDetectionError("Unable to load AI detection controls. Please check the server and try again.");
      })
      .finally(() => setAiDetectionLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetUserId]);

  const handleAiDetectionToggle = (key, value) => {
    const previous = aiDetection;
    setAiDetection((prev) => ({ ...prev, [key]: value }));
    setSavingKey(key);

    axios
      .put(`${API_BASE_URL}/ai-detection-settings`, { [key]: value }, { params: settingsParams })
      .then((res) => {
        setAiDetection(res.data.ai_config);
        emitDataEvent(DATA_EVENTS.SETTINGS_CHANGED);
      })
      .catch((err) => {
        console.error("Update AI Detection Settings API Error :", err);
        setAiDetection(previous);
        setToast({ type: "error", message: "Failed to update AI detection setting." });
      })
      .finally(() => setSavingKey(null));
  };

  // ---------------- Recognition (numeric thresholds) ----------------
  const [aiSettings, setAiSettings] = useState(null);
  const [aiSettingsLoading, setAiSettingsLoading] = useState(true);
  const [aiSettingsError, setAiSettingsError] = useState(null);

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

  const setAiSettingField = (key, value) => {
    setAiSettings((prev) => ({ ...prev, [key]: value }));
  };

  // ---------------- WhatsApp & Reports ----------------
  // Only ever visible to an Admin tier (Company Admin/Super Admin) —
  // matches the backend's admin_required / company_admin_required gates
  // on every route this section calls. Same flat 5-field shape
  // regardless of scope; only which endpoint(s) it reads/writes differs.
  const isAdmin = user?.role !== "User";

  const [waSettings, setWaSettings] = useState(null);
  const [waLoading, setWaLoading] = useState(true);
  const [waError, setWaError] = useState(null);
  const [generatingReport, setGeneratingReport] = useState(false);

  const [notificationLogs, setNotificationLogs] = useState([]);
  const [reportLogs, setReportLogs] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  const loadWhatsappSettings = () => {
    setWaLoading(true);
    setWaError(null);

    const request = targetUserId
      ? axios.get(`${API_BASE_URL}/company/users/${targetUserId}/whatsapp-settings`).then((res) => res.data.settings)
      : axios.get(`${API_BASE_URL}/notifications/settings`).then((res) => normalizeCompanyWhatsapp(res.data.settings));

    request
      .then(setWaSettings)
      .catch((err) => {
        console.error("WhatsApp & Reports Settings API Error :", err);
        setWaError("Unable to load WhatsApp & Reports settings.");
      })
      .finally(() => setWaLoading(false));
  };

  const loadHistory = () => {
    setHistoryLoading(true);

    const params = targetUserId ? { user_id: targetUserId, limit: 10 } : { limit: 10 };

    Promise.all([
      axios.get(`${API_BASE_URL}/notifications/logs`, { params }),
      axios.get(`${API_BASE_URL}/reports/daily-report/logs`, { params }),
    ])
      .then(([notifRes, reportRes]) => {
        setNotificationLogs(notifRes.data.logs);
        setReportLogs(reportRes.data.logs);
      })
      .catch((err) => console.error("Notification/Report History API Error :", err))
      .finally(() => setHistoryLoading(false));
  };

  // Notification History's Delete button. `log.type` is only ever
  // truthy on a NotificationLog row (see Backend/auth/models.py —
  // ReportLog has no `type` column at all), so it's the same
  // discriminator the list's own React key already uses
  // (`${log.type || "daily_report"}-${log.id}`) to tell which of the
  // two backend tables/endpoints a given row actually came from.
  const [deletingLogKey, setDeletingLogKey] = useState(null);

  const handleDeleteLog = (log) => {
    const key = `${log.type || "daily_report"}-${log.id}`;
    const url = log.type
      ? `${API_BASE_URL}/notifications/logs/${log.id}`
      : `${API_BASE_URL}/reports/daily-report/logs/${log.id}`;

    setDeletingLogKey(key);

    axios
      .delete(url)
      .then(() => {
        loadHistory();
      })
      .catch((err) => {
        setToast({ type: "error", message: err.response?.data?.message || "Failed to delete notification." });
      })
      .finally(() => setDeletingLogKey(null));
  };

  useEffect(() => {
    if (!isAdmin) {
      setWaLoading(false);
      setHistoryLoading(false);
      return;
    }

    loadWhatsappSettings();
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, targetUserId]);

  const setWaField = (key, value) => {
    setWaSettings((prev) => ({ ...prev, [key]: value }));
  };

  const handleGenerateReportNow = () => {
    setGeneratingReport(true);

    axios
      .post(`${API_BASE_URL}/reports/daily-report/generate-now`, {
        force: true,
        ...(targetUserId ? { user_id: targetUserId } : {}),
      })
      .then((res) => {
        const status = res.data.result?.status || "Generated";
        setToast({
          type: status === "Failed" ? "error" : "success",
          message: `Daily report generated — WhatsApp status: ${status}.`,
        });
        loadHistory();
      })
      .catch((err) => {
        console.error("Generate Daily Report API Error :", err);
        setToast({ type: "error", message: err.response?.data?.message || "Failed to generate report." });
      })
      .finally(() => setGeneratingReport(false));
  };

  const setField = (key, value) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  // ---------------- Unified Save Changes / Reset to Defaults ----------------
  // One save action for the whole page (Camera + System + Unknown Person
  // Save Cooldown via /settings, Recognition via /company/settings/ai,
  // WhatsApp & Reports via whichever endpoint matches the current scope)
  // — all three requests target settingsParams/targetUserId identically,
  // so a save can never end up touching two different accounts at once.
  // AI Detection's toggles are deliberately NOT part of this — they save
  // immediately, per the comment on handleAiDetectionToggle above.
  const whatsappErrors = {
    whatsapp_number: waSettings ? validateWhatsappNumber(waSettings.whatsapp_number, { label: "WhatsApp Number" }) : "",
  };

  const handleSave = () => {
    setTouched({ ai_retry_interval_minutes: true, system_dashboard_refresh_seconds: true, whatsapp_number: true });

    if (!hasNoErrors(computeSettingsErrors(settings)) || (isAdmin && !hasNoErrors(whatsappErrors))) return;

    setSaving(true);

    const requests = [
      axios.put(`${API_BASE_URL}/settings`, settings, { params: settingsParams }),
      axios.put(`${API_BASE_URL}/company/settings/ai`, aiSettings, { params: settingsParams }),
    ];

    if (isAdmin) {
      requests.push(
        targetUserId
          ? axios.put(`${API_BASE_URL}/company/users/${targetUserId}/whatsapp-settings`, waSettings)
          : Promise.all([
              axios.put(`${API_BASE_URL}/notifications/settings/unknown-alert`, {
                unknown_alert_enabled: waSettings.unknown_alert_enabled,
                unknown_alert_recipient: waSettings.whatsapp_number || null,
                unknown_alert_send_image: waSettings.send_unknown_image,
              }),
              axios.put(`${API_BASE_URL}/notifications/settings/daily-report`, {
                daily_report_enabled: waSettings.daily_report_enabled,
                daily_report_time: waSettings.daily_report_time,
                daily_report_recipient: waSettings.whatsapp_number || null,
                daily_report_format: waSettings.daily_report_format,
              }),
            ]).then((responses) => responses[responses.length - 1])
      );
    }

    Promise.all(requests)
      .then(([settingsRes, aiSettingsRes, waRes]) => {
        setSettings(settingsRes.data.settings);
        setAiSettings(aiSettingsRes.data.settings);

        if (isAdmin && waRes) {
          setWaSettings(targetUserId ? waRes.data.settings : normalizeCompanyWhatsapp(waRes.data.settings));
        }

        emitDataEvent(DATA_EVENTS.SETTINGS_CHANGED);
        setToast({
          type: "success",
          message: targetUserId ? `Settings saved for ${selectedUser?.name || "this user"}.` : "Settings saved successfully.",
        });
      })
      .catch((err) => {
        console.error("Save Settings API Error :", err);
        setToast({ type: "error", message: err.response?.data?.message || "Failed to save settings." });
      })
      .finally(() => {
        setSaving(false);
      });
  };

  const [confirmReset, setConfirmReset] = useState(false);

  const handleResetToDefaults = () => {
    setResetting(true);

    const requests = [
      axios.post(`${API_BASE_URL}/settings/reset`, null, { params: settingsParams }),
      axios.post(`${API_BASE_URL}/ai-detection-settings/reset`, null, { params: settingsParams }),
      axios.post(`${API_BASE_URL}/company/settings/ai/reset`, null, { params: settingsParams }),
    ];

    if (isAdmin) {
      requests.push(
        targetUserId
          ? axios.post(`${API_BASE_URL}/company/users/${targetUserId}/whatsapp-settings/reset`)
          : axios.post(`${API_BASE_URL}/notifications/settings/reset`)
      );
    }

    Promise.all(requests)
      .then(([settingsRes, aiDetectionRes, aiSettingsRes, waRes]) => {
        setSettings(settingsRes.data.settings);
        setAiDetection(aiDetectionRes.data.ai_config);
        setAiSettings(aiSettingsRes.data.settings);

        if (isAdmin && waRes) {
          setWaSettings(targetUserId ? waRes.data.settings : normalizeCompanyWhatsapp(waRes.data.settings));
        }

        setTouched({});
        emitDataEvent(DATA_EVENTS.SETTINGS_CHANGED);
        setToast({ type: "success", message: "Settings reset to defaults." });
      })
      .catch((err) => {
        console.error("Reset Settings API Error :", err);
        setToast({ type: "error", message: "Failed to reset settings." });
      })
      .finally(() => {
        setResetting(false);
        setConfirmReset(false);
      });
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

  // ---------------- Profile Photo (scope-aware) ----------------
  // No selection -> the logged-in Admin's own photo, via the existing
  // self-service /account/avatar routes. A selected User -> that User's
  // own photo, via the ownership-checked /company/users/<id>/avatar
  // routes — never the Admin's own photo, and a save here can never
  // touch a different User's.
  const avatarTargetName = targetUserId ? selectedUser?.name : user?.name;
  const avatarTargetUrl = targetUserId ? selectedUser?.avatar_url : user?.avatar_url;

  const handleAvatarFileChange = (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    const fileError = validateFileUpload(file, {
      allowedExtensions: [".jpg", ".jpeg", ".png", ".webp"],
      maxBytes: 5 * 1024 * 1024,
      label: "Photo",
    });

    if (fileError) {
      setToast({ type: "error", message: fileError });
      return;
    }

    setAvatarUploading(true);

    const formData = new FormData();
    formData.append("avatar", file);

    const url = targetUserId
      ? `${API_BASE_URL}/company/users/${targetUserId}/avatar`
      : `${API_BASE_URL}/account/avatar`;

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
      .finally(() => {
        setAvatarUploading(false);
      });
  };

  const handleRemoveAvatar = () => {
    setAvatarRemoving(true);

    const url = targetUserId
      ? `${API_BASE_URL}/company/users/${targetUserId}/avatar`
      : `${API_BASE_URL}/account/avatar`;

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
      .finally(() => {
        setAvatarRemoving(false);
      });
  };

  // Admin-only "whose settings am I looking at" picker — never rendered
  // for a User (companyUsers is always empty for that role), so a User's
  // Settings page is visually identical to before this feature.
  const userTargetSelector = isCompanyAdmin && companyUsers.length > 0 && (
    <GlassCard className="mb-4 p-4">
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2 text-sm">
          <Users size={16} className="text-accent-cyan" />
          <span className="font-medium text-ink-100">Managing Settings For</span>
        </div>
        <UserSelect
          users={companyUsers}
          value={targetUserId ?? ""}
          onChange={(e) => setTargetUserId(e.target.value === "" ? null : Number(e.target.value))}
          emptyOptionLabel="My Own Settings"
        />
        {targetUserId && (
          <span className="text-xs text-ink-500">
            Every setting below belongs only to {selectedUser?.name || "this User"} — saving here can never affect
            yours or any other User's settings.
          </span>
        )}
      </div>
    </GlassCard>
  );

  if (loading) {
    return (
      <div>
        <PageHeader eyebrow="Configuration" title="Settings" description="Configure AI Camera settings for the selected user." />
        {userTargetSelector}
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-ink-500">
          <Loader2 size={22} className="animate-spin" />
          <p className="text-xs">Loading settings…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <PageHeader eyebrow="Configuration" title="Settings" description="Configure AI Camera settings for the selected user." />
        {userTargetSelector}
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-center text-ink-500">
          <AlertTriangle size={22} className="text-red-400" />
          <p className="text-xs">{error}</p>
        </div>
      </div>
    );
  }

  const errors = computeSettingsErrors(settings);
  const isFormValid = hasNoErrors(errors) && (!isAdmin || hasNoErrors(whatsappErrors));

  return (
    <div>
      <PageHeader eyebrow="Configuration" title="Settings" description="Configure AI Camera settings for the selected user." />

      {userTargetSelector}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* 👤 Profile */}
        <GlassCard className="p-5 xl:col-span-2">
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
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => avatarInputRef.current?.click()}
                  disabled={avatarUploading || avatarRemoving}
                >
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
            <input
              ref={avatarInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={handleAvatarFileChange}
            />
          </div>
        </GlassCard>

        {/* 📷 Camera */}
        <GlassCard className="p-5 xl:col-span-2">
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

        {/* 🤖 AI Detection */}
        <GlassCard className="p-5 xl:col-span-2">
          <SectionHeading
            icon={ScanFace}
            title="AI Detection"
            subtitle="Enable or disable AI detection features — applies immediately"
          />
          {aiDetectionLoading ? (
            <div className="mt-4 flex items-center gap-2 text-xs text-ink-500">
              <Loader2 size={16} className="animate-spin" />
              Loading AI detection controls…
            </div>
          ) : aiDetectionError ? (
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
                  onChange={(value) => handleAiDetectionToggle(field.key, value)}
                />
              ))}
            </div>
          )}
        </GlassCard>

        {/* 🎯 Recognition */}
        <GlassCard className="p-5 xl:col-span-2">
          <SectionHeading icon={Target} title="Recognition" subtitle="Recognition, quality, and unknown-person thresholds" />
          {aiSettingsLoading ? (
            <div className="mt-4 flex items-center gap-2 text-xs text-ink-500">
              <Loader2 size={16} className="animate-spin" />
              Loading Recognition settings…
            </div>
          ) : aiSettingsError ? (
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
          )}
        </GlassCard>

        {/* 📱 WhatsApp & Reports */}
        {isAdmin && (
          <GlassCard className="p-5 xl:col-span-2">
            <SectionHeading
              icon={MessageSquareWarning}
              title="WhatsApp & Reports"
              subtitle={
                targetUserId
                  ? `Unknown-person alerts and Daily Report delivery for ${selectedUser?.name || "this user"}`
                  : "Company-wide fallback WhatsApp alerts and Daily Report"
              }
            />
            {waLoading ? (
              <div className="mt-4 flex items-center gap-2 text-xs text-ink-500">
                <Loader2 size={16} className="animate-spin" />
                Loading WhatsApp & Reports settings…
              </div>
            ) : waError ? (
              <p className="mt-4 text-xs text-red-400">{waError}</p>
            ) : (
              <>
                {/* Exact requested order: Unknown Person WhatsApp Alerts,
                    Send Unknown Image, Daily Unknown Person Count,
                    WhatsApp Number, Daily Reports, Daily Report Time. */}
                <div className="mt-4 divide-y divide-white/5">
                  <Toggle
                    label="WhatsApp Alerts"
                    description="Send a WhatsApp alert with the captured image when a new unknown person is detected"
                    checked={waSettings.unknown_alert_enabled}
                    onChange={(value) => setWaField("unknown_alert_enabled", value)}
                  />
                  <Toggle
                    label="Send Unknown Image"
                    description="Attach the captured image to the alert"
                    checked={waSettings.send_unknown_image}
                    onChange={(value) => setWaField("send_unknown_image", value)}
                  />
                  {/* User-specific only — there is no company-wide
                      equivalent, so this never appears in the self/
                      company scope (no user selected). Independent of
                      Unknown Person WhatsApp Alerts above and of Daily
                      Reports below; reuses Daily Report Time for
                      scheduling instead of its own time field. */}
                  {targetUserId && (
                    <Toggle
                      label="Daily Unknown Person Count"
                      description="Send that day's confirmed unknown-person count to this User's WhatsApp number, at their Daily Report Time below"
                      checked={waSettings.daily_unknown_count_enabled}
                      onChange={(value) => setWaField("daily_unknown_count_enabled", value)}
                    />
                  )}
                  <div className="py-3">
                    <Field label="WhatsApp Number" hint="Include country code, e.g. +919876543210">
                      <input
                        type="text"
                        value={waSettings.whatsapp_number || ""}
                        onChange={(e) => setWaField("whatsapp_number", e.target.value)}
                        onBlur={() => setTouched((t) => ({ ...t, whatsapp_number: true }))}
                        placeholder="+919876543210"
                        className={`${inputClass} ${touched.whatsapp_number && whatsappErrors.whatsapp_number ? INVALID_INPUT_CLASS : ""}`}
                      />
                      {touched.whatsapp_number && whatsappErrors.whatsapp_number && (
                        <p className="mt-1.5 text-xs text-red-400">{whatsappErrors.whatsapp_number}</p>
                      )}
                    </Field>
                  </div>
                  <Toggle
                    label="Daily Reports"
                    description="Automatically generate and send the Daily Report"
                    checked={waSettings.daily_report_enabled}
                    onChange={(value) => setWaField("daily_report_enabled", value)}
                  />
                  <div className="py-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field label="Daily Report Time">
                      <input
                        type="time"
                        value={waSettings.daily_report_time}
                        onChange={(e) => setWaField("daily_report_time", e.target.value)}
                        className={inputClass}
                      />
                    </Field>
                    {/* Company-level only — see normalizeCompanyWhatsapp's
                        comment on daily_report_format. */}
                    {!targetUserId && (
                      <Field label="Report Format">
                        <Select
                          value={waSettings.daily_report_format}
                          onChange={(e) => setWaField("daily_report_format", e.target.value)}
                          options={REPORT_FORMAT_OPTIONS}
                        />
                      </Field>
                    )}
                  </div>
                </div>

                <div className="mt-4 flex justify-end">
                  <Button type="button" icon={Send} variant="ghost" onClick={handleGenerateReportNow} disabled={generatingReport}>
                    {generatingReport ? "Generating…" : "Send Test Report Now"}
                  </Button>
                </div>

                <div className="mt-5 border-t border-white/5 pt-4">
                  <div className="mb-2 flex items-center gap-2">
                    <History size={15} className="text-accent-cyan" />
                    <p className="font-display text-sm font-semibold text-white">Notification History</p>
                  </div>
                  {historyLoading ? (
                    <p className="text-xs text-ink-500">Loading…</p>
                  ) : notificationLogs.length === 0 && reportLogs.length === 0 ? (
                    <p className="text-xs text-ink-500">No notifications sent yet.</p>
                  ) : (
                    <ul className="max-h-48 space-y-1.5 overflow-y-auto text-xs text-ink-400">
                      {[...notificationLogs, ...reportLogs]
                        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
                        .slice(0, 10)
                        .map((log) => {
                          const logKey = `${log.type || "daily_report"}-${log.id}`;
                          return (
                          <li key={logKey} className="flex items-center justify-between gap-2">
                            <span className="min-w-0 flex-1 truncate">{log.type || "daily_report"}</span>
                            <span className="min-w-0 flex-1 truncate text-ink-500">{log.recipient || "—"}</span>
                            <span
                              className={`shrink-0 ${
                                log.status === "Sent"
                                  ? "text-signal-green"
                                  : log.status === "Failed"
                                  ? "text-red-400"
                                  : "text-ink-400"
                              }`}
                            >
                              {log.status}
                            </span>
                            <button
                              type="button"
                              onClick={() => handleDeleteLog(log)}
                              disabled={deletingLogKey === logKey}
                              title="Delete"
                              className="shrink-0 rounded-md p-1 text-ink-500 hover:bg-signal-red/10 hover:text-signal-red disabled:opacity-40"
                            >
                              <Trash2 size={13} />
                            </button>
                          </li>
                          );
                        })}
                    </ul>
                  )}
                </div>
              </>
            )}
          </GlassCard>
        )}

        {/* 🖥️ System */}
        <GlassCard className="p-5">
          <SectionHeading icon={Monitor} title="System" subtitle="Application-wide refresh behavior" />
          <div className="mt-4 space-y-4">
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
        </GlassCard>

        {/* 🗑️ Storage */}
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

      {/* Single unified action pair for the whole page */}
      <div className="mt-4 flex flex-wrap justify-end gap-3">
        <Button icon={RotateCcw} variant="ghost" onClick={() => setConfirmReset(true)} disabled={resetting || saving}>
          Reset to Defaults
        </Button>
        <Button icon={Save} onClick={handleSave} disabled={saving || !isFormValid}>
          {saving ? "Saving…" : "Save Changes"}
        </Button>
      </div>

      <Modal
        open={!!confirmKey}
        onClose={() => setConfirmKey(null)}
        title={confirmKey ? CLEAR_ACTIONS[confirmKey].confirmTitle : ""}
      >
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

      <Modal open={confirmReset} onClose={() => setConfirmReset(false)} title="Reset to Defaults">
        <p className="text-sm text-ink-300">
          {targetUserId
            ? `This resets ${selectedUser?.name || "this User"}'s Camera, AI Detection, Recognition, and WhatsApp & Reports settings back to their factory defaults. This only affects this User — no one else's settings change.`
            : "This resets your Camera, AI Detection, Recognition, System, and WhatsApp & Reports settings back to their factory defaults."}
        </p>
        <div className="flex justify-end gap-3 pt-5">
          <Button type="button" variant="ghost" onClick={() => setConfirmReset(false)} disabled={resetting}>
            Cancel
          </Button>
          <Button type="button" variant="danger" onClick={handleResetToDefaults} disabled={resetting}>
            {resetting ? "Resetting…" : "Reset"}
          </Button>
        </div>
      </Modal>

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
