import { useState } from "react";
import axios from "axios";
import { LogIn, ScanFace, History, Trash2, Car, PawPrint, Bird, Flame, Cloud } from "lucide-react";
import GlassCard from "./ui/GlassCard";
import Button from "./ui/Button";
import Modal from "./ui/Modal";
import Toast from "./ui/Toast";
import { API_BASE_URL } from "../lib/apiBase";

// Only real, backend-sourced event types (see Backend/api/dashboard.py
// get_recent_activity). No "check-out"/"alert"/camera-status entries —
// there is no genuine signal behind those yet, so they don't appear here.
const iconMap = {
  "person-entered": { icon: LogIn, tone: "text-signal-green bg-signal-green/10" },
  "unknown-detected": { icon: ScanFace, tone: "text-signal-red bg-signal-red/10" },
  // Multi-Object & Fire Detection — same backend feed
  // (Backend/api/dashboard.py get_recent_activity), new event types.
  "vehicle-detected": { icon: Car, tone: "text-accent-cyan bg-accent-cyan/10" },
  "animal-detected": { icon: PawPrint, tone: "text-signal-amber bg-signal-amber/10" },
  "bird-detected": { icon: Bird, tone: "text-accent-cyan bg-accent-cyan/10" },
  "fire-detected": { icon: Flame, tone: "text-signal-red bg-signal-red/10" },
  "smoke-detected": { icon: Cloud, tone: "text-ink-300 bg-white/10" },
};

export default function RecentActivity({ items, onChanged }) {
  const [toast, setToast] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [clearAllOpen, setClearAllOpen] = useState(false);
  const [clearing, setClearing] = useState(false);

  const handleConfirmDelete = () => {
    if (!deleteTarget) return;

    setDeleting(true);

    axios
      .delete(`${API_BASE_URL}/dashboard/activity/${deleteTarget.id}`)
      .then(() => {
        setDeleteTarget(null);
        onChanged?.();
      })
      .catch((err) => {
        setToast({ type: "error", message: err.response?.data?.message || "Failed to delete activity." });
      })
      .finally(() => setDeleting(false));
  };

  const handleConfirmClearAll = () => {
    setClearing(true);

    axios
      .delete(`${API_BASE_URL}/dashboard/activity`)
      .then(() => {
        setClearAllOpen(false);
        onChanged?.();
      })
      .catch((err) => {
        setToast({ type: "error", message: err.response?.data?.message || "Failed to clear activity." });
      })
      .finally(() => setClearing(false));
  };

  return (
    <GlassCard className="p-5">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="font-display text-sm font-semibold text-white">Recent Activity</h3>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-500">Live feed</span>
          {items.length > 0 && (
            <Button
              variant="ghost"
              icon={Trash2}
              className="!px-2.5 !py-1.5 text-[11px]"
              onClick={() => setClearAllOpen(true)}
            >
              Clear All
            </Button>
          )}
        </div>
      </div>

      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-12 text-ink-500">
          <History size={22} />
          <p className="text-xs">No activity has been recorded yet.</p>
        </div>
      ) : (
        <ul className="custom-scroll max-h-80 space-y-1 overflow-y-auto pr-1">
          {items.map((item) => {
            const { icon: Icon, tone } = iconMap[item.type] || iconMap["person-entered"];
            return (
              <li
                key={item.id}
                className="group flex items-start gap-3 rounded-xl px-2 py-2.5 hover:bg-white/[0.03] transition"
              >
                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${tone}`}>
                  <Icon size={14} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-ink-100">{item.name}</p>
                  <p className="truncate text-xs text-ink-500">{item.detail}</p>
                </div>
                <span className="shrink-0 font-mono text-[11px] text-ink-500">{item.time}</span>
                <button
                  type="button"
                  onClick={() => setDeleteTarget(item)}
                  className="shrink-0 rounded-md p-1.5 text-ink-500 opacity-0 transition hover:bg-signal-red/10 hover:text-signal-red group-hover:opacity-100"
                  title="Delete activity"
                >
                  <Trash2 size={13} />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Delete Activity?">
        <p className="text-sm text-ink-300">
          Are you sure you want to remove this activity from the feed? This only hides the activity entry —
          attendance and unknown person records are not affected.
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

      <Modal open={clearAllOpen} onClose={() => setClearAllOpen(false)} title="Clear All Activity">
        <p className="text-sm text-ink-300">
          Are you sure you want to clear the entire activity feed? This only hides these entries — attendance and
          unknown person records are not affected.
        </p>
        <div className="flex justify-end gap-3 pt-5">
          <Button type="button" variant="ghost" onClick={() => setClearAllOpen(false)} disabled={clearing}>
            Cancel
          </Button>
          <Button type="button" variant="danger" onClick={handleConfirmClearAll} disabled={clearing}>
            {clearing ? "Clearing…" : "Clear All"}
          </Button>
        </div>
      </Modal>

      <Toast toast={toast} onClose={() => setToast(null)} />
    </GlassCard>
  );
}
