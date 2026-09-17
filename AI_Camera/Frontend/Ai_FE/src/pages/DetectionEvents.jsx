import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import axios from "axios";
import { Loader2, AlertTriangle, Radar, Trash2, X } from "lucide-react";
import PageHeader from "../components/ui/PageHeader";
import GlassCard from "../components/ui/GlassCard";
import Button from "../components/ui/Button";
import Modal from "../components/ui/Modal";
import Toast from "../components/ui/Toast";
import UserScopeSelector from "../components/ui/UserScopeSelector";
import { useSelectedUser } from "../context/SelectedUserContext";
import { DATA_EVENTS, emitDataEvent, useDataEvent } from "../lib/dataEvents";
import { usePolling } from "../lib/usePolling";
import { API_BASE_URL } from "../lib/apiBase";

const POLL_MS = 5000;

// The internal Backend event_type -> the ONLY label users ever see.
// The specific COCO class (car/bus/dog/cat/...) is never exposed here.
const TYPE_META = {
  PERSON_DETECTED: { emoji: "👤", label: "PERSON", tone: "text-signal-green bg-signal-green/10" },
  UNKNOWN_FACE: { emoji: "❓", label: "UNKNOWN FACE", tone: "text-signal-red bg-signal-red/10" },
  CAR_DETECTED: { emoji: "🚗", label: "VEHICLE", tone: "text-accent-cyan bg-accent-cyan/10" },
  ANIMAL_DETECTED: { emoji: "🐾", label: "ANIMAL", tone: "text-signal-amber bg-signal-amber/10" },
  BIRD_DETECTED: { emoji: "🐦", label: "BIRD", tone: "text-accent-cyan bg-accent-cyan/10" },
  FIRE_DETECTED: { emoji: "🔥", label: "FIRE", tone: "text-signal-red bg-signal-red/10" },
  SMOKE_DETECTED: { emoji: "💨", label: "SMOKE", tone: "text-ink-300 bg-white/10" },
};

// Filter chips — `param` is the ?type= CSV token sent to the Backend.
const FILTERS = [
  { key: "all", label: "All", param: null, emoji: "🛰️" },
  { key: "person", label: "Person", param: "PERSON_DETECTED", emoji: "👤" },
  { key: "unknown", label: "Unknown Face", param: "UNKNOWN_FACE", emoji: "❓" },
  { key: "vehicle", label: "Vehicle", param: "CAR_DETECTED", emoji: "🚗" },
  { key: "animal", label: "Animal", param: "ANIMAL_DETECTED", emoji: "🐾" },
  { key: "bird", label: "Bird", param: "BIRD_DETECTED", emoji: "🐦" },
  { key: "fire", label: "Fire", param: "FIRE_DETECTED", emoji: "🔥" },
  { key: "smoke", label: "Smoke", param: "SMOKE_DETECTED", emoji: "💨" },
].map((f) => ({ ...f, tone: (TYPE_META[f.param]?.tone) || "text-ink-200 bg-white/5" }));

export default function DetectionEvents() {
  const { selectedUserId } = useSelectedUser();

  // The ?type= query param is the single source of truth for the active
  // filter, so the sidebar's Security & Detection deep-links (Vehicles /
  // Animals-Birds / Fire-Smoke -> /detection-events?type=...) land here
  // pre-filtered, and every filter state is a shareable/bookmarkable URL.
  const [searchParams, setSearchParams] = useSearchParams();
  const urlType = searchParams.get("type") || "";
  const activeFilter = FILTERS.find((f) => f.param === urlType)?.key || (urlType ? "custom" : "all");

  const setActiveFilter = (key) => {
    const param = FILTERS.find((f) => f.key === key)?.param || null;
    setSearchParams(param ? { type: param } : {}, { replace: false });
  };

  const [events, setEvents] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [preview, setPreview] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [clearAllOpen, setClearAllOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [toast, setToast] = useState(null);

  // Raw ?type= value (a single event_type, or a CSV like
  // "ANIMAL_DETECTED,BIRD_DETECTED" from a sidebar deep-link) — passed
  // straight to the Backend, which already accepts a CSV.
  const filterParam = useMemo(() => urlType || null, [urlType]);

  const fetchEvents = useCallback(() => {
    setError(null);

    const params = { limit: 200 };
    if (selectedUserId !== null) params.user_id = selectedUserId;
    if (filterParam) params.type = filterParam;

    return axios
      .get(`${API_BASE_URL}/detection-events`, { params })
      .then((res) => {
        setEvents(res.data.events || []);
        setTotal(res.data.total ?? (res.data.events || []).length);
      })
      .catch((err) => {
        console.error("Detection Events API Error :", err);
        setError("Unable to load detection events. Please check the server and try again.");
      })
      .finally(() => setLoading(false));
  }, [selectedUserId, filterParam]);

  useEffect(() => {
    setLoading(true);
    fetchEvents();
  }, [fetchEvents]);

  useDataEvent([DATA_EVENTS.DETECTION_EVENTS_CHANGED], fetchEvents);
  usePolling(fetchEvents, POLL_MS);

  const handleConfirmDelete = () => {
    if (!deleteTarget) return;
    setDeleting(true);

    axios
      .delete(`${API_BASE_URL}/detection-events/${encodeURIComponent(deleteTarget.event_id)}`)
      .then(() => {
        setToast({ type: "success", message: "Detection event deleted." });
        emitDataEvent(DATA_EVENTS.DETECTION_EVENTS_CHANGED);
        return fetchEvents();
      })
      .catch((err) => {
        setToast({
          type: "error",
          message: err.response?.data?.message || "Failed to delete detection event.",
        });
      })
      .finally(() => {
        setDeleting(false);
        setDeleteTarget(null);
      });
  };

  const handleConfirmClearAll = () => {
    setClearing(true);

    axios
      .delete(`${API_BASE_URL}/detection-events`)
      .then(() => {
        setToast({ type: "success", message: "All detection events cleared." });
        setClearAllOpen(false);
        emitDataEvent(DATA_EVENTS.DETECTION_EVENTS_CHANGED);
        return fetchEvents();
      })
      .catch((err) => {
        setToast({
          type: "error",
          message: err.response?.data?.message || "Failed to clear detection events.",
        });
      })
      .finally(() => setClearing(false));
  };

  return (
    <div>
      <PageHeader
        eyebrow="AI Detection"
        title="Detection Events"
        description="Every person, vehicle, animal, bird, and fire/smoke detection captured across your cameras."
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <UserScopeSelector />
            <Button
              type="button"
              variant="danger"
              icon={Trash2}
              onClick={() => setClearAllOpen(true)}
              disabled={events.every((e) => !String(e.event_id).startsWith("evt-"))}
            >
              Clear Recorded
            </Button>
          </div>
        }
      />

      <div className="mb-5 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setActiveFilter(f.key)}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
              activeFilter === f.key ? f.tone + " ring-1 ring-white/20" : "text-ink-400 hover:bg-white/[0.04]"
            }`}
          >
            <span>{f.emoji}</span>
            {f.label}
          </button>
        ))}
      </div>

      <p className="mb-4 font-mono text-xs text-ink-500">
        {loading ? "Loading…" : `${events.length} of ${total} events`}
      </p>

      {loading && (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-ink-500">
          <Loader2 size={22} className="animate-spin" />
          <p className="text-xs">Loading detection events…</p>
        </div>
      )}

      {!loading && error && (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-center text-ink-500">
          <AlertTriangle size={22} className="text-red-400" />
          <p className="text-xs">{error}</p>
        </div>
      )}

      {!loading && !error && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {events.map((e) => {
            const meta = TYPE_META[e.event_type] || { emoji: "🛰️", label: e.event_type, tone: "text-ink-200 bg-white/5" };
            const deletable = String(e.event_id).startsWith("evt-");
            return (
              <GlassCard key={e.event_id} className="overflow-hidden">
                {e.image_url ? (
                  <button
                    type="button"
                    onClick={() => setPreview(e)}
                    className="relative block aspect-video w-full bg-base-950"
                  >
                    <img src={e.image_url} alt={meta.label} className="h-full w-full object-contain" />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
                  </button>
                ) : (
                  <div className="flex aspect-video items-center justify-center bg-base-950 text-4xl">
                    {meta.emoji}
                  </div>
                )}

                <div className="space-y-1.5 p-4">
                  <div className="flex items-center justify-between">
                    <span className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium ${meta.tone}`}>
                      <span>{meta.emoji}</span>
                      {meta.label}
                    </span>
                    {deletable && (
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(e)}
                        className="rounded-md p-1.5 text-ink-500 hover:bg-signal-red/10 hover:text-signal-red"
                        title="Delete event"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>

                  {/* Only a registered person's name is shown by name.
                      Vehicle/animal/bird events show the generic category
                      (the badge above) — never the specific COCO class. */}
                  {e.person_name && (
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-ink-500">Name</span>
                      <span className="font-mono text-ink-200">{e.person_name}</span>
                    </div>
                  )}
                  {e.confidence != null && (
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-ink-500">Confidence</span>
                      <span className="font-mono text-signal-amber">{Math.round(e.confidence * 100)}%</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-ink-500">Camera</span>
                    <span className="font-mono text-ink-200">{e.camera_name || "Unassigned"}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-ink-500">Date</span>
                    <span className="font-mono text-ink-200">{e.date || "—"}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-ink-500">Time</span>
                    <span className="font-mono text-ink-200">{e.time || "—"}</span>
                  </div>
                  {e.detection_count > 1 && (
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-ink-500">Detections</span>
                      <span className="font-mono text-signal-amber">Seen {e.detection_count} times</span>
                    </div>
                  )}
                </div>
              </GlassCard>
            );
          })}

          {events.length === 0 && (
            <div className="col-span-full flex flex-col items-center gap-2 py-16 text-center text-ink-500">
              <Radar size={22} />
              <p>No detection events yet.</p>
            </div>
          )}
        </div>
      )}

      <Modal open={!!preview} onClose={() => setPreview(null)} title="Detection Snapshot">
        {preview?.image_url && (
          <div className="relative">
            <img src={preview.image_url} alt="Detection snapshot" className="max-h-[70vh] w-full rounded-lg object-contain" />
            <button
              type="button"
              onClick={() => setPreview(null)}
              className="absolute right-2 top-2 rounded-lg bg-black/50 p-1.5 text-white hover:bg-black/70"
            >
              <X size={16} />
            </button>
          </div>
        )}
      </Modal>

      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Delete Detection Event">
        <p className="text-sm text-ink-300">
          Remove this detection event permanently? Any saved snapshot image is deleted too. This cannot be undone.
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

      <Modal open={clearAllOpen} onClose={() => setClearAllOpen(false)} title="Clear Recorded Events">
        <p className="text-sm text-ink-300">
          This deletes every recorded vehicle, animal, bird, fire, and smoke event (and their snapshots). Person and
          unknown-face entries are shown from Attendance / Unknown Persons and are not affected. This cannot be undone.
        </p>
        <div className="flex justify-end gap-3 pt-5">
          <Button type="button" variant="ghost" onClick={() => setClearAllOpen(false)} disabled={clearing}>
            Cancel
          </Button>
          <Button type="button" variant="danger" onClick={handleConfirmClearAll} disabled={clearing}>
            {clearing ? "Clearing…" : "Clear Recorded"}
          </Button>
        </div>
      </Modal>

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
