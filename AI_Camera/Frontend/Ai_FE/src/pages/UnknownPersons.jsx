import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { ScanFace, Loader2, AlertTriangle, Users, Trash2 } from "lucide-react";
import PageHeader from "../components/ui/PageHeader";
import SearchInput from "../components/ui/SearchInput";
import GlassCard from "../components/ui/GlassCard";
import StatusBadge from "../components/ui/StatusBadge";
import Button from "../components/ui/Button";
import Modal from "../components/ui/Modal";
import Toast from "../components/ui/Toast";
import UserScopeSelector from "../components/ui/UserScopeSelector";
import { useSelectedUser } from "../context/SelectedUserContext";
import { DATA_EVENTS, emitDataEvent } from "../lib/dataEvents";

export default function UnknownPersons() {
  const { selectedUserId } = useSelectedUser();
  const [query, setQuery] = useState("");

  const [persons, setPersons] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);

  const [toast, setToast] = useState(null);

  const fetchUnknownPersons = () => {
    setLoading(true);
    setError(null);

    return axios
      .get("http://localhost:5000/unknown-persons", {
        params: selectedUserId !== null ? { user_id: selectedUserId } : undefined,
      })
      .then((res) => {
        setPersons(res.data.persons || []);
        setTotal(res.data.total ?? (res.data.persons || []).length);
      })
      .catch((err) => {
        console.error("Unknown Persons API Error :", err);
        setError("Unable to load unknown persons. Please check the server and try again.");
      })
      .finally(() => {
        setLoading(false);
      });
  };

  useEffect(() => {
    fetchUnknownPersons();
  }, [selectedUserId]);

  const filtered = useMemo(
    () =>
      persons.filter((p) =>
        String(p.id).toLowerCase().includes(query.toLowerCase())
      ),
    [persons, query]
  );

  // Selections are cleared whenever the underlying list changes (search,
  // refetch after a delete) so a checkbox can never stay "checked" for a
  // row that's no longer visible or no longer exists.
  useEffect(() => {
    setSelectedIds((prev) => {
      const visibleIds = new Set(filtered.map((p) => p.id));
      const next = new Set([...prev].filter((id) => visibleIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [filtered]);

  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const allSelected = filtered.length > 0 && filtered.every((p) => selectedIds.has(p.id));

  const toggleSelectAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(filtered.map((p) => p.id)));
  };

  const handleConfirmDelete = () => {
    if (!deleteTarget) return;

    setDeleting(true);

    axios
      .delete(`http://localhost:5000/unknown/${encodeURIComponent(deleteTarget.id)}`)
      .then(() => {
        setToast({ type: "success", message: `${deleteTarget.id} deleted successfully.` });
        emitDataEvent(DATA_EVENTS.UNKNOWN_PERSONS_CHANGED);
        return fetchUnknownPersons();
      })
      .catch((err) => {
        console.error("Delete Unknown Person API Error :", err);
        setToast({ type: "error", message: `Failed to delete ${deleteTarget.id}.` });
      })
      .finally(() => {
        setDeleting(false);
        setDeleteTarget(null);
      });
  };

  const handleConfirmBulkDelete = () => {
    const ids = Array.from(selectedIds);

    if (ids.length === 0) return;

    setBulkDeleting(true);

    axios
      .post("http://localhost:5000/unknown-persons/bulk-delete", { ids })
      .then(() => {
        setToast({ type: "success", message: `${ids.length} unknown person(s) deleted successfully.` });
        setSelectedIds(new Set());
        setBulkDeleteOpen(false);
        emitDataEvent(DATA_EVENTS.UNKNOWN_PERSONS_CHANGED);
        return fetchUnknownPersons();
      })
      .catch((err) => {
        console.error("Bulk Delete Unknown Persons API Error :", err);
        setToast({ type: "error", message: "Failed to delete the selected unknown persons." });
      })
      .finally(() => setBulkDeleting(false));
  };

  const handleConfirmDeleteAll = () => {
    setDeletingAll(true);

    axios
      .delete("http://localhost:5000/unknown-persons")
      .then(() => {
        setToast({ type: "success", message: "All unknown persons deleted successfully." });
        setSelectedIds(new Set());
        setDeleteAllOpen(false);
        emitDataEvent(DATA_EVENTS.UNKNOWN_PERSONS_CHANGED);
        return fetchUnknownPersons();
      })
      .catch((err) => {
        console.error("Delete All Unknown Persons API Error :", err);
        setToast({ type: "error", message: "Failed to delete all unknown persons." });
      })
      .finally(() => setDeletingAll(false));
  };

  return (
    <div>
      <PageHeader
        eyebrow="AI Detection"
        title="Unknown Persons"
        description="Faces detected that do not match any registered identity."
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <UserScopeSelector />
            <SearchInput value={query} onChange={setQuery} placeholder="Search by Unknown ID…" className="max-w-sm" />
            <Button
              type="button"
              variant="danger"
              icon={Trash2}
              onClick={() => setDeleteAllOpen(true)}
              disabled={persons.length === 0}
            >
              Delete All
            </Button>
          </div>
        }
      />

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-400 select-none">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleSelectAll}
              disabled={filtered.length === 0}
              className="h-4 w-4 rounded border-white/20 bg-transparent accent-accent-cyan"
            />
            Select All
          </label>
          <p className="font-mono text-xs text-ink-500">
            {loading ? "Loading…" : `${filtered.length} of ${total} unknown persons`}
          </p>
        </div>

        {selectedIds.size > 0 && (
          <div className="flex items-center gap-3 rounded-xl glass px-3.5 py-2">
            <span className="font-mono text-xs text-ink-200">{selectedIds.size} selected</span>
            <Button
              type="button"
              variant="danger"
              icon={Trash2}
              className="!px-3 !py-1.5 text-xs"
              onClick={() => setBulkDeleteOpen(true)}
            >
              Delete Selected
            </Button>
          </div>
        )}
      </div>

      {loading && (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-ink-500">
          <Loader2 size={22} className="animate-spin" />
          <p className="text-xs">Loading unknown persons…</p>
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
          {filtered.map((p) => (
            <GlassCard key={p.id} className="viewfinder overflow-hidden">
              {/* aspect-video (not aspect-square) + object-contain (not
                  object-cover) — the saved evidence image is the
                  complete camera frame (see Backend/face/unknown_manager.py's
                  save_unknown), so it must never be visually cropped to
                  fill the card; object-contain always shows the whole
                  frame, letterboxed against bg-base-950 when its aspect
                  ratio (4:3 at 480p, 16:9 at 720p/1080p) doesn't
                  perfectly match the card. */}
              <div className="relative aspect-video bg-base-950">
                <img src={p.frame_image} alt="Full camera frame" className="h-full w-full object-contain" />
                <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />

                <div className="absolute left-3 top-3 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(p.id)}
                    onChange={() => toggleSelect(p.id)}
                    aria-label={`Select ${p.id}`}
                    className="h-4 w-4 rounded border-white/40 bg-black/40 accent-accent-cyan backdrop-blur-sm"
                  />
                  <div className="flex items-center gap-1.5 rounded-md bg-signal-red/20 px-2 py-1 backdrop-blur-sm">
                    <ScanFace size={12} className="text-signal-red" />
                    <span className="font-mono text-[10px] uppercase tracking-wide text-signal-red">Unidentified</span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setDeleteTarget(p)}
                  aria-label={`Delete ${p.id}`}
                  className="absolute right-3 bottom-[4.5rem] rounded-lg bg-black/40 p-1.5 text-ink-200 backdrop-blur-sm hover:bg-signal-red/20 hover:text-signal-red"
                >
                  <Trash2 size={14} />
                </button>

                <div className="absolute right-3 top-3 h-14 w-14 overflow-hidden rounded-lg ring-2 ring-white/30 shadow-lg">
                  <img src={p.face_image} alt="Face crop" className="h-full w-full object-cover" />
                </div>

                <div className="absolute bottom-3 left-3 right-3 flex items-center gap-1.5 text-[11px] text-ink-200">
                  <span className="font-mono">{p.id}</span>
                </div>
              </div>
              <div className="space-y-1.5 p-4">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-ink-500">First Seen</span>
                  <span className="font-mono text-ink-200">{p.first_seen}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-ink-500">Last Seen</span>
                  <span className="font-mono text-ink-200">{p.last_seen}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-ink-500">Detections</span>
                  <span className="font-mono text-signal-amber">Detected {p.detection_count} Times</span>
                </div>
                <div className="mt-3 flex items-center justify-center">
                  <StatusBadge status={p.status} />
                </div>
              </div>
            </GlassCard>
          ))}

          {persons.length === 0 && (
            <div className="col-span-full flex flex-col items-center gap-2 py-16 text-center text-ink-500">
              <Users size={22} />
              <p>No unknown persons detected yet.</p>
            </div>
          )}

          {persons.length > 0 && filtered.length === 0 && (
            <div className="col-span-full py-16 text-center text-ink-500">
              No unknown persons match “{query}”.
            </div>
          )}
        </div>
      )}

      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Delete Unknown Person">
        <p className="text-sm text-ink-300">
          Are you sure you want to delete{" "}
          <span className="font-semibold text-white">{deleteTarget?.id}</span>? This will remove the face
          image, frame image, and embedding permanently. This action cannot be undone.
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

      <Modal open={bulkDeleteOpen} onClose={() => setBulkDeleteOpen(false)} title="Delete Selected">
        <p className="text-sm text-ink-300">
          Are you sure you want to delete{" "}
          <span className="font-semibold text-white">{selectedIds.size}</span> selected unknown person
          {selectedIds.size === 1 ? "" : "s"}? This will remove their face images, frame images, and embeddings
          permanently. This action cannot be undone.
        </p>
        <div className="flex justify-end gap-3 pt-5">
          <Button type="button" variant="ghost" onClick={() => setBulkDeleteOpen(false)} disabled={bulkDeleting}>
            Cancel
          </Button>
          <Button type="button" variant="danger" onClick={handleConfirmBulkDelete} disabled={bulkDeleting}>
            {bulkDeleting ? "Deleting…" : "Delete Selected"}
          </Button>
        </div>
      </Modal>

      <Modal open={deleteAllOpen} onClose={() => setDeleteAllOpen(false)} title="Delete All Unknown Persons">
        <p className="text-sm text-ink-300">
          Are you sure you want to delete all Unknown Persons? This action cannot be undone.
        </p>
        <div className="flex justify-end gap-3 pt-5">
          <Button type="button" variant="ghost" onClick={() => setDeleteAllOpen(false)} disabled={deletingAll}>
            Cancel
          </Button>
          <Button type="button" variant="danger" onClick={handleConfirmDeleteAll} disabled={deletingAll}>
            {deletingAll ? "Deleting…" : "Delete All"}
          </Button>
        </div>
      </Modal>

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
