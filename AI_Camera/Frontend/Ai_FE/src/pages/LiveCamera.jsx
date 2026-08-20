import { useCallback, useEffect, useRef, useState } from "react";
import axios from "axios";
import { Camera, CameraOff, WifiOff, Monitor, VideoOff } from "lucide-react";
import PageHeader from "../components/ui/PageHeader";
import GlassCard from "../components/ui/GlassCard";
import Button from "../components/ui/Button";
import StatusBadge from "../components/ui/StatusBadge";
import UserScopeSelector from "../components/ui/UserScopeSelector";
import { useSelectedUser } from "../context/SelectedUserContext";
import { DATA_EVENTS, useDataEvent } from "../lib/dataEvents";
import { usePolling } from "../lib/usePolling";

const CAMERAS_URL = "http://localhost:5000/account/cameras";
const LOCAL_START_URL = "http://localhost:5000/live-camera/local/start";
const LOCAL_STOP_URL = "http://localhost:5000/live-camera/local/stop";
const LOCAL_STATUS_URL = "http://localhost:5000/live-camera/local/status";
const LOCAL_STREAM_URL = "http://localhost:5000/live-camera/local/stream";
const STATUS_POLL_MS = 3000;

const cameraStatusUrl = (cameraId) => `http://localhost:5000/live-camera/status/${cameraId}`;
const cameraStreamUrl = (cameraId) => `http://localhost:5000/live-camera/stream/${cameraId}`;

// One video tile — used for every configured camera AND for the opt-in
// local test camera. Each instance polls its own status URL independently,
// so one camera going offline never affects any other camera's tile.
//
// `active` (default true, only ever false for the local webcam tile) is
// the ON/OFF toggle's state — while false, this stops polling entirely
// (there's nothing to poll: the backend worker isn't running) and shows
// a distinct "Webcam Off" placeholder instead of the red "Offline"
// state, which is reserved for a source that's supposed to be running
// but isn't reachable.
function VideoTile({ title, subtitle, statusUrl, streamUrl, active = true }) {
  const [status, setStatus] = useState({ online: false, fps: 0 });

  // Guards against a still-in-flight response from a PREVIOUS statusUrl/
  // active setting (or from just before unmount) landing after this tile
  // has moved on — same "cancelled" guard the old plain useEffect+
  // setInterval version had, now scoped via a ref so the polling
  // callback below (shared with usePolling) can check it too.
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;

    if (!active) {
      setStatus({ online: false, fps: 0 });
    }

    return () => {
      cancelledRef.current = true;
    };
  }, [statusUrl, active]);

  const poll = useCallback(() => {
    axios
      .get(statusUrl)
      .then((res) => {
        if (!cancelledRef.current) setStatus(res.data);
      })
      .catch(() => {
        if (!cancelledRef.current) setStatus({ online: false, fps: 0 });
      });
  }, [statusUrl]);

  // Fire once immediately (same as the old poll() called right inside
  // the effect) whenever this tile becomes active or points at a new
  // camera, instead of waiting a full STATUS_POLL_MS for the first
  // paint.
  useEffect(() => {
    if (active) poll();
  }, [poll, active]);

  // --- CPU/network fix: pause polling while the tab/page is hidden ---
  // Previously a raw setInterval(poll, STATUS_POLL_MS) with no tab-
  // visibility awareness — one call to the backend every 3s per rendered
  // camera tile, forever, even while the Live Camera tab was backgrounded
  // or minimized. usePolling (the same visibility-aware hook already
  // used by Sidebar/Dashboard/etc.) skips ticks while document.hidden is
  // true and fires once immediately on refocus, and `enabled: active`
  // stops it entirely while this tile is off (matches the previous
  // early-return behavior for an inactive tile).
  usePolling(poll, STATUS_POLL_MS, { enabled: active });

  const showStream = active && status.online;

  return (
    <GlassCard className="viewfinder overflow-hidden">
      <div className="scanline-overlay relative flex aspect-video items-center justify-center bg-gradient-to-br from-base-800 to-base-900">
        {showStream ? (
          <img src={streamUrl} alt={`${title} live stream`} className="h-full w-full object-cover" />
        ) : !active ? (
          <div className="flex flex-col items-center gap-2 px-4 text-center">
            <VideoOff size={28} className="text-ink-500/60" strokeWidth={1.5} />
            <p className="text-xs font-medium text-ink-400">Webcam Off</p>
            <p className="text-[11px] text-ink-500">Turn the toggle on to start capturing.</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 px-4 text-center">
            <WifiOff size={28} className="text-signal-red/60" strokeWidth={1.5} />
            <p className="text-xs font-medium text-signal-red">Camera Offline</p>
            <p className="text-[11px] text-ink-500">Unable to connect to the configured camera.</p>
          </div>
        )}

        <div className="absolute left-3 top-3 flex items-center gap-1.5 rounded-md bg-black/50 px-2 py-1 backdrop-blur-sm">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              showStream ? "pulse-dot bg-signal-green" : active ? "bg-signal-red" : "bg-white/30"
            }`}
          />
          <span className="font-mono text-[10px] uppercase tracking-wide text-ink-100">
            {showStream ? "LIVE" : active ? "OFFLINE" : "OFF"}
          </span>
        </div>

        {showStream && (
          <div className="absolute right-3 top-3 rounded-md bg-black/50 px-2 py-1 backdrop-blur-sm">
            <span className="font-mono text-[10px] text-signal-green">{status.fps} FPS</span>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Camera size={14} className="shrink-0 text-ink-500" />
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-ink-200">{title}</p>
            {subtitle && <p className="truncate text-[10px] text-ink-500">{subtitle}</p>}
          </div>
        </div>
        <p
          className={`shrink-0 font-mono text-[10px] ${
            showStream ? "text-signal-green" : active ? "text-signal-red" : "text-ink-500"
          }`}
        >
          {showStream ? "ONLINE" : active ? "OFFLINE" : "OFF"}
        </p>
      </div>
    </GlassCard>
  );
}

export default function LiveCamera() {
  // Read-only — cameras themselves are managed exclusively by the Super
  // Admin under Customer Details. This just loads and displays whatever
  // is assigned to the signed-in customer, streamed from each camera's
  // own configured RTSP source — never a local webcam.
  const { selectedUserId } = useSelectedUser();
  const [cameras, setCameras] = useState([]);
  const [camerasLoaded, setCamerasLoaded] = useState(false);

  // Local webcam test — off unless explicitly requested by clicking "Use
  // Local Camera". Never opened automatically, never a fallback for a
  // configured camera that's offline. `localTestOpen` is whether the
  // tile is on the page at all; `webcamOn` is the ON/OFF toggle's state
  // (start/stop the actual capture) — the toggle only ever calls
  // start/stop; it never touches detection/recognition logic, which
  // lives entirely in the shared backend pipeline both this and every
  // RTSP camera call into.
  const [localTestOpen, setLocalTestOpen] = useState(false);
  const [webcamOn, setWebcamOn] = useState(false);
  const webcamOnRef = useRef(false);

  useEffect(() => {
    webcamOnRef.current = webcamOn;
  }, [webcamOn]);

  // Release the webcam if the user navigates away while it's still on —
  // "OFF" (including leaving the page) must actually stop capture and
  // free the hardware device, not just stop showing it.
  useEffect(() => {
    return () => {
      if (webcamOnRef.current) {
        axios.post(LOCAL_STOP_URL).catch(() => {});
      }
    };
  }, []);

  const startLocalWebcam = () => {
    axios
      .post(LOCAL_START_URL)
      .then(() => setWebcamOn(true))
      .catch((err) => {
        console.error("Local Camera start error :", err);
        setWebcamOn(false);
      });
  };

  const stopLocalWebcam = () => {
    setWebcamOn(false); // hide the stream immediately, don't wait on the network round trip
    axios.post(LOCAL_STOP_URL).catch((err) => {
      console.error("Local Camera stop error :", err);
    });
  };

  const handleUseLocalCamera = () => {
    setLocalTestOpen(true);
    startLocalWebcam(); // ON: start webcam immediately
  };

  const handleHideLocalCamera = () => {
    stopLocalWebcam();
    setLocalTestOpen(false);
  };

  const fetchAssignedCameras = () => {
    axios
      .get(CAMERAS_URL, { params: selectedUserId !== null ? { user_id: selectedUserId } : undefined })
      .then((res) => setCameras(res.data.cameras || []))
      .catch((err) => {
        console.error("Assigned Cameras API Error :", err);
      })
      .finally(() => setCamerasLoaded(true));
  };

  useEffect(fetchAssignedCameras, [selectedUserId]);

  // Cameras themselves are only ever managed from the Super Admin
  // Portal, but this keeps the page correct the instant any in-session
  // source of this event exists, without polling.
  useDataEvent(DATA_EVENTS.CAMERAS_CHANGED, fetchAssignedCameras);

  const hasCameras = camerasLoaded && cameras.length > 0;
  const showEmptyState = camerasLoaded && cameras.length === 0 && !localTestOpen;

  return (
    <div>
      <PageHeader
        eyebrow="Live Monitoring"
        title="Live Camera"
        description="Live feed from your configured camera(s), processed by the existing detection and recognition pipeline."
        actions={
          <div className="flex flex-wrap items-center justify-end gap-3">
            <UserScopeSelector />
            {localTestOpen && (
              <button
                type="button"
                role="switch"
                aria-checked={webcamOn}
                onClick={() => (webcamOn ? stopLocalWebcam() : startLocalWebcam())}
                title={webcamOn ? "Turn local webcam off" : "Turn local webcam on"}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-300 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/60 focus-visible:ring-offset-2 focus-visible:ring-offset-base-950 ${
                  webcamOn ? "bg-signal-green" : "bg-white/15"
                }`}
              >
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition-transform duration-300 ease-in-out ${
                    webcamOn ? "translate-x-[22px]" : "translate-x-0.5"
                  }`}
                />
              </button>
            )}
            <Button
              variant="secondary"
              icon={localTestOpen ? VideoOff : Monitor}
              onClick={localTestOpen ? handleHideLocalCamera : handleUseLocalCamera}
            >
              {localTestOpen ? "Hide Local Camera" : "Use Local Camera"}
            </Button>
          </div>
        }
      />

      {!camerasLoaded && <p className="py-10 text-center text-xs text-ink-500">Loading assigned cameras…</p>}

      {showEmptyState && (
        <GlassCard className="mx-auto max-w-md p-8 text-center">
          <div className="flex flex-col items-center gap-3">
            <CameraOff size={32} className="text-ink-500" strokeWidth={1.5} />
            <p className="font-display text-base font-semibold text-white">No Camera Configured</p>
            <p className="text-xs text-ink-500">
              No camera has been assigned to your account yet. Cameras are added by your administrator in Camera
              Management.
            </p>
            <Button icon={Monitor} onClick={handleUseLocalCamera} className="mt-2">
              Use Local Camera
            </Button>
          </div>
        </GlassCard>
      )}

      {camerasLoaded && (hasCameras || localTestOpen) && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {cameras.map((cam) => (
            <VideoTile
              key={cam.camera_id}
              title={cam.camera_name}
              subtitle={cam.camera_location || undefined}
              statusUrl={cameraStatusUrl(cam.camera_id)}
              streamUrl={cameraStreamUrl(cam.camera_id)}
            />
          ))}

          {localTestOpen && (
            <VideoTile
              title="Local Camera"
              subtitle={webcamOn ? "Debug mode — same AI pipeline as RTSP cameras" : "Test only — not a configured camera"}
              statusUrl={LOCAL_STATUS_URL}
              streamUrl={LOCAL_STREAM_URL}
              active={webcamOn}
            />
          )}
        </div>
      )}

      <GlassCard className="mt-4 max-w-3xl p-4 sm:p-5">
        <p className="mb-4 font-display text-sm font-semibold text-white">Assigned Cameras</p>

        {!camerasLoaded && <p className="py-6 text-center text-xs text-ink-500">Loading assigned cameras…</p>}

        {camerasLoaded && cameras.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-6 text-ink-500">
            <VideoOff size={20} />
            <p className="text-xs">No cameras have been assigned to your account yet.</p>
          </div>
        )}

        {camerasLoaded && cameras.length > 0 && (
          <div className="custom-scroll overflow-x-auto">
            <table className="w-full min-w-[520px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-white/8 text-xs uppercase tracking-wide text-ink-500">
                  <th className="px-3 py-2.5 font-medium">Camera Name</th>
                  <th className="px-3 py-2.5 font-medium">Location</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {cameras.map((cam) => (
                  <tr key={cam.camera_id} className="border-b border-white/5">
                    <td className="px-3 py-2.5 font-medium text-ink-100">{cam.camera_name}</td>
                    <td className="px-3 py-2.5 text-xs text-ink-400">{cam.camera_location || "—"}</td>
                    <td className="px-3 py-2.5">
                      <StatusBadge status={cam.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </GlassCard>
    </div>
  );
}
