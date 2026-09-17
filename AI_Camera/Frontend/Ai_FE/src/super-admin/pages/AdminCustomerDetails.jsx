import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import axios from "axios";
import { ArrowLeft, Camera, Plus, Pencil, Trash2, Loader2, AlertTriangle, VideoOff, BrainCircuit, CheckCircle2, XCircle, Wifi, ChevronDown } from "lucide-react";
import AdminPageHeader from "../ui/AdminPageHeader";
import AdminCard from "../ui/AdminCard";
import AdminButton from "../ui/AdminButton";
import AdminModal from "../ui/AdminModal";
import AdminToast from "../ui/AdminToast";
import AdminBadge from "../ui/AdminBadge";
import AdminToggle from "../ui/AdminToggle";
import AdminSelect from "../ui/AdminSelect";
import { DATA_EVENTS, emitDataEvent, useDataEvent } from "../../lib/dataEvents";
import { API_BASE_URL } from "../../lib/apiBase";
import {
  validateTextField,
  validateIPv4,
  validatePassword,
  validatePort,
  validateChannel,
  hasNoErrors,
  INVALID_INPUT_CLASS,
} from "../../lib/validation";

const inputClass =
  "w-full rounded-md admin-panel px-3.5 py-3 text-sm text-ink-100 placeholder:text-ink-500 outline-none focus:border-admin-accent/50 focus:ring-2 focus:ring-admin-accent/20";

// Every field in the Add/Edit Camera form renders at this same width via
// a 2-column grid — Custom RTSP URL, the Connection Test panel, and the
// button row each span both columns since they don't pair naturally
// with a neighboring field. Also reused inside AdvancedSettingsSection
// so Port/Channel Number line up the same way once expanded.
const cameraFormGridClass = "grid grid-cols-1 gap-x-6 gap-y-5 sm:grid-cols-2";

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

const BRAND_LABELS = Object.fromEntries(CAMERA_BRANDS.map((b) => [b.value, b.label]));

// Port 554 and Channel 1 are the values used by the overwhelming
// majority of DVRs/cameras out of the box — non-technical users should
// never have to know these exist unless a test connection actually
// fails, so both fields default in even if Advanced Settings is never opened.
const DEFAULT_PORT = "554";
const DEFAULT_CHANNEL = "1";

const emptyCameraForm = {
  camera_name: "",
  brand: "hikvision",
  camera_ip: "",
  username: "",
  password: "",
  port: DEFAULT_PORT,
  channel_number: DEFAULT_CHANNEL,
  rtsp_url: "",
  camera_location: "",
};

// Editing any of these invalidates whatever RTSP connection test
// already ran — the RTSP URL the backend generates is derived entirely
// from them (see Backend/api/cameras.py build_rtsp_url), so a stale
// "Camera Connected" result must never survive a field the URL is
// actually built from changing underneath it.
const CONNECTION_FIELDS = ["brand", "camera_ip", "username", "password", "port", "channel_number", "rtsp_url"];

// Camera/DVR device username — required + max-length only, matching
// Backend/api/cameras.py's validate_connection_fields exactly (that
// function never charset-restricts the username, unlike Camera Name).
function validateCameraUsername(value) {
  const trimmed = (value || "").trim();

  if (!trimmed) {
    return "Username is required.";
  }

  if (trimmed.length > 50) {
    return "Username must be 50 characters or fewer.";
  }

  return "";
}

function validateCustomRtspField(value) {
  const trimmed = (value || "").trim();

  if (!trimmed) {
    return "RTSP URL is required when Camera Brand is Custom RTSP.";
  }

  if (!trimmed.toLowerCase().startsWith("rtsp://")) {
    return "RTSP URL must start with rtsp://.";
  }

  if (trimmed.length > 500) {
    return "RTSP URL must be 500 characters or fewer.";
  }

  return "";
}

// Mirrors Backend/api/cameras.py's validation exactly (same field-by-field
// rules), so nothing that passes here ever gets surprised by the backend.
// Username/Password are camera/DVR device credentials, not app-account
// fields — required + max-length only, no charset/complexity policy,
// since a DVR's own login is outside this app's control.
//
// Security fix: the backend no longer sends back a saved camera's real
// password (see Backend/api/cameras.py's _serialize), so the Edit form's
// password field always starts blank — `isEditing: true` treats that
// blank as "keep the currently saved password" (matching
// Backend/api/cameras.py's update_camera) instead of blocking the save
// entirely. The Add form (isEditing left false) is unaffected — a
// password is still always required there.
function computeCameraErrors(form, { isEditing = false } = {}) {
  const errors = {
    camera_name: validateTextField(form.camera_name, "Camera Name", { minLen: 3, maxLen: 50 }),
    camera_ip: validateIPv4(form.camera_ip, "Camera IP Address"),
    username: validateCameraUsername(form.username),
    password:
      isEditing && !form.password
        ? ""
        : validatePassword(form.password, { label: "Password", strong: false, maxLen: 128 }),
    camera_location: validateTextField(form.camera_location, "Camera Location", {
      maxLen: 100,
      required: false,
      addressLike: true,
    }),
    port: validatePort(form.port),
    channel_number: validateChannel(form.channel_number),
  };

  if (form.brand === "custom") {
    errors.rtsp_url = validateCustomRtspField(form.rtsp_url);
  }

  return errors;
}

// Only the fields the Test Camera / connection-test payload actually
// sends (see handleTestConnection below) — Camera Name/Location aren't
// part of it, so an in-progress typo there shouldn't block testing.
const CONNECTION_ERROR_KEYS = ["camera_ip", "username", "password", "port", "channel_number", "rtsp_url"];

const isConnectionValid = (errors) => CONNECTION_ERROR_KEYS.every((key) => !errors[key]);

const isFormTestable = (form) =>
  Boolean(
    form.camera_ip &&
      form.username &&
      form.password &&
      form.port &&
      form.channel_number &&
      (form.brand !== "custom" || form.rtsp_url)
  );

function ConnectionTestStatus({ testing, testResult, channelNumber, onOpenAdvanced }) {
  if (testing) {
    return (
      <p className="mt-1.5 flex items-center gap-1.5 text-xs text-ink-400">
        <Loader2 size={13} className="animate-spin" /> Testing connection…
      </p>
    );
  }

  if (!testResult) {
    return <p className="mt-1.5 text-xs text-ink-500">Not tested yet.</p>;
  }

  return (
    <div className="mt-1.5">
      {testResult.connected ? (
        <p className="flex items-center gap-1.5 text-xs text-signal-green">
          <CheckCircle2 size={13} /> Camera Connected
        </p>
      ) : (
        <>
          <p className="flex items-center gap-1.5 text-xs text-signal-red">
            <XCircle size={13} /> Camera Connection Failed
          </p>
          <p className="mt-1 text-xs text-ink-500">
            Unable to connect using Channel {channelNumber}. If your DVR uses another channel,{" "}
            <button
              type="button"
              onClick={onOpenAdvanced}
              className="text-admin-accent underline underline-offset-2 hover:text-admin-accent/80"
            >
              open Advanced Settings
            </button>{" "}
            and change the Channel Number.
          </p>
        </>
      )}
      {testResult.reason && <p className="mt-1 text-xs text-ink-500">{testResult.reason}</p>}
    </div>
  );
}

function ConnectionTestPanel({ form, testing, testResult, onTest, onOpenAdvanced }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-ink-300">Connection Test</p>
          <ConnectionTestStatus
            testing={testing}
            testResult={testResult}
            channelNumber={form.channel_number}
            onOpenAdvanced={onOpenAdvanced}
          />
        </div>
        <AdminButton
          type="button"
          variant="secondary"
          icon={Wifi}
          onClick={onTest}
          disabled={testing || !isFormTestable(form) || !isConnectionValid(computeCameraErrors(form))}
        >
          {testing ? "Testing…" : "Test Camera"}
        </AdminButton>
      </div>

      {testResult?.connected && testResult.preview && (
        <img
          src={testResult.preview}
          alt="Camera preview"
          className="mt-3 max-h-48 w-full rounded-md border border-white/10 object-cover"
        />
      )}
    </div>
  );
}

// Collapsed by default so non-technical users never have to see Port /
// Channel Number unless a test connection actually fails and they need
// to change them. Uses the CSS grid-template-rows 0fr/1fr trick so the
// expand/collapse animates smoothly without measuring content height in JS.
function AdvancedSettingsSection({ open, onToggle, children }) {
  return (
    <div className="sm:col-span-2">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-md border border-white/10 bg-white/[0.02] px-3.5 py-2.5 text-left text-xs font-medium text-ink-300 transition-colors hover:bg-white/[0.05]"
      >
        <span>Advanced Settings</span>
        <ChevronDown size={14} className={`shrink-0 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>
      <div className="grid transition-[grid-template-rows] duration-300 ease-in-out" style={{ gridTemplateRows: open ? "1fr" : "0fr" }}>
        <div className="overflow-hidden">
          <div className={`${cameraFormGridClass} pt-4`}>{children}</div>
        </div>
      </div>
    </div>
  );
}

// Super Admin only — never rendered in the User Portal. The AI pipeline
// (Backend/camera/frame_processor.py, Backend/face/unknown_manager.py,
// Backend/events/manager.py) reads these keys per customer before
// running recognition / object / fire detection.
const AI_CONFIG_FIELDS = [
  {
    key: "face_recognition_enabled",
    label: "Face Recognition",
    description: "Master switch for this customer. Off stops registered-person recognition, attendance, and unknown-person detection entirely.",
  },
  {
    key: "save_unknown_persons",
    label: "Save Unknown Persons",
    description: "Off still detects unknown faces, but saves no image, embedding, or unknown-person record.",
  },
  {
    key: "attendance_enabled",
    label: "Attendance Recording",
    description: "Off still shows recognized names live, but creates no attendance record.",
  },
  {
    key: "unknown_alerts_enabled",
    label: "Unknown Person Alerts",
    description: "Off still saves unknown persons as usual, but raises no alert notification.",
  },
  {
    key: "object_detection_enabled",
    label: "Vehicle Detection",
    description: "Off ignores cars/motorcycles/buses/trucks/bicycles — no bounding box, no event recorded.",
  },
  {
    key: "animal_detection_enabled",
    label: "Animal Detection",
    description: "Off ignores common animals (dog, cat, cow, horse, sheep, bird…) — no bounding box, no event recorded.",
  },
  {
    key: "fire_detection_enabled",
    label: "Fire / Smoke Detection",
    description: "Off never runs the optional fire/smoke model. On raises a FIRE DETECTED alert + snapshot when a fire model is installed.",
  },
];

export default function AdminCustomerDetails() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [customer, setCustomer] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [cameras, setCameras] = useState([]);
  const [camerasLoading, setCamerasLoading] = useState(true);
  const [camerasError, setCamerasError] = useState(null);

  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState(emptyCameraForm);
  const [addAdvancedOpen, setAddAdvancedOpen] = useState(false);
  const [addTouched, setAddTouched] = useState({});
  const [saving, setSaving] = useState(false);

  const [editTarget, setEditTarget] = useState(null);
  const [editForm, setEditForm] = useState(emptyCameraForm);
  const [editAdvancedOpen, setEditAdvancedOpen] = useState(false);
  const [editTouched, setEditTouched] = useState({});

  const addErrors = computeCameraErrors(addForm);
  const isAddFormValid = hasNoErrors(addErrors);

  const editErrors = computeCameraErrors(editForm, { isEditing: true });
  const isEditFormValid = hasNoErrors(editErrors);

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const [aiConfig, setAiConfig] = useState(null);
  const [aiConfigLoading, setAiConfigLoading] = useState(true);
  const [aiConfigError, setAiConfigError] = useState(null);
  const [savingKey, setSavingKey] = useState(null);

  const fetchCustomer = () => {
    setLoading(true);
    setError(null);

    return axios
      .get(`${API_BASE_URL}/users/${id}`)
      .then((res) => setCustomer(res.data.user))
      .catch((err) => {
        console.error("Customer Details API Error :", err);
        setError("Unable to load this customer. Please check the server and try again.");
      })
      .finally(() => setLoading(false));
  };

  const fetchCameras = () => {
    setCamerasLoading(true);
    setCamerasError(null);

    return axios
      .get(`${API_BASE_URL}/users/${id}/cameras`)
      .then((res) => setCameras(res.data.cameras || []))
      .catch((err) => {
        console.error("Cameras API Error :", err);
        setCamerasError("Unable to load cameras. Please check the server and try again.");
      })
      .finally(() => setCamerasLoading(false));
  };

  const fetchAiConfig = () => {
    setAiConfigLoading(true);
    setAiConfigError(null);

    return axios
      .get(`${API_BASE_URL}/users/${id}/ai-config`)
      .then((res) => setAiConfig(res.data.ai_config))
      .catch((err) => {
        console.error("AI Configuration API Error :", err);
        setAiConfigError("Unable to load AI configuration. Please check the server and try again.");
      })
      .finally(() => setAiConfigLoading(false));
  };

  useEffect(() => {
    fetchCustomer();
    fetchCameras();
    fetchAiConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Another Admin page (Customers list) may have changed this exact
  // customer's name/email/status since this header was last loaded.
  useDataEvent(DATA_EVENTS.CUSTOMERS_CHANGED, fetchCustomer);

  const handleAiToggle = (key, value) => {
    const previous = aiConfig;
    setAiConfig((prev) => ({ ...prev, [key]: value }));
    setSavingKey(key);

    axios
      .put(`${API_BASE_URL}/users/${id}/ai-config`, { [key]: value })
      .then((res) => {
        setAiConfig(res.data.ai_config);
        emitDataEvent(DATA_EVENTS.AI_CONFIG_CHANGED, { customerId: id });
      })
      .catch((err) => {
        console.error("AI Configuration Update API Error :", err);
        setAiConfig(previous);
        setToast({ type: "error", message: err.response?.data?.message || "Failed to update AI configuration." });
      })
      .finally(() => setSavingKey(null));
  };

  const resetConnectionTest = () => {
    setTesting(false);
    setTestResult(null);
  };

  const openAdd = () => {
    setAddForm(emptyCameraForm);
    setAddAdvancedOpen(false);
    setAddTouched({});
    resetConnectionTest();
    setAddOpen(true);
  };

  const updateAddField = (key, value) => {
    setAddForm((f) => ({ ...f, [key]: value }));
    if (CONNECTION_FIELDS.includes(key)) {
      setTestResult(null);
    }
  };

  const updateEditField = (key, value) => {
    setEditForm((f) => ({ ...f, [key]: value }));
    if (CONNECTION_FIELDS.includes(key)) {
      setTestResult(null);
    }
  };

  const handleTestConnection = (form, cameraId) => {
    setTesting(true);
    setTestResult(null);

    axios
      .post(`${API_BASE_URL}/users/${id}/cameras/test-connection`, {
        brand: form.brand,
        camera_ip: form.camera_ip,
        username: form.username,
        password: form.password,
        port: form.port,
        channel_number: form.channel_number,
        rtsp_url: form.rtsp_url,
        camera_id: cameraId,
      })
      .then((res) => {
        setTestResult({
          connected: res.data.connected,
          reason: res.data.reason,
          preview: res.data.preview,
        });
        // A test tied to an already-saved camera_id persists its
        // status/last_connected_time on the backend immediately —
        // refresh the list so the table reflects it right away, and
        // tell every other listener (Sidebar's camera-status widget,
        // the Admin Dashboard) an Online/Offline flip just happened.
        if (cameraId) {
          fetchCameras();
          emitDataEvent(DATA_EVENTS.CAMERAS_CHANGED, { customerId: id });
        }
      })
      .catch((err) => {
        setTestResult({
          connected: false,
          reason: err.response?.data?.message || "Unable to reach the server.",
        });
      })
      .finally(() => setTesting(false));
  };

  const handleAdd = (e, force = false) => {
    e.preventDefault();

    setAddTouched({
      camera_name: true,
      camera_ip: true,
      username: true,
      password: true,
      camera_location: true,
      port: true,
      channel_number: true,
      rtsp_url: true,
    });

    if (!isAddFormValid) return;

    if (!force && !testResult?.connected) {
      setToast({ type: "error", message: 'Test the camera connection first, or use "Save Anyway".' });
      return;
    }

    setSaving(true);

    axios
      .post(`${API_BASE_URL}/users/${id}/cameras`, addForm)
      .then(() => {
        setToast({ type: "success", message: "Camera added successfully." });
        setAddOpen(false);
        emitDataEvent(DATA_EVENTS.CAMERAS_CHANGED, { customerId: id });
        return fetchCameras();
      })
      .catch((err) => {
        setToast({ type: "error", message: err.response?.data?.message || "Failed to add camera." });
      })
      .finally(() => setSaving(false));
  };

  const openEdit = (camera) => {
    const port = camera.port != null ? String(camera.port) : DEFAULT_PORT;
    const channelNumber = camera.channel_number != null ? String(camera.channel_number) : DEFAULT_CHANNEL;

    setEditTarget(camera);
    setEditForm({
      camera_name: camera.camera_name,
      brand: camera.brand || "hikvision",
      camera_ip: camera.camera_ip,
      username: camera.username || "",
      password: camera.password || "",
      port,
      channel_number: channelNumber,
      rtsp_url: camera.brand === "custom" ? camera.rtsp_url || "" : "",
      camera_location: camera.camera_location,
    });
    // If this camera already uses a non-default port/channel, surface
    // Advanced Settings expanded so the user immediately sees the
    // values actually in effect instead of them being hidden away.
    setEditAdvancedOpen(port !== DEFAULT_PORT || channelNumber !== DEFAULT_CHANNEL);
    setEditTouched({});
    resetConnectionTest();
  };

  const closeEdit = () => {
    if (saving) return;
    setEditTarget(null);
  };

  const handleEditSave = (e, force = false) => {
    e.preventDefault();
    if (!editTarget) return;

    setEditTouched({
      camera_name: true,
      camera_ip: true,
      username: true,
      password: true,
      camera_location: true,
      port: true,
      channel_number: true,
      rtsp_url: true,
    });

    if (!isEditFormValid) return;

    if (!force && !testResult?.connected) {
      setToast({ type: "error", message: 'Test the camera connection first, or use "Save Anyway".' });
      return;
    }

    setSaving(true);

    axios
      .put(`${API_BASE_URL}/users/${id}/cameras/${editTarget.camera_id}`, editForm)
      .then(() => {
        setToast({ type: "success", message: "Camera updated successfully." });
        setEditTarget(null);
        emitDataEvent(DATA_EVENTS.CAMERAS_CHANGED, { customerId: id });
        return fetchCameras();
      })
      .catch((err) => {
        setToast({ type: "error", message: err.response?.data?.message || "Failed to update camera." });
      })
      .finally(() => setSaving(false));
  };

  const requestDelete = (camera) => setDeleteTarget(camera);

  const handleConfirmDelete = () => {
    if (!deleteTarget) return;
    setDeleting(true);

    axios
      .delete(`${API_BASE_URL}/users/${id}/cameras/${deleteTarget.camera_id}`)
      .then(() => {
        setToast({ type: "success", message: "Camera deleted successfully." });
        // Drop it from the visible list immediately — the delete has
        // already succeeded on the server at this point.
        setCameras((prev) => prev.filter((c) => c.camera_id !== deleteTarget.camera_id));
        setDeleteTarget(null);
        emitDataEvent(DATA_EVENTS.CAMERAS_CHANGED, { customerId: id });
      })
      .catch((err) => {
        setToast({ type: "error", message: err.response?.data?.message || "Failed to delete camera." });
      })
      .finally(() => setDeleting(false));
  };

  return (
    <div>
      <AdminPageHeader
        eyebrow="Customer"
        title={loading ? "Customer Details" : customer?.name || "Customer Details"}
        description={!loading ? customer?.email : "Loading customer…"}
        actions={
          <AdminButton variant="ghost" icon={ArrowLeft} onClick={() => navigate("/super-admin/company-management")}>
            Back to Customers
          </AdminButton>
        }
      />

      {loading && (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-ink-500">
          <Loader2 size={22} className="animate-spin text-admin-accent" />
          <p className="text-xs">Loading customer…</p>
        </div>
      )}

      {!loading && error && (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center text-ink-500">
          <AlertTriangle size={22} className="text-red-400" />
          <p className="text-xs">{error}</p>
        </div>
      )}

      {!loading && !error && customer && (
        <>
          <AdminCard className="mb-4 p-5">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
              <div>
                <p className="text-xs text-ink-500">Name</p>
                <p className="mt-1 text-sm font-medium text-white">{customer.name}</p>
              </div>
              <div>
                <p className="text-xs text-ink-500">Username</p>
                <p className="mt-1 font-mono text-sm text-ink-200">{customer.username}</p>
              </div>
              <div>
                <p className="text-xs text-ink-500">Email</p>
                <p className="mt-1 text-sm text-ink-200">{customer.email}</p>
              </div>
              <div>
                <p className="text-xs text-ink-500">Status</p>
                <div className="mt-1">
                  <AdminBadge status={customer.status} />
                </div>
              </div>
            </div>
          </AdminCard>

          <AdminCard className="p-4 sm:p-5">
            <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-md bg-admin-accent/10 text-admin-accent">
                  <Camera size={19} />
                </span>
                <div>
                  <p className="font-display text-sm font-semibold text-white">Camera Management</p>
                  <p className="text-xs text-ink-500">Cameras assigned to this customer</p>
                </div>
              </div>
              <AdminButton icon={Plus} onClick={openAdd}>
                Add Camera
              </AdminButton>
            </div>

            {camerasLoading && (
              <div className="flex flex-col items-center justify-center gap-3 py-16 text-ink-500">
                <Loader2 size={22} className="animate-spin text-admin-accent" />
                <p className="text-xs">Loading cameras…</p>
              </div>
            )}

            {!camerasLoading && camerasError && (
              <div className="flex flex-col items-center justify-center gap-3 py-16 text-center text-ink-500">
                <AlertTriangle size={22} className="text-red-400" />
                <p className="text-xs">{camerasError}</p>
              </div>
            )}

            {!camerasLoading && !camerasError && (
              <div className="custom-scroll overflow-x-auto">
                <table className="w-full min-w-[980px] border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-admin-accent/10 text-xs uppercase tracking-wide text-ink-500">
                      <th className="px-3 py-3 font-medium">Camera Name</th>
                      <th className="px-3 py-3 font-medium">Brand</th>
                      <th className="px-3 py-3 font-medium">Camera IP Address</th>
                      <th className="px-3 py-3 font-medium">RTSP URL</th>
                      <th className="px-3 py-3 font-medium">Camera Status</th>
                      <th className="px-3 py-3 font-medium">Last Connected</th>
                      <th className="w-24 px-3 py-3 font-medium text-right">Edit</th>
                      <th className="w-24 px-3 py-3 font-medium text-right">Delete</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cameras.map((cam) => (
                      <tr key={cam.camera_id} className="border-b border-white/5 hover:bg-white/[0.03] transition">
                        <td className="px-3 py-3 font-medium text-ink-100">{cam.camera_name}</td>
                        <td className="px-3 py-3 text-xs text-ink-300">{BRAND_LABELS[cam.brand] || cam.brand}</td>
                        <td className="px-3 py-3 font-mono text-xs text-ink-400">{cam.camera_ip}</td>
                        <td className="px-3 py-3 font-mono text-xs text-ink-400">{cam.rtsp_url}</td>
                        <td className="px-3 py-3">
                          <AdminBadge status={cam.status} />
                        </td>
                        <td className="px-3 py-3 text-xs text-ink-400">{cam.last_connected_time || "Never"}</td>
                        <td className="px-3 py-3 text-right">
                          <button
                            onClick={() => openEdit(cam)}
                            className="inline-flex rounded-md p-2 text-ink-400 hover:bg-white/5 hover:text-admin-accent"
                            title="Edit Camera"
                          >
                            <Pencil size={16} />
                          </button>
                        </td>
                        <td className="px-3 py-3 text-right">
                          <button
                            onClick={() => requestDelete(cam)}
                            className="inline-flex rounded-md p-2 text-ink-400 hover:bg-signal-red/10 hover:text-signal-red"
                            title="Delete Camera"
                          >
                            <Trash2 size={16} />
                          </button>
                        </td>
                      </tr>
                    ))}

                    {cameras.length === 0 && (
                      <tr>
                        <td colSpan={8} className="px-3 py-16 text-center text-ink-500">
                          <div className="flex flex-col items-center gap-2">
                            <VideoOff size={22} />
                            <p>No cameras have been added for this customer yet.</p>
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </AdminCard>

          <AdminCard className="mt-4 p-4 sm:p-5">
            <div className="mb-2 flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-md bg-admin-accent/10 text-admin-accent">
                <BrainCircuit size={19} />
              </span>
              <div>
                <p className="font-display text-sm font-semibold text-white">AI Configuration</p>
                <p className="text-xs text-ink-500">
                  Controls this customer's live face-recognition pipeline. Not visible or editable in the User Portal.
                </p>
              </div>
            </div>

            {aiConfigLoading && (
              <div className="flex flex-col items-center justify-center gap-3 py-16 text-ink-500">
                <Loader2 size={22} className="animate-spin text-admin-accent" />
                <p className="text-xs">Loading AI configuration…</p>
              </div>
            )}

            {!aiConfigLoading && aiConfigError && (
              <div className="flex flex-col items-center justify-center gap-3 py-16 text-center text-ink-500">
                <AlertTriangle size={22} className="text-red-400" />
                <p className="text-xs">{aiConfigError}</p>
              </div>
            )}

            {!aiConfigLoading && !aiConfigError && aiConfig && (
              <div className="mt-2 divide-y divide-white/5">
                {AI_CONFIG_FIELDS.map((field) => (
                  <AdminToggle
                    key={field.key}
                    label={field.label}
                    description={field.description}
                    checked={!!aiConfig[field.key]}
                    disabled={savingKey === field.key}
                    onChange={(value) => handleAiToggle(field.key, value)}
                  />
                ))}
              </div>
            )}
          </AdminCard>
        </>
      )}

      {/* Add Camera */}
      <AdminModal open={addOpen} onClose={() => setAddOpen(false)} title="Add Camera" size="xl">
        <form onSubmit={handleAdd}>
          <div className={cameraFormGridClass}>
            <div>
              <label className="mb-2 block text-xs font-medium text-ink-400">Camera Name</label>
              <input
                type="text"
                required
                minLength={3}
                maxLength={50}
                value={addForm.camera_name}
                onChange={(e) => setAddForm((f) => ({ ...f, camera_name: e.target.value }))}
                onBlur={() => setAddTouched((t) => ({ ...t, camera_name: true }))}
                className={`${inputClass} ${addTouched.camera_name && addErrors.camera_name ? INVALID_INPUT_CLASS : ""}`}
              />
              {addTouched.camera_name && addErrors.camera_name && (
                <p className="mt-1.5 text-xs text-red-400">{addErrors.camera_name}</p>
              )}
            </div>
            <div>
              <label className="mb-2 block text-xs font-medium text-ink-400">Camera Brand</label>
              <AdminSelect
                value={addForm.brand}
                onChange={(value) => updateAddField("brand", value)}
                options={CAMERA_BRANDS}
              />
            </div>

            {addForm.brand === "custom" && (
              <div className="sm:col-span-2">
                <label className="mb-2 block text-xs font-medium text-ink-400">RTSP URL</label>
                <input
                  type="text"
                  required
                  maxLength={500}
                  value={addForm.rtsp_url}
                  onChange={(e) => updateAddField("rtsp_url", e.target.value)}
                  onBlur={() => setAddTouched((t) => ({ ...t, rtsp_url: true }))}
                  placeholder="rtsp://192.168.1.100:554/your/custom/path"
                  className={`${inputClass} ${addTouched.rtsp_url && addErrors.rtsp_url ? INVALID_INPUT_CLASS : ""}`}
                />
                {addTouched.rtsp_url && addErrors.rtsp_url && (
                  <p className="mt-1.5 text-xs text-red-400">{addErrors.rtsp_url}</p>
                )}
              </div>
            )}

            <div>
              <label className="mb-2 block text-xs font-medium text-ink-400">DVR IP / Camera IP</label>
              <input
                type="text"
                required
                value={addForm.camera_ip}
                onChange={(e) => updateAddField("camera_ip", e.target.value)}
                onBlur={() => setAddTouched((t) => ({ ...t, camera_ip: true }))}
                placeholder="e.g. 192.168.1.100"
                className={`${inputClass} ${addTouched.camera_ip && addErrors.camera_ip ? INVALID_INPUT_CLASS : ""}`}
              />
              {addTouched.camera_ip && addErrors.camera_ip && (
                <p className="mt-1.5 text-xs text-red-400">{addErrors.camera_ip}</p>
              )}
            </div>
            <div>
              <label className="mb-2 block text-xs font-medium text-ink-400">Username</label>
              <input
                type="text"
                required
                maxLength={50}
                value={addForm.username}
                onChange={(e) => updateAddField("username", e.target.value)}
                onBlur={() => setAddTouched((t) => ({ ...t, username: true }))}
                className={`${inputClass} ${addTouched.username && addErrors.username ? INVALID_INPUT_CLASS : ""}`}
                autoComplete="off"
              />
              {addTouched.username && addErrors.username && (
                <p className="mt-1.5 text-xs text-red-400">{addErrors.username}</p>
              )}
            </div>

            <div>
              <label className="mb-2 block text-xs font-medium text-ink-400">Password</label>
              <input
                type="password"
                required
                value={addForm.password}
                onChange={(e) => updateAddField("password", e.target.value)}
                onBlur={() => setAddTouched((t) => ({ ...t, password: true }))}
                className={`${inputClass} ${addTouched.password && addErrors.password ? INVALID_INPUT_CLASS : ""}`}
                autoComplete="new-password"
              />
              {addTouched.password && addErrors.password && (
                <p className="mt-1.5 text-xs text-red-400">{addErrors.password}</p>
              )}
            </div>
            <div>
              <label className="mb-2 block text-xs font-medium text-ink-400">Camera Location</label>
              <input
                type="text"
                maxLength={100}
                value={addForm.camera_location}
                onChange={(e) => setAddForm((f) => ({ ...f, camera_location: e.target.value }))}
                onBlur={() => setAddTouched((t) => ({ ...t, camera_location: true }))}
                placeholder="Optional"
                className={`${inputClass} ${addTouched.camera_location && addErrors.camera_location ? INVALID_INPUT_CLASS : ""}`}
              />
              {addTouched.camera_location && addErrors.camera_location && (
                <p className="mt-1.5 text-xs text-red-400">{addErrors.camera_location}</p>
              )}
            </div>

            <AdvancedSettingsSection open={addAdvancedOpen} onToggle={() => setAddAdvancedOpen((v) => !v)}>
              <div>
                <label className="mb-2 block text-xs font-medium text-ink-400">Port</label>
                <input
                  type="number"
                  required
                  min={1}
                  max={65535}
                  value={addForm.port}
                  onChange={(e) => updateAddField("port", e.target.value)}
                  onBlur={() => setAddTouched((t) => ({ ...t, port: true }))}
                  className={`${inputClass} ${addTouched.port && addErrors.port ? INVALID_INPUT_CLASS : ""}`}
                />
                {addTouched.port && addErrors.port ? (
                  <p className="mt-1.5 text-xs text-red-400">{addErrors.port}</p>
                ) : (
                  <p className="mt-1.5 text-xs text-ink-500">Default: 554. Leave unchanged unless your DVR uses a different port.</p>
                )}
              </div>

              <div>
                <label className="mb-2 block text-xs font-medium text-ink-400">Channel Number</label>
                <input
                  type="number"
                  required
                  min={1}
                  max={256}
                  step={1}
                  value={addForm.channel_number}
                  onChange={(e) => updateAddField("channel_number", e.target.value)}
                  onBlur={() => setAddTouched((t) => ({ ...t, channel_number: true }))}
                  className={`${inputClass} ${addTouched.channel_number && addErrors.channel_number ? INVALID_INPUT_CLASS : ""}`}
                />
                {addTouched.channel_number && addErrors.channel_number ? (
                  <p className="mt-1.5 text-xs text-red-400">{addErrors.channel_number}</p>
                ) : (
                  <p className="mt-1.5 text-xs text-ink-500">Default: 1. Change this if Test Camera fails to connect.</p>
                )}
              </div>
            </AdvancedSettingsSection>

            <div className="sm:col-span-2">
              <ConnectionTestPanel
                form={addForm}
                testing={testing}
                testResult={testResult}
                onTest={() => handleTestConnection(addForm)}
                onOpenAdvanced={() => setAddAdvancedOpen(true)}
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/8 pt-6 sm:col-span-2">
              <AdminButton type="button" variant="ghost" onClick={() => setAddOpen(false)} disabled={saving}>
                Cancel
              </AdminButton>
              <div className="flex flex-wrap items-center gap-3">
                {testResult && !testResult.connected && (
                  <AdminButton
                    type="button"
                    variant="secondary"
                    disabled={saving || !isAddFormValid}
                    onClick={(e) => handleAdd(e, true)}
                  >
                    Save Anyway
                  </AdminButton>
                )}
                <AdminButton type="submit" disabled={saving || !testResult?.connected || !isAddFormValid}>
                  {saving ? "Saving…" : "Save"}
                </AdminButton>
              </div>
            </div>
          </div>
        </form>
      </AdminModal>

      {/* Edit Camera */}
      <AdminModal open={!!editTarget} onClose={closeEdit} title="Edit Camera" size="xl">
        <form onSubmit={handleEditSave}>
          <div className={cameraFormGridClass}>
            <div>
              <label className="mb-2 block text-xs font-medium text-ink-400">Camera Name</label>
              <input
                type="text"
                required
                minLength={3}
                maxLength={50}
                value={editForm.camera_name}
                onChange={(e) => setEditForm((f) => ({ ...f, camera_name: e.target.value }))}
                onBlur={() => setEditTouched((t) => ({ ...t, camera_name: true }))}
                className={`${inputClass} ${editTouched.camera_name && editErrors.camera_name ? INVALID_INPUT_CLASS : ""}`}
              />
              {editTouched.camera_name && editErrors.camera_name && (
                <p className="mt-1.5 text-xs text-red-400">{editErrors.camera_name}</p>
              )}
            </div>
            <div>
              <label className="mb-2 block text-xs font-medium text-ink-400">Camera Brand</label>
              <AdminSelect
                value={editForm.brand}
                onChange={(value) => updateEditField("brand", value)}
                options={CAMERA_BRANDS}
              />
            </div>

            {editForm.brand === "custom" && (
              <div className="sm:col-span-2">
                <label className="mb-2 block text-xs font-medium text-ink-400">RTSP URL</label>
                <input
                  type="text"
                  required
                  maxLength={500}
                  value={editForm.rtsp_url}
                  onChange={(e) => updateEditField("rtsp_url", e.target.value)}
                  onBlur={() => setEditTouched((t) => ({ ...t, rtsp_url: true }))}
                  placeholder="rtsp://192.168.1.100:554/your/custom/path"
                  className={`${inputClass} ${editTouched.rtsp_url && editErrors.rtsp_url ? INVALID_INPUT_CLASS : ""}`}
                />
                {editTouched.rtsp_url && editErrors.rtsp_url && (
                  <p className="mt-1.5 text-xs text-red-400">{editErrors.rtsp_url}</p>
                )}
              </div>
            )}

            <div>
              <label className="mb-2 block text-xs font-medium text-ink-400">DVR IP / Camera IP</label>
              <input
                type="text"
                required
                value={editForm.camera_ip}
                onChange={(e) => updateEditField("camera_ip", e.target.value)}
                onBlur={() => setEditTouched((t) => ({ ...t, camera_ip: true }))}
                className={`${inputClass} ${editTouched.camera_ip && editErrors.camera_ip ? INVALID_INPUT_CLASS : ""}`}
              />
              {editTouched.camera_ip && editErrors.camera_ip && (
                <p className="mt-1.5 text-xs text-red-400">{editErrors.camera_ip}</p>
              )}
            </div>
            <div>
              <label className="mb-2 block text-xs font-medium text-ink-400">Username</label>
              <input
                type="text"
                required
                maxLength={50}
                value={editForm.username}
                onChange={(e) => updateEditField("username", e.target.value)}
                onBlur={() => setEditTouched((t) => ({ ...t, username: true }))}
                className={`${inputClass} ${editTouched.username && editErrors.username ? INVALID_INPUT_CLASS : ""}`}
                autoComplete="off"
              />
              {editTouched.username && editErrors.username && (
                <p className="mt-1.5 text-xs text-red-400">{editErrors.username}</p>
              )}
            </div>

            <div>
              <label className="mb-2 block text-xs font-medium text-ink-400">Password</label>
              <input
                type="password"
                placeholder="Leave blank to keep the current password"
                value={editForm.password}
                onChange={(e) => updateEditField("password", e.target.value)}
                onBlur={() => setEditTouched((t) => ({ ...t, password: true }))}
                className={`${inputClass} ${editTouched.password && editErrors.password ? INVALID_INPUT_CLASS : ""}`}
                autoComplete="new-password"
              />
              {editTouched.password && editErrors.password && (
                <p className="mt-1.5 text-xs text-red-400">{editErrors.password}</p>
              )}
            </div>
            <div>
              <label className="mb-2 block text-xs font-medium text-ink-400">Camera Location</label>
              <input
                type="text"
                maxLength={100}
                value={editForm.camera_location}
                onChange={(e) => setEditForm((f) => ({ ...f, camera_location: e.target.value }))}
                onBlur={() => setEditTouched((t) => ({ ...t, camera_location: true }))}
                placeholder="Optional"
                className={`${inputClass} ${editTouched.camera_location && editErrors.camera_location ? INVALID_INPUT_CLASS : ""}`}
              />
              {editTouched.camera_location && editErrors.camera_location && (
                <p className="mt-1.5 text-xs text-red-400">{editErrors.camera_location}</p>
              )}
            </div>

            <AdvancedSettingsSection open={editAdvancedOpen} onToggle={() => setEditAdvancedOpen((v) => !v)}>
              <div>
                <label className="mb-2 block text-xs font-medium text-ink-400">Port</label>
                <input
                  type="number"
                  required
                  min={1}
                  max={65535}
                  value={editForm.port}
                  onChange={(e) => updateEditField("port", e.target.value)}
                  onBlur={() => setEditTouched((t) => ({ ...t, port: true }))}
                  className={`${inputClass} ${editTouched.port && editErrors.port ? INVALID_INPUT_CLASS : ""}`}
                />
                {editTouched.port && editErrors.port ? (
                  <p className="mt-1.5 text-xs text-red-400">{editErrors.port}</p>
                ) : (
                  <p className="mt-1.5 text-xs text-ink-500">Default: 554. Leave unchanged unless your DVR uses a different port.</p>
                )}
              </div>

              <div>
                <label className="mb-2 block text-xs font-medium text-ink-400">Channel Number</label>
                <input
                  type="number"
                  required
                  min={1}
                  max={256}
                  step={1}
                  value={editForm.channel_number}
                  onChange={(e) => updateEditField("channel_number", e.target.value)}
                  onBlur={() => setEditTouched((t) => ({ ...t, channel_number: true }))}
                  className={`${inputClass} ${editTouched.channel_number && editErrors.channel_number ? INVALID_INPUT_CLASS : ""}`}
                />
                {editTouched.channel_number && editErrors.channel_number ? (
                  <p className="mt-1.5 text-xs text-red-400">{editErrors.channel_number}</p>
                ) : (
                  <p className="mt-1.5 text-xs text-ink-500">Default: 1. Change this if Test Camera fails to connect.</p>
                )}
              </div>
            </AdvancedSettingsSection>

            <div className="sm:col-span-2">
              <ConnectionTestPanel
                form={editForm}
                testing={testing}
                testResult={testResult}
                onTest={() => handleTestConnection(editForm, editTarget?.camera_id)}
                onOpenAdvanced={() => setEditAdvancedOpen(true)}
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/8 pt-6 sm:col-span-2">
              <AdminButton type="button" variant="ghost" onClick={closeEdit} disabled={saving}>
                Cancel
              </AdminButton>
              <div className="flex flex-wrap items-center gap-3">
                {testResult && !testResult.connected && (
                  <AdminButton
                    type="button"
                    variant="secondary"
                    disabled={saving || !isEditFormValid}
                    onClick={(e) => handleEditSave(e, true)}
                  >
                    Save Anyway
                  </AdminButton>
                )}
                <AdminButton type="submit" disabled={saving || !testResult?.connected || !isEditFormValid}>
                  {saving ? "Saving…" : "Save Changes"}
                </AdminButton>
              </div>
            </div>
          </div>
        </form>
      </AdminModal>

      {/* Delete Confirmation */}
      <AdminModal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Delete Camera">
        <p className="text-sm text-ink-300">
          Are you sure you want to delete this camera?
          {deleteTarget && (
            <>
              {" "}
              <span className="font-semibold text-white">{deleteTarget.camera_name}</span> will be permanently removed.
            </>
          )}
        </p>
        <div className="flex justify-end gap-3 pt-5">
          <AdminButton type="button" variant="ghost" onClick={() => setDeleteTarget(null)} disabled={deleting}>
            Cancel
          </AdminButton>
          <AdminButton type="button" variant="danger" onClick={handleConfirmDelete} disabled={deleting}>
            {deleting ? "Deleting…" : "Delete"}
          </AdminButton>
        </div>
      </AdminModal>

      <AdminToast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
