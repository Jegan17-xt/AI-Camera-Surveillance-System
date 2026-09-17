import { useEffect, useState } from "react";
import axios from "axios";
import { MessageSquareWarning, Save, Loader2, RotateCcw, History, Send, Trash2 } from "lucide-react";
import PageHeader from "../../components/ui/PageHeader";
import GlassCard from "../../components/ui/GlassCard";
import Button from "../../components/ui/Button";
import Modal from "../../components/ui/Modal";
import Toast from "../../components/ui/Toast";
import Toggle from "../../components/ui/Toggle";
import Select from "../../components/ui/Select";
import { API_BASE_URL } from "../../lib/apiBase";
import { DATA_EVENTS, emitDataEvent } from "../../lib/dataEvents";
import { validateWhatsappNumber, hasNoErrors, INVALID_INPUT_CLASS } from "../../lib/validation";
import { Field, ManagingSettingsFor, SectionHeading, inputClass, useSettingsTarget } from "../../components/settings/settingsShared";

// Company-level NotificationSettings <-> the same flat 5-field shape a
// per-User's own settings already use — copied verbatim from the old
// single Settings page's normalizeCompanyWhatsapp.
const normalizeCompanyWhatsapp = (s) => ({
  whatsapp_number: s.unknown_alert_recipient || s.daily_report_recipient || "",
  unknown_alert_enabled: s.unknown_alert_enabled,
  send_unknown_image: s.unknown_alert_send_image,
  vehicle_alert_enabled: s.vehicle_alert_enabled,
  fire_smoke_alert_enabled: s.fire_smoke_alert_enabled,
  animal_alert_enabled: s.animal_alert_enabled,
  bird_alert_enabled: s.bird_alert_enabled,
  daily_report_enabled: s.daily_report_enabled,
  daily_report_time: s.daily_report_time,
  daily_report_format: s.daily_report_format,
});

// Mirrors Backend/api/notification_settings.py's ALLOWED_REPORT_FORMATS.
const REPORT_FORMAT_OPTIONS = [{ value: "pdf", label: "PDF" }];

export default function NotificationSettings() {
  const { targetUserId, setTargetUserId, selectedUser, companyUsers, isCompanyAdmin } = useSettingsTarget();

  const [waSettings, setWaSettings] = useState(null);
  const [waLoading, setWaLoading] = useState(true);
  const [waError, setWaError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [generatingReport, setGeneratingReport] = useState(false);
  const [toast, setToast] = useState(null);
  const [touched, setTouched] = useState({});

  const [notificationLogs, setNotificationLogs] = useState([]);
  const [reportLogs, setReportLogs] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [deletingLogKey, setDeletingLogKey] = useState(null);

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

  useEffect(() => {
    loadWhatsappSettings();
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetUserId]);

  const setWaField = (key, value) => {
    setWaSettings((prev) => ({ ...prev, [key]: value }));
  };

  const whatsappErrors = {
    whatsapp_number: waSettings ? validateWhatsappNumber(waSettings.whatsapp_number, { label: "WhatsApp Number" }) : "",
  };

  const handleSave = () => {
    setTouched({ whatsapp_number: true });
    if (!hasNoErrors(whatsappErrors)) return;

    setSaving(true);

    const request = targetUserId
      ? axios.put(`${API_BASE_URL}/company/users/${targetUserId}/whatsapp-settings`, waSettings)
      : Promise.all([
          axios.put(`${API_BASE_URL}/notifications/settings/unknown-alert`, {
            unknown_alert_enabled: waSettings.unknown_alert_enabled,
            unknown_alert_recipient: waSettings.whatsapp_number || null,
            unknown_alert_send_image: waSettings.send_unknown_image,
          }),
          axios.put(`${API_BASE_URL}/notifications/settings/detection-alerts`, {
            vehicle_alert_enabled: waSettings.vehicle_alert_enabled,
            fire_smoke_alert_enabled: waSettings.fire_smoke_alert_enabled,
            animal_alert_enabled: waSettings.animal_alert_enabled,
            bird_alert_enabled: waSettings.bird_alert_enabled,
          }),
          axios.put(`${API_BASE_URL}/notifications/settings/daily-report`, {
            daily_report_enabled: waSettings.daily_report_enabled,
            daily_report_time: waSettings.daily_report_time,
            daily_report_recipient: waSettings.whatsapp_number || null,
            daily_report_format: waSettings.daily_report_format,
          }),
        ]).then((responses) => responses[responses.length - 1]);

    request
      .then((res) => {
        setWaSettings(targetUserId ? res.data.settings : normalizeCompanyWhatsapp(res.data.settings));
        emitDataEvent(DATA_EVENTS.SETTINGS_CHANGED);
        setToast({
          type: "success",
          message: targetUserId ? `Notification settings saved for ${selectedUser?.name || "this user"}.` : "Notification settings saved successfully.",
        });
      })
      .catch((err) => {
        console.error("Save Notification Settings API Error :", err);
        setToast({ type: "error", message: err.response?.data?.message || "Failed to save notification settings." });
      })
      .finally(() => setSaving(false));
  };

  const handleReset = () => {
    setResetting(true);
    const request = targetUserId
      ? axios.post(`${API_BASE_URL}/company/users/${targetUserId}/whatsapp-settings/reset`)
      : axios.post(`${API_BASE_URL}/notifications/settings/reset`);

    request
      .then((res) => {
        setWaSettings(targetUserId ? res.data.settings : normalizeCompanyWhatsapp(res.data.settings));
        emitDataEvent(DATA_EVENTS.SETTINGS_CHANGED);
        setToast({ type: "success", message: "Notification settings reset to defaults." });
      })
      .catch((err) => {
        console.error("Reset Notification Settings API Error :", err);
        setToast({ type: "error", message: "Failed to reset notification settings." });
      })
      .finally(() => {
        setResetting(false);
        setConfirmReset(false);
      });
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
        setToast({ type: status === "Failed" ? "error" : "success", message: `Daily report generated — WhatsApp status: ${status}.` });
        loadHistory();
      })
      .catch((err) => {
        console.error("Generate Daily Report API Error :", err);
        setToast({ type: "error", message: err.response?.data?.message || "Failed to generate report." });
      })
      .finally(() => setGeneratingReport(false));
  };

  const handleDeleteLog = (log) => {
    const key = `${log.type || "daily_report"}-${log.id}`;
    const url = log.type
      ? `${API_BASE_URL}/notifications/logs/${log.id}`
      : `${API_BASE_URL}/reports/daily-report/logs/${log.id}`;

    setDeletingLogKey(key);
    axios
      .delete(url)
      .then(() => loadHistory())
      .catch((err) => {
        setToast({ type: "error", message: err.response?.data?.message || "Failed to delete notification." });
      })
      .finally(() => setDeletingLogKey(null));
  };

  return (
    <div>
      <PageHeader eyebrow="Settings" title="Notifications" description="WhatsApp alerts, Daily Reports, and delivery history." />
      <ManagingSettingsFor
        targetUserId={targetUserId}
        setTargetUserId={setTargetUserId}
        companyUsers={companyUsers}
        isCompanyAdmin={isCompanyAdmin}
        selectedUser={selectedUser}
      />

      {waLoading ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-ink-500">
          <Loader2 size={22} className="animate-spin" />
          <p className="text-xs">Loading notification settings…</p>
        </div>
      ) : waError ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-center text-ink-500">
          <p className="text-xs text-red-400">{waError}</p>
        </div>
      ) : (
        <GlassCard className="p-5">
          <SectionHeading
            icon={MessageSquareWarning}
            title="WhatsApp & Reports"
            subtitle={
              targetUserId
                ? `Unknown-person alerts and Daily Report delivery for ${selectedUser?.name || "this user"}`
                : "Company-wide fallback WhatsApp alerts and Daily Report"
            }
          />
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
            {!targetUserId && (
              <>
                <Toggle
                  label="Vehicle Detection Notifications"
                  description="Send a WhatsApp alert when a vehicle is detected — detection and dashboard events are unaffected either way"
                  checked={waSettings.vehicle_alert_enabled}
                  onChange={(value) => setWaField("vehicle_alert_enabled", value)}
                />
                <Toggle
                  label="Fire/Smoke Notifications"
                  description="Send a WhatsApp alert when fire or smoke is detected — detection and dashboard events are unaffected either way"
                  checked={waSettings.fire_smoke_alert_enabled}
                  onChange={(value) => setWaField("fire_smoke_alert_enabled", value)}
                />
                <Toggle
                  label="Animal Detection Notifications"
                  description="Send a WhatsApp alert when an animal is detected — detection and dashboard events are unaffected either way"
                  checked={waSettings.animal_alert_enabled}
                  onChange={(value) => setWaField("animal_alert_enabled", value)}
                />
                <Toggle
                  label="Bird Detection Notifications"
                  description="Send a WhatsApp alert when a bird is detected — detection and dashboard events are unaffected either way"
                  checked={waSettings.bird_alert_enabled}
                  onChange={(value) => setWaField("bird_alert_enabled", value)}
                />
              </>
            )}
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
            <div className="grid grid-cols-1 gap-4 py-3 sm:grid-cols-2">
              <Field label="Daily Report Time">
                <input
                  type="time"
                  value={waSettings.daily_report_time}
                  onChange={(e) => setWaField("daily_report_time", e.target.value)}
                  className={inputClass}
                />
              </Field>
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
              <ul className="max-h-64 space-y-1.5 overflow-y-auto text-xs text-ink-400">
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
                            log.status === "Sent" ? "text-signal-green" : log.status === "Failed" ? "text-red-400" : "text-ink-400"
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
        </GlassCard>
      )}

      <div className="mt-4 flex flex-wrap justify-end gap-3">
        <Button icon={RotateCcw} variant="ghost" onClick={() => setConfirmReset(true)} disabled={resetting || saving || waLoading}>
          Reset to Defaults
        </Button>
        <Button icon={Save} onClick={handleSave} disabled={saving || waLoading || !hasNoErrors(whatsappErrors)}>
          {saving ? "Saving…" : "Save Changes"}
        </Button>
      </div>

      <Modal open={confirmReset} onClose={() => setConfirmReset(false)} title="Reset Notifications to Defaults">
        <p className="text-sm text-ink-300">
          {targetUserId
            ? `This resets ${selectedUser?.name || "this User"}'s WhatsApp & Reports settings back to their factory defaults.`
            : "This resets your company-wide WhatsApp & Reports settings back to their factory defaults."}
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
