import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { RefreshCw, Loader2, AlertTriangle, ScrollText, Trash2 } from "lucide-react";
import AdminPageHeader from "../ui/AdminPageHeader";
import AdminSearchInput from "../ui/AdminSearchInput";
import AdminCard from "../ui/AdminCard";
import AdminButton from "../ui/AdminButton";
import AdminModal from "../ui/AdminModal";
import AdminToast from "../ui/AdminToast";
import { DATA_EVENTS, emitDataEvent } from "../../lib/dataEvents";

const actionTone = {
  Login: "text-signal-green",
  Logout: "text-ink-400",
  "Customer Created": "text-admin-accent",
  "Customer Updated": "text-admin-accent",
  "Customer Deleted": "text-signal-red",
  "Customer Enabled": "text-signal-green",
  "Customer Disabled": "text-signal-amber",
  "Customer Password Changed": "text-admin-gold",
  "Customer Permissions Updated": "text-admin-accent",
  "Super Admin Username Changed": "text-admin-gold",
  "Super Admin Password Changed": "text-admin-gold",
  "Super Admin Profile Updated": "text-admin-accent",
  "User Profile Updated": "text-admin-accent",
  "User Password Changed": "text-admin-gold",
};

export default function AdminActivityLogs() {
  const [query, setQuery] = useState("");
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);

  const fetchLogs = () => {
    setLoading(true);
    setError(null);

    return axios
      .get("http://localhost:5000/activity-logs")
      .then((res) => setLogs(res.data.logs || []))
      .catch((err) => {
        console.error("Activity Logs API Error :", err);
        setError("Unable to load activity logs.");
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchLogs();
  }, []);

  const filtered = useMemo(
    () =>
      logs.filter(
        (l) =>
          l.user_name.toLowerCase().includes(query.toLowerCase()) ||
          l.action.toLowerCase().includes(query.toLowerCase()) ||
          (l.details || "").toLowerCase().includes(query.toLowerCase())
      ),
    [logs, query]
  );

  const handleConfirmDelete = () => {
    if (!deleteTarget) return;

    setDeleting(true);

    axios
      .delete(`http://localhost:5000/activity-logs/${deleteTarget.id}`)
      .then(() => {
        setToast({ type: "success", message: "Activity log deleted." });
        setDeleteTarget(null);
        emitDataEvent(DATA_EVENTS.ACTIVITY_LOGS_CHANGED);
        return fetchLogs();
      })
      .catch((err) => {
        setToast({ type: "error", message: err.response?.data?.message || "Failed to delete log entry." });
      })
      .finally(() => setDeleting(false));
  };

  const handleConfirmDeleteAll = () => {
    setDeletingAll(true);

    axios
      .delete("http://localhost:5000/activity-logs")
      .then(() => {
        setToast({ type: "success", message: "All activity logs deleted." });
        setDeleteAllOpen(false);
        emitDataEvent(DATA_EVENTS.ACTIVITY_LOGS_CHANGED);
        return fetchLogs();
      })
      .catch((err) => {
        setToast({ type: "error", message: err.response?.data?.message || "Failed to delete activity logs." });
      })
      .finally(() => setDeletingAll(false));
  };

  return (
    <div>
      <AdminPageHeader
        eyebrow="Audit Trail"
        title="Activity Logs"
        description="Recent authentication and account-management events across the system."
        actions={
          <div className="flex items-center gap-2.5">
            <AdminButton icon={RefreshCw} variant="secondary" onClick={fetchLogs} disabled={loading} className="whitespace-nowrap">
              Refresh
            </AdminButton>
            <AdminButton
              icon={Trash2}
              variant="danger"
              onClick={() => setDeleteAllOpen(true)}
              disabled={loading || logs.length === 0}
              className="whitespace-nowrap"
            >
              Delete All Logs
            </AdminButton>
          </div>
        }
      />

      <AdminCard className="p-4 sm:p-5">
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <AdminSearchInput value={query} onChange={setQuery} placeholder="Search by user or action…" className="sm:w-72" />
          <p className="font-mono text-xs text-ink-500">
            {loading ? "Loading…" : `${filtered.length} of ${logs.length} events`}
          </p>
        </div>

        {loading && (
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-ink-500">
            <Loader2 size={22} className="animate-spin text-admin-accent" />
            <p className="text-xs">Loading activity…</p>
          </div>
        )}

        {!loading && error && (
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-center text-ink-500">
            <AlertTriangle size={22} className="text-red-400" />
            <p className="text-xs">{error}</p>
          </div>
        )}

        {!loading && !error && (
          <div className="custom-scroll overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-admin-accent/10 text-xs uppercase tracking-wide text-ink-500">
                  <th className="px-3 py-3 font-medium">Date &amp; Time</th>
                  <th className="px-3 py-3 font-medium">User</th>
                  <th className="px-3 py-3 font-medium">Activity</th>
                  <th className="px-3 py-3 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((log) => (
                  <tr key={log.id} className="border-b border-white/5 hover:bg-white/[0.03] transition">
                    <td className="px-3 py-3 whitespace-nowrap font-mono text-xs text-ink-500">{log.created_at}</td>
                    <td className="px-3 py-3 font-medium text-ink-100">{log.user_name}</td>
                    <td className="px-3 py-3">
                      <span className={`font-mono text-xs ${actionTone[log.action] || "text-ink-300"}`}>{log.action}</span>
                      {log.details && <p className="mt-0.5 text-xs text-ink-500">{log.details}</p>}
                    </td>
                    <td className="px-3 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(log)}
                        className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-signal-red/80 hover:bg-signal-red/10 hover:text-signal-red transition"
                      >
                        <Trash2 size={13} />
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}

                {logs.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-16 text-center text-ink-500">
                      <div className="flex flex-col items-center gap-2">
                        <ScrollText size={22} />
                        <p>No activity has been recorded yet.</p>
                      </div>
                    </td>
                  </tr>
                )}

                {logs.length > 0 && filtered.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-12 text-center text-ink-500">
                      No events match "{query}".
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </AdminCard>

      <AdminModal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Delete Activity Log?">
        <p className="text-sm text-ink-300">
          Are you sure you want to delete this activity log entry? This action cannot be undone.
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

      <AdminModal open={deleteAllOpen} onClose={() => setDeleteAllOpen(false)} title="Delete All Activity Logs">
        <p className="text-sm text-ink-300">Are you sure you want to permanently delete all activity logs?</p>
        <div className="flex justify-end gap-3 pt-5">
          <AdminButton type="button" variant="ghost" onClick={() => setDeleteAllOpen(false)} disabled={deletingAll}>
            Cancel
          </AdminButton>
          <AdminButton type="button" variant="danger" onClick={handleConfirmDeleteAll} disabled={deletingAll}>
            {deletingAll ? "Deleting…" : "Delete All"}
          </AdminButton>
        </div>
      </AdminModal>

      <AdminToast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
