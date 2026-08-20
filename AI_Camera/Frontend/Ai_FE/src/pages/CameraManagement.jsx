import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { Camera as CameraIcon, Plus, Pencil, Trash2, Wifi, Loader2, AlertTriangle, CheckCircle2, XCircle, Gauge } from "lucide-react";
import PageHeader from "../components/ui/PageHeader";
import SearchInput from "../components/ui/SearchInput";
import Button from "../components/ui/Button";
import GlassCard from "../components/ui/GlassCard";
import StatusBadge from "../components/ui/StatusBadge";
import Modal from "../components/ui/Modal";
import Toast from "../components/ui/Toast";
import UserSelect from "../components/ui/UserSelect";
import Select from "../components/ui/Select";
import { useSelectedUser } from "../context/SelectedUserContext";
import { useAuth } from "../context/AuthContext";
import { isCompanyAdmin } from "../lib/permissions";
import {
  validateTextField,
  validateIPv4,
  validatePassword,
  validatePort,
  validateChannel,
  hasNoErrors,
  INVALID_INPUT_CLASS,
} from "../lib/validation";

// Keys must match Backend/api/cameras.py CAMERA_BRANDS exactly — the
// backend is the source of truth for which brands generate a real RTSP
// template vs. "custom", which asks for one directly.
const CAMERA_BRANDS = [
  { value: "hikvision", label: "Hikvision" },
  { value: "dahua", label: "Dahua" },
  { value: "cp_plus", label: "CP Plus" },
  { value: "uniview", label: "Uniview" },
  { value: "axis", label: "Axis" },
  { value: "tplink_vigi", label: "TP-Link VIGI" },
  { value: "onvif_generic", label: "ONVIF / Generic" },
  { value: "custom", label: "Custom RTSP" },
];

const DEFAULT_PORT = "554";
const DEFAULT_CHANNEL = "1";
const DEFAULT_STREAM_QUALITY = "1080p";

// Keys must match Backend/api/cameras.py STREAM_QUALITIES exactly — see
// build_rtsp_url() there for how each maps to an actual RTSP stream.
const STREAM_QUALITIES = [
  { value: "480p", label: "480p (substream)" },
  { value: "720p", label: "720p" },
  { value: "1080p", label: "1080p" },
];

const emptyForm = {
  camera_name: "",
  brand: "hikvision",
  camera_ip: "",
  username: "",
  password: "",
  port: DEFAULT_PORT,
  channel_number: DEFAULT_CHANNEL,
  rtsp_url: "",
  camera_location: "",
  owner_user_id: "",
  stream_quality: DEFAULT_STREAM_QUALITY,
};

const inputClass =
  "w-full rounded-xl glass px-3.5 py-2.5 text-sm text-ink-100 placeholder:text-ink-500 outline-none focus:border-accent-cyan/50 focus:ring-2 focus:ring-accent-cyan/20";

function FieldError({ error }) {
  if (!error) return null;
  return <p className="mt-1.5 text-xs text-red-400">{error}</p>;
}

// Self-service camera management — same api/cameras.py functions the
// Super Admin's Customer Details page uses, scoped to this company's own
// tenant id (Backend/api/routes.py's /company/cameras* routes) instead of
// a caller-supplied customer_id. Shared page: mounted at both /admin/*
// and /user/*, reachable by a Company Admin or a User granted the
// "camera_management" module (see constants/modules.js MODULES).
export default function CameraManagement() {
  const { user } = useAuth();
  const { users: companyUsers } = useSelectedUser();
  const [query, setQuery] = useState("");
  const [cameras, setCameras] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const fetchCameras = () => {
    setLoading(true);
    setError(null);

    return axios
      .get("http://localhost:5000/company/cameras")
      .then((res) => setCameras(res.data.cameras || []))
      .catch((err) => {
        console.error("Company Cameras API Error :", err);
        setError("Unable to load cameras. Please check the server and try again.");
      })
      .finally(() => setLoading(false));
  };

  // Camera Limit / Camera Quota Management — this account's own quota
  // banner (see Backend/api/routes.py's GET /company/cameras/quota).
  // `quota.admin` is populated for a Company Admin (company-wide rollup),
  // `quota.user` for a User (their own personal rollup) — never both.
  // Purely a display/UX convenience: the backend is what actually blocks
  // an over-quota Add Camera regardless of what this shows.
  const [quota, setQuota] = useState(null);

  const fetchQuota = () => {
    return axios
      .get("http://localhost:5000/company/cameras/quota")
      .then((res) => setQuota(res.data))
      .catch(() => setQuota(null));
  };

  useEffect(() => {
    fetchCameras();
    fetchQuota();
  }, []);

  const myQuota = quota?.admin || quota?.user || null;
  const atLimit = Boolean(myQuota && myQuota.camera_limit !== null && myQuota.remaining <= 0);

  const filtered = useMemo(
    () => cameras.filter((c) => c.camera_name.toLowerCase().includes(query.toLowerCase())),
    [cameras, query]
  );

  // ---------------- Add / Edit ----------------

  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null); // null = Add
  const [form, setForm] = useState(emptyForm);
  const [touched, setTouched] = useState({});
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null); // { connected, message, reason, preview }

  const errors = {
    camera_name: validateTextField(form.camera_name, "Camera Name", { minLen: 3, maxLen: 50 }),
    camera_ip: validateIPv4(form.camera_ip, "Camera IP Address"),
    username: validateTextField(form.username, "Username", { minLen: 1, maxLen: 50 }),
    // Security fix: the backend no longer sends back a saved camera's
    // real password (see Backend/api/cameras.py's _serialize), so the
    // Edit form's password field always starts blank — while editing,
    // that blank means "keep the currently saved password" (matching
    // Backend/api/cameras.py's update_camera), not "set an empty one".
    // Add Camera (editTarget === null) is unaffected — still required.
    password:
      editTarget && !form.password
        ? ""
        : validatePassword(form.password, { label: "Password", strong: false, maxLen: 128 }),
    port: validatePort(form.port),
    channel_number: validateChannel(form.channel_number),
    rtsp_url:
      form.brand === "custom" && !form.rtsp_url.trim().toLowerCase().startsWith("rtsp://")
        ? "RTSP URL must start with rtsp:// when Camera Brand is Custom RTSP."
        : "",
  };
  const isFormValid = hasNoErrors(errors);

  const openAdd = () => {
    if (atLimit) {
      setToast({
        type: "error",
        message: quota?.user
          ? `Camera limit reached. You can use up to ${myQuota.camera_limit} cameras.`
          : "Camera limit exceeded. Your Admin account has no remaining camera capacity.",
      });
      return;
    }
    setEditTarget(null);
    setForm(emptyForm);
    setTouched({});
    setFormError(null);
    setTestResult(null);
    setFormOpen(true);
  };

  const openEdit = (camera) => {
    setEditTarget(camera);
    setForm({
      camera_name: camera.camera_name,
      brand: camera.brand || "hikvision",
      camera_ip: camera.camera_ip,
      username: camera.username || "",
      password: camera.password || "",
      port: String(camera.port || DEFAULT_PORT),
      channel_number: String(camera.channel_number || DEFAULT_CHANNEL),
      rtsp_url: camera.brand === "custom" ? camera.rtsp_url : "",
      camera_location: camera.camera_location || "",
      owner_user_id: camera.owner_user_id != null ? String(camera.owner_user_id) : "",
      stream_quality: camera.stream_quality || DEFAULT_STREAM_QUALITY,
    });
    setTouched({});
    setFormError(null);
    setTestResult(null);
    setFormOpen(true);
  };

  const closeForm = () => {
    if (saving) return;
    setFormOpen(false);
  };

  const handleTestConnection = () => {
    setTouched((t) => ({ ...t, camera_ip: true, username: true, password: true, port: true, channel_number: true }));

    if (!isFormValid) return;

    setTesting(true);
    setTestResult(null);

    axios
      .post("http://localhost:5000/company/cameras/test-connection", {
        brand: form.brand,
        camera_ip: form.camera_ip.trim(),
        username: form.username.trim(),
        password: form.password,
        port: form.port,
        channel_number: form.channel_number,
        rtsp_url: form.rtsp_url.trim(),
        stream_quality: form.stream_quality,
        camera_id: editTarget?.camera_id,
      })
      .then((res) => setTestResult(res.data))
      .catch((err) => {
        setTestResult({ connected: false, message: err.response?.data?.message || "Connection test failed." });
      })
      .finally(() => setTesting(false));
  };

  const handleSave = (e) => {
    e.preventDefault();
    setTouched({
      camera_name: true,
      camera_ip: true,
      username: true,
      password: true,
      port: true,
      channel_number: true,
      rtsp_url: true,
    });
    if (!isFormValid) return;
    setFormError(null);
    setSaving(true);

    const payload = {
      camera_name: form.camera_name.trim(),
      brand: form.brand,
      camera_ip: form.camera_ip.trim(),
      username: form.username.trim(),
      password: form.password,
      port: form.port,
      channel_number: form.channel_number,
      rtsp_url: form.rtsp_url.trim(),
      camera_location: form.camera_location.trim(),
      owner_user_id: form.owner_user_id === "" ? null : Number(form.owner_user_id),
      stream_quality: form.stream_quality,
    };

    const request = editTarget
      ? axios.put(`http://localhost:5000/company/cameras/${editTarget.camera_id}`, payload)
      : axios.post("http://localhost:5000/company/cameras", payload);

    request
      .then(() => {
        setToast({ type: "success", message: editTarget ? "Camera updated successfully." : "Camera added successfully." });
        setFormOpen(false);
        fetchQuota();
        return fetchCameras();
      })
      .catch((err) => {
        setFormError(err.response?.data?.message || "Failed to save camera.");
      })
      .finally(() => setSaving(false));
  };

  // ---------------- Delete ----------------

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const handleConfirmDelete = () => {
    if (!deleteTarget) return;
    setDeleting(true);

    axios
      .delete(`http://localhost:5000/company/cameras/${deleteTarget.camera_id}`)
      .then(() => {
        setToast({ type: "success", message: `${deleteTarget.camera_name} deleted successfully.` });
        fetchQuota();
        return fetchCameras();
      })
      .catch(() => setToast({ type: "error", message: `Failed to delete ${deleteTarget.camera_name}.` }))
      .finally(() => {
        setDeleting(false);
        setDeleteTarget(null);
      });
  };

  // ---------------- AI Detection on/off ----------------
  // Starts/stops that camera's background worker in the AI Detection
  // Engine (camera/detection_service.py) — independent of the Live
  // Camera page. A disabled camera keeps its saved connection details;
  // re-enabling it resumes detection immediately.

  const [togglingId, setTogglingId] = useState(null);

  const handleToggleDetection = (camera) => {
    setTogglingId(camera.camera_id);

    axios
      .put(`http://localhost:5000/company/cameras/${camera.camera_id}/detection`, {
        detection_enabled: !camera.detection_enabled,
      })
      .then(() => fetchCameras())
      .catch(() =>
        setToast({ type: "error", message: `Failed to update detection for ${camera.camera_name}.` })
      )
      .finally(() => setTogglingId(null));
  };

  return (
    <div>
      <PageHeader
        eyebrow="Infrastructure"
        title="Camera Management"
        description="Add, edit, and remove your company's cameras."
        actions={
          <Button icon={Plus} onClick={openAdd} disabled={atLimit} title={atLimit ? "Camera limit reached" : undefined}>
            Add Camera
          </Button>
        }
      />

      {/* Camera Limit / Camera Quota Management */}
      {myQuota && (
        <GlassCard className="mb-5 p-4 sm:p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <Gauge size={16} className={atLimit ? "text-signal-red" : "text-accent-cyan"} />
              <p className="text-sm font-medium text-ink-100">
                {quota?.admin ? "Company Camera Quota" : "Your Camera Quota"}
              </p>
              {myQuota.status === "Over Limit" && (
                <span className="rounded-full border border-signal-red/30 bg-signal-red/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-signal-red">
                  Over Limit
                </span>
              )}
              {myQuota.status === "Active" && atLimit && (
                <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-300">
                  Limit Reached
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 font-mono text-xs text-ink-400">
              <span>
                Limit: <span className="text-ink-100">{myQuota.camera_limit === null ? "Unlimited" : myQuota.camera_limit}</span>
              </span>
              <span>
                Used: <span className="text-ink-100">{myQuota.used}</span>
              </span>
              {myQuota.camera_limit !== null && (
                <span>
                  Remaining: <span className="text-ink-100">{myQuota.remaining}</span>
                </span>
              )}
              {quota?.admin && (
                <>
                  <span>
                    Users: <span className="text-ink-100">{quota.admin.user_count}</span>
                  </span>
                  <span>
                    Allocated to Users: <span className="text-ink-100">{quota.admin.allocated_to_users}</span>
                  </span>
                </>
              )}
            </div>
          </div>

          {myQuota.camera_limit !== null && (
            <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/5">
              <div
                className={`h-full rounded-full ${myQuota.usage_percent >= 100 ? "bg-signal-red" : myQuota.usage_percent >= 90 ? "bg-amber-400" : "bg-accent-cyan"}`}
                style={{ width: `${Math.min(100, myQuota.usage_percent)}%` }}
              />
            </div>
          )}

          {myQuota.status === "Over Limit" && (
            <p className="mt-2.5 text-xs text-signal-red">
              {quota?.admin
                ? `This company is ${myQuota.over_limit_by} camera${myQuota.over_limit_by === 1 ? "" : "s"} over its limit. Remove cameras or ask your Super Admin to raise the limit before adding more.`
                : `You are ${myQuota.over_limit_by} camera${myQuota.over_limit_by === 1 ? "" : "s"} over your limit. Remove a camera or ask your Admin to raise your limit before adding more.`}
            </p>
          )}
        </GlassCard>
      )}

      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SearchInput value={query} onChange={setQuery} placeholder="Search by name…" className="max-w-sm" />
        <p className="font-mono text-xs text-ink-500">{loading ? "Loading…" : `${filtered.length} of ${cameras.length} cameras`}</p>
      </div>

      {loading && (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-ink-500">
          <Loader2 size={22} className="animate-spin" />
          <p className="text-xs">Loading cameras…</p>
        </div>
      )}

      {!loading && error && (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-center text-ink-500">
          <AlertTriangle size={22} className="text-red-400" />
          <p className="text-xs">{error}</p>
        </div>
      )}

      {!loading && !error && (
        <GlassCard className="p-4 sm:p-5">
          <div className="custom-scroll overflow-x-auto">
            <table className="w-full min-w-[680px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-accent-cyan/10 text-xs uppercase tracking-wide text-ink-500">
                  <th className="px-3 py-3 font-medium">Name</th>
                  <th className="px-3 py-3 font-medium">IP Address</th>
                  <th className="px-3 py-3 font-medium">Location</th>
                  <th className="px-3 py-3 font-medium">Assigned User</th>
                  <th className="px-3 py-3 font-medium">Quality</th>
                  <th className="px-3 py-3 font-medium">Status</th>
                  <th className="px-3 py-3 font-medium">Detection</th>
                  <th className="w-24 px-3 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((camera) => (
                  <tr key={camera.camera_id} className="border-b border-white/5 transition hover:bg-white/[0.03]">
                    <td className="px-3 py-3 font-medium text-ink-100">{camera.camera_name}</td>
                    <td className="px-3 py-3 font-mono text-xs text-ink-400">{camera.camera_ip}</td>
                    <td className="px-3 py-3 text-xs text-ink-400">{camera.camera_location || "—"}</td>
                    <td className="px-3 py-3 text-xs text-ink-400">
                      {companyUsers.find((u) => u.id === camera.owner_user_id)?.name || "Unassigned"}
                    </td>
                    <td className="px-3 py-3 font-mono text-xs text-ink-400">{camera.stream_quality || DEFAULT_STREAM_QUALITY}</td>
                    <td className="px-3 py-3">
                      <StatusBadge status={camera.status} />
                    </td>
                    <td className="px-3 py-3">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={camera.detection_enabled}
                        disabled={togglingId === camera.camera_id}
                        onClick={() => handleToggleDetection(camera)}
                        title={camera.detection_enabled ? "AI detection running — click to pause" : "AI detection paused — click to resume"}
                        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-300 ease-in-out disabled:opacity-50 ${
                          camera.detection_enabled ? "bg-signal-green" : "bg-white/15"
                        }`}
                      >
                        <span
                          className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition-transform duration-300 ease-in-out ${
                            camera.detection_enabled ? "translate-x-[22px]" : "translate-x-0.5"
                          }`}
                        />
                      </button>
                    </td>
                    <td className="px-3 py-3 text-right">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => openEdit(camera)}
                          title="Edit"
                          className="rounded-md p-2 text-ink-400 hover:bg-white/5 hover:text-accent-cyan"
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(camera)}
                          title="Delete"
                          className="rounded-md p-2 text-ink-400 hover:bg-signal-red/10 hover:text-signal-red"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}

                {cameras.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-16 text-center text-ink-500">
                      <div className="flex flex-col items-center gap-2">
                        <CameraIcon size={22} />
                        <p>No cameras have been added yet.</p>
                      </div>
                    </td>
                  </tr>
                )}

                {cameras.length > 0 && filtered.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-12 text-center text-ink-500">
                      No cameras match "{query}".
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </GlassCard>
      )}

      {/* Add / Edit */}
      <Modal open={formOpen} onClose={closeForm} title={editTarget ? "Edit Camera" : "Add Camera"} size="xl">
        <form className="space-y-4" onSubmit={handleSave}>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-400">Camera Name</label>
            <input
              type="text"
              value={form.camera_name}
              onChange={(e) => setForm((f) => ({ ...f, camera_name: e.target.value }))}
              onBlur={() => setTouched((t) => ({ ...t, camera_name: true }))}
              className={`${inputClass} ${touched.camera_name && errors.camera_name ? INVALID_INPUT_CLASS : ""}`}
            />
            {touched.camera_name && <FieldError error={errors.camera_name} />}
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-400">Camera Brand</label>
            <Select
              value={form.brand}
              onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))}
              options={CAMERA_BRANDS}
            />
          </div>

          {form.brand === "custom" && (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink-400">Custom RTSP URL</label>
              <input
                type="text"
                value={form.rtsp_url}
                onChange={(e) => setForm((f) => ({ ...f, rtsp_url: e.target.value }))}
                onBlur={() => setTouched((t) => ({ ...t, rtsp_url: true }))}
                placeholder="rtsp://username:password@ip:port/path"
                className={`${inputClass} ${touched.rtsp_url && errors.rtsp_url ? INVALID_INPUT_CLASS : ""}`}
              />
              {touched.rtsp_url && <FieldError error={errors.rtsp_url} />}
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink-400">Camera IP Address</label>
              <input
                type="text"
                value={form.camera_ip}
                onChange={(e) => setForm((f) => ({ ...f, camera_ip: e.target.value }))}
                onBlur={() => setTouched((t) => ({ ...t, camera_ip: true }))}
                placeholder="192.168.1.10"
                className={`${inputClass} ${touched.camera_ip && errors.camera_ip ? INVALID_INPUT_CLASS : ""}`}
              />
              {touched.camera_ip && <FieldError error={errors.camera_ip} />}
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink-400">Location</label>
              <input
                type="text"
                value={form.camera_location}
                onChange={(e) => setForm((f) => ({ ...f, camera_location: e.target.value }))}
                placeholder="Optional"
                className={inputClass}
              />
            </div>
          </div>

          {/* Company Admin only — a User has no other Users to assign a
              camera to, so this field is simply hidden for that role. The
              underlying owner_user_id field/logic is untouched: form.owner_user_id
              stays "" (its initial value) for a User's Add Camera submit,
              same as leaving this dropdown on "Unassigned" would produce. */}
          {isCompanyAdmin(user) && (
            <UserSelect
              users={companyUsers}
              value={form.owner_user_id}
              onChange={(e) => setForm((f) => ({ ...f, owner_user_id: e.target.value }))}
              label="Assign to User (Optional)"
              emptyOptionLabel="Unassigned"
            />
          )}

          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-400">Camera Quality</label>
            <Select
              value={form.stream_quality}
              onChange={(e) => setForm((f) => ({ ...f, stream_quality: e.target.value }))}
              options={STREAM_QUALITIES}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink-400">Username</label>
              <input
                type="text"
                value={form.username}
                onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                onBlur={() => setTouched((t) => ({ ...t, username: true }))}
                className={`${inputClass} ${touched.username && errors.username ? INVALID_INPUT_CLASS : ""}`}
              />
              {touched.username && <FieldError error={errors.username} />}
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink-400">Password</label>
              <input
                type="password"
                placeholder={editTarget ? "Leave blank to keep the current password" : undefined}
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                onBlur={() => setTouched((t) => ({ ...t, password: true }))}
                autoComplete="new-password"
                className={`${inputClass} ${touched.password && errors.password ? INVALID_INPUT_CLASS : ""}`}
              />
              {touched.password && <FieldError error={errors.password} />}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink-400">Port</label>
              <input
                type="text"
                value={form.port}
                onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))}
                onBlur={() => setTouched((t) => ({ ...t, port: true }))}
                className={`${inputClass} ${touched.port && errors.port ? INVALID_INPUT_CLASS : ""}`}
              />
              {touched.port && <FieldError error={errors.port} />}
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink-400">Channel Number</label>
              <input
                type="text"
                value={form.channel_number}
                onChange={(e) => setForm((f) => ({ ...f, channel_number: e.target.value }))}
                onBlur={() => setTouched((t) => ({ ...t, channel_number: true }))}
                className={`${inputClass} ${touched.channel_number && errors.channel_number ? INVALID_INPUT_CLASS : ""}`}
              />
              {touched.channel_number && <FieldError error={errors.channel_number} />}
            </div>
          </div>

          <div>
            <Button type="button" variant="ghost" icon={Wifi} onClick={handleTestConnection} disabled={testing}>
              {testing ? "Testing…" : "Test Connection"}
            </Button>

            {testResult && (
              <div
                className={`mt-3 flex items-start gap-2 rounded-xl border px-3.5 py-2.5 text-xs ${
                  testResult.connected
                    ? "border-signal-green/30 bg-signal-green/10 text-signal-green"
                    : "border-signal-red/30 bg-signal-red/10 text-signal-red"
                }`}
              >
                {testResult.connected ? (
                  <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
                ) : (
                  <XCircle size={14} className="mt-0.5 shrink-0" />
                )}
                <span>{testResult.reason || testResult.message}</span>
              </div>
            )}
          </div>

          {formError && (
            <div className="flex items-start gap-2 rounded-xl border border-signal-red/30 bg-signal-red/10 px-3.5 py-2.5 text-xs text-signal-red">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{formError}</span>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="ghost" onClick={closeForm} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !isFormValid}>
              {saving ? "Saving…" : "Save Camera"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Delete Confirmation */}
      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Delete Camera">
        <p className="text-sm text-ink-300">
          Are you sure you want to delete <span className="text-white">{deleteTarget?.camera_name}</span>?
        </p>
        <div className="flex justify-end gap-3 pt-5">
          <Button type="button" variant="ghost" onClick={() => setDeleteTarget(null)} disabled={deleting}>
            Cancel
          </Button>
          <Button type="button" variant="danger" onClick={handleConfirmDelete} disabled={deleting}>
            {deleting ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </Modal>

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
