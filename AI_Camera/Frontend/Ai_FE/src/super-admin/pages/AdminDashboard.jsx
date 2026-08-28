import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { RefreshCw, Loader2, AlertTriangle, ScrollText, Trash2, Building2, Camera } from "lucide-react";
import AdminPageHeader from "../ui/AdminPageHeader";
import AdminCard from "../ui/AdminCard";
import AdminStatCard from "../ui/AdminStatCard";
import AdminButton from "../ui/AdminButton";
import AdminModal from "../ui/AdminModal";
import AdminToast from "../ui/AdminToast";
import { DATA_EVENTS, emitDataEvent, useDataEvent } from "../../lib/dataEvents";
import { usePolling } from "../../lib/usePolling";
import { API_BASE_URL } from "../../lib/apiBase";

// Most of this page's data (other companies' camera status, other admins'
// activity) is generated in OTHER browser sessions entirely — a Company
// Admin's own tab, or the backend's camera-status thread — none of which
// can reach this tab's event bus (see src/lib/dataEvents.js). This poll is
// what catches those; actions the Super Admin performs in THIS tab (Add
// Customer, Add Camera, delete a log, etc.) still refresh instantly via
// useDataEvent below, with zero extra requests.
const DASHBOARD_POLL_MS = 10000;

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
  "Super Admin Profile Updated": "text-admin-gold",
  "Super Admin Password Changed": "text-admin-gold",
};

export default function AdminDashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);

  const fetchDashboard = useCallback(() => {
    setError(null);

    return axios
      .get(`${API_BASE_URL}/admin/dashboard`)
      .then((res) => setData(res.data))
      .catch((err) => {
        console.error("Admin Dashboard API Error :", err);
        setError("Unable to load dashboard data. Please check the server and try again.");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  // Instant, zero-extra-cost refresh for anything the Super Admin does
  // themselves in this tab.
  useDataEvent(
    [DATA_EVENTS.CUSTOMERS_CHANGED, DATA_EVENTS.CAMERAS_CHANGED, DATA_EVENTS.ACTIVITY_LOGS_CHANGED, DATA_EVENTS.PROFILE_CHANGED],
    fetchDashboard
  );

  // Automatic refresh every 10 seconds, without reloading the page.
  usePolling(fetchDashboard, DASHBOARD_POLL_MS);

  // A poll/event refresh may drop a log that was selected (someone else
  // deleted it, or it aged out of the "recent" window) — prune stale ids
  // so "Select All" / the selected count never drifts from what's shown.
  useEffect(() => {
    if (!data) return;

    const visibleIds = new Set(data.recent_activity.map((entry) => entry.id));

    setSelectedIds((prev) => {
      const next = new Set([...prev].filter((id) => visibleIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [data]);

  const allSelected =
    !!data && data.recent_activity.length > 0 && data.recent_activity.every((entry) => selectedIds.has(entry.id));

  const toggleSelectAll = () => {
    if (!data) return;

    setSelectedIds(allSelected ? new Set() : new Set(data.recent_activity.map((entry) => entry.id)));
  };

  const toggleSelectOne = (id) => {
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

  const handleConfirmDelete = () => {
    if (!deleteTarget) return;

    setDeleting(true);

    axios
      .delete(`${API_BASE_URL}/activity-logs/${deleteTarget.id}`)
      .then(() => {
        setToast({ type: "success", message: "Activity log deleted." });
        setDeleteTarget(null);
        emitDataEvent(DATA_EVENTS.ACTIVITY_LOGS_CHANGED);
        return fetchDashboard();
      })
      .catch((err) => {
        setToast({ type: "error", message: err.response?.data?.message || "Failed to delete log entry." });
      })
      .finally(() => setDeleting(false));
  };

  const handleConfirmBulkDelete = () => {
    if (selectedIds.size === 0) return;

    setBulkDeleting(true);

    axios
      .post(`${API_BASE_URL}/activity-logs/bulk-delete`, { ids: Array.from(selectedIds) })
      .then(() => {
        setToast({ type: "success", message: "Selected activity logs deleted." });
        setBulkDeleteOpen(false);
        setSelectedIds(new Set());
        emitDataEvent(DATA_EVENTS.ACTIVITY_LOGS_CHANGED);
        return fetchDashboard();
      })
      .catch((err) => {
        setToast({ type: "error", message: err.response?.data?.message || "Failed to delete selected activity logs." });
      })
      .finally(() => setBulkDeleting(false));
  };

  const handleConfirmDeleteAll = () => {
    setDeletingAll(true);

    axios
      .delete(`${API_BASE_URL}/activity-logs`)
      .then(() => {
        setToast({ type: "success", message: "All activity logs deleted." });
        setDeleteAllOpen(false);
        setSelectedIds(new Set());
        emitDataEvent(DATA_EVENTS.ACTIVITY_LOGS_CHANGED);
        return fetchDashboard();
      })
      .catch((err) => {
        setToast({ type: "error", message: err.response?.data?.message || "Failed to delete activity logs." });
      })
      .finally(() => setDeletingAll(false));
  };

  const statCards = data
    ? [
        { id: "company-admins", label: "Total Company Admins", value: data.total_company_admins, icon: "Users", tone: "violet" },
        { id: "cameras", label: "Total Cameras", value: data.total_cameras, icon: "Camera", tone: "violet" },
        { id: "online", label: "Total Cameras Online", value: data.cameras_online, icon: "Wifi", tone: "green" },
        { id: "offline", label: "Total Cameras Offline", value: data.cameras_offline, icon: "WifiOff", tone: "red" },
      ]
    : [];

  return (
    <div>
      <AdminPageHeader
        eyebrow="Overview"
        title="Dashboard"
        description="Company Admin and camera status across every customer."
        actions={
          <AdminButton icon={RefreshCw} variant="secondary" onClick={fetchDashboard} disabled={loading} className="whitespace-nowrap">
            Refresh
          </AdminButton>
        }
      />

      {loading && (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-ink-500">
          <Loader2 size={22} className="animate-spin text-admin-accent" />
          <p className="text-xs">Loading dashboard…</p>
        </div>
      )}

      {!loading && error && (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-center text-ink-500">
          <AlertTriangle size={22} className="text-red-400" />
          <p className="text-xs">{error}</p>
        </div>
      )}

      {!loading && !error && data && (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {statCards.map((card) => (
              <AdminStatCard key={card.id} {...card} />
            ))}
          </div>

          <p className="mb-3 mt-6 text-xs font-medium uppercase tracking-wide text-ink-500">Company Admin Camera Status</p>

          {data.company_admin_camera_status.length === 0 ? (
            <AdminCard className="p-4 sm:p-5">
              <div className="flex flex-col items-center justify-center gap-2 py-12 text-ink-500">
                <Building2 size={22} />
                <p className="text-xs">No Company Admins have been added yet.</p>
              </div>
            </AdminCard>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {data.company_admin_camera_status.map((company) => (
                <AdminCard key={company.customer_id} className="p-4 sm:p-5">
                  <div className="flex items-start gap-3 border-b border-white/5 pb-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-white/[0.04] text-admin-accent">
                      <Building2 size={19} strokeWidth={2} />
                    </div>
                    <div className="min-w-0">
                      <p className="truncate font-display text-base font-semibold text-white">{company.company_name}</p>
                      <p className="truncate text-xs text-ink-500">Admin : {company.admin_name}</p>
                    </div>
                  </div>
                  <div className="space-y-2 pt-3 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-ink-400">
                        <Camera size={14} /> Total Cameras
                      </span>
                      <span className="font-mono font-medium text-ink-100">{company.total_cameras}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-ink-400">Online Cameras</span>
                      <span className="font-mono font-medium text-signal-green">{company.online_cameras}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-ink-400">Offline Cameras</span>
                      <span className="font-mono font-medium text-signal-red">{company.offline_cameras}</span>
                    </div>
                  </div>
                </AdminCard>
              ))}
            </div>
          )}

          <AdminCard className="mt-4 p-4 sm:p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-4">
                <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Activity Logs</p>
                {data.recent_activity.length > 0 && (
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-400">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      className="h-4 w-4 shrink-0 rounded border-white/20 bg-transparent accent-admin-accent"
                    />
                    Select All
                  </label>
                )}
              </div>

              {data.recent_activity.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <AdminButton
                    type="button"
                    variant="danger"
                    icon={Trash2}
                    onClick={() => setBulkDeleteOpen(true)}
                    disabled={selectedIds.size === 0}
                    className="!py-1.5 !px-3 whitespace-nowrap text-xs"
                  >
                    Delete Selected{selectedIds.size > 0 ? ` (${selectedIds.size})` : ""}
                  </AdminButton>
                  <AdminButton
                    type="button"
                    variant="danger"
                    icon={Trash2}
                    onClick={() => setDeleteAllOpen(true)}
                    className="!py-1.5 !px-3 whitespace-nowrap text-xs"
                  >
                    Delete All
                  </AdminButton>
                </div>
              )}
            </div>

            {data.recent_activity.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-12 text-ink-500">
                <ScrollText size={22} />
                <p className="text-xs">No activity has been recorded yet.</p>
              </div>
            ) : (
              <div className="divide-y divide-white/5">
                {data.recent_activity.map((entry) => (
                  <div key={entry.id} className="flex items-start justify-between gap-4 py-3">
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(entry.id)}
                        onChange={() => toggleSelectOne(entry.id)}
                        className="mt-1 h-4 w-4 shrink-0 rounded border-white/20 bg-transparent accent-admin-accent"
                      />
                      <div>
                        <span className={`font-mono text-xs ${actionTone[entry.action] || "text-ink-300"}`}>
                          {entry.action}
                        </span>
                        <p className="mt-0.5 text-sm text-ink-100">{entry.user_name}</p>
                        {entry.details && <p className="mt-0.5 text-xs text-ink-500">{entry.details}</p>}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <p className="whitespace-nowrap font-mono text-[11px] text-ink-500">{entry.created_at}</p>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(entry)}
                        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-signal-red/80 hover:bg-signal-red/10 hover:text-signal-red transition"
                      >
                        <Trash2 size={13} />
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </AdminCard>
        </>
      )}

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

      <AdminModal open={bulkDeleteOpen} onClose={() => setBulkDeleteOpen(false)} title="Delete Selected Activity Logs?">
        <p className="text-sm text-ink-300">
          Are you sure you want to delete the selected activity logs? This action cannot be undone.
        </p>
        <div className="flex justify-end gap-3 pt-5">
          <AdminButton type="button" variant="ghost" onClick={() => setBulkDeleteOpen(false)} disabled={bulkDeleting}>
            Cancel
          </AdminButton>
          <AdminButton type="button" variant="danger" onClick={handleConfirmBulkDelete} disabled={bulkDeleting}>
            {bulkDeleting ? "Deleting…" : "Delete"}
          </AdminButton>
        </div>
      </AdminModal>

      <AdminModal open={deleteAllOpen} onClose={() => setDeleteAllOpen(false)} title="Delete All Activity Logs?">
        <p className="text-sm text-ink-300">
          Are you sure you want to delete all activity logs? This action cannot be undone.
        </p>
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
