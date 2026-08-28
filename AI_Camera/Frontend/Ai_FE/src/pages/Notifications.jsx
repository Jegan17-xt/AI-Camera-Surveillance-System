import { useEffect, useState } from "react";
import axios from "axios";
import { Bell, BellOff, CheckCheck, Trash2, Loader2, AlertTriangle, Camera, ScanFace } from "lucide-react";
import PageHeader from "../components/ui/PageHeader";
import GlassCard from "../components/ui/GlassCard";
import Button from "../components/ui/Button";
import Toast from "../components/ui/Toast";
import UserScopeSelector from "../components/ui/UserScopeSelector";
import { useSelectedUser } from "../context/SelectedUserContext";
import { DATA_EVENTS, emitDataEvent, useDataEvent } from "../lib/dataEvents";
import { API_BASE_URL } from "../lib/apiBase";

const TYPE_ICON = {
  unknown_person: ScanFace,
  camera_offline: Camera,
};

export default function Notifications() {
  const { selectedUserId } = useSelectedUser();
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [markingAll, setMarkingAll] = useState(false);

  const fetchNotifications = () => {
    setLoading(true);
    setError(null);

    return axios
      .get(`${API_BASE_URL}/account/notifications`, {
        params: selectedUserId !== null ? { user_id: selectedUserId } : undefined,
      })
      .then((res) => setNotifications(res.data.notifications || []))
      .catch((err) => {
        console.error("Notifications API Error :", err);
        setError("Unable to load notifications. Please check the server and try again.");
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchNotifications();
  }, [selectedUserId]);

  useDataEvent(DATA_EVENTS.NOTIFICATIONS_CHANGED, fetchNotifications);

  const handleMarkRead = (id) => {
    axios
      .put(`${API_BASE_URL}/account/notifications/${id}/read`)
      .then(() => {
        setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, is_read: true } : n)));
        emitDataEvent(DATA_EVENTS.NOTIFICATIONS_CHANGED);
      })
      .catch((err) => console.error("Mark Notification Read API Error :", err));
  };

  const handleMarkAllRead = () => {
    setMarkingAll(true);
    axios
      .put(`${API_BASE_URL}/account/notifications/read-all`, null, {
        params: selectedUserId !== null ? { user_id: selectedUserId } : undefined,
      })
      .then(() => {
        setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
        emitDataEvent(DATA_EVENTS.NOTIFICATIONS_CHANGED);
      })
      .catch((err) => {
        console.error("Mark All Notifications Read API Error :", err);
        setToast({ type: "error", message: "Failed to mark all as read." });
      })
      .finally(() => setMarkingAll(false));
  };

  const handleDelete = (id) => {
    axios
      .delete(`${API_BASE_URL}/account/notifications/${id}`)
      .then(() => {
        setNotifications((prev) => prev.filter((n) => n.id !== id));
        emitDataEvent(DATA_EVENTS.NOTIFICATIONS_CHANGED);
      })
      .catch((err) => {
        console.error("Delete Notification API Error :", err);
        setToast({ type: "error", message: "Failed to delete notification." });
      });
  };

  const unreadCount = notifications.filter((n) => !n.is_read).length;

  return (
    <div>
      <PageHeader
        eyebrow="Alerts"
        title="Notifications"
        description="Unknown-person detections and camera-offline alerts."
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <UserScopeSelector />
            <Button
              variant="secondary"
              icon={CheckCheck}
              onClick={handleMarkAllRead}
              disabled={markingAll || unreadCount === 0}
            >
              Mark All Read
            </Button>
          </div>
        }
      />

      {loading && (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-ink-500">
          <Loader2 size={22} className="animate-spin" />
          <p className="text-xs">Loading notifications…</p>
        </div>
      )}

      {!loading && error && (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-center text-ink-500">
          <AlertTriangle size={22} className="text-red-400" />
          <p className="text-xs">{error}</p>
        </div>
      )}

      {!loading && !error && notifications.length === 0 && (
        <GlassCard className="mx-auto max-w-md p-8 text-center">
          <div className="flex flex-col items-center gap-3">
            <BellOff size={28} className="text-ink-500" strokeWidth={1.5} />
            <p className="font-display text-base font-semibold text-white">No Notifications</p>
            <p className="text-xs text-ink-500">You're all caught up — nothing to see here yet.</p>
          </div>
        </GlassCard>
      )}

      {!loading && !error && notifications.length > 0 && (
        <div className="space-y-2.5">
          {notifications.map((n) => {
            const Icon = TYPE_ICON[n.type] || Bell;
            return (
              <GlassCard
                key={n.id}
                className={`flex items-start gap-3.5 p-4 ${!n.is_read ? "ring-1 ring-accent-cyan/30" : ""}`}
              >
                <span
                  className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${
                    n.type === "camera_offline" ? "bg-signal-red/10 text-signal-red" : "bg-accent-cyan/10 text-accent-cyan"
                  }`}
                >
                  <Icon size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-ink-100">{n.message}</p>
                  <p className="mt-1 font-mono text-[11px] text-ink-500">{n.created_at}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {!n.is_read && (
                    <button
                      type="button"
                      onClick={() => handleMarkRead(n.id)}
                      title="Mark as read"
                      className="rounded-md p-1.5 text-ink-400 transition hover:bg-white/10 hover:text-accent-cyan"
                    >
                      <CheckCheck size={14} />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleDelete(n.id)}
                    title="Delete"
                    className="rounded-md p-1.5 text-ink-400 transition hover:bg-signal-red/20 hover:text-signal-red"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </GlassCard>
            );
          })}
        </div>
      )}

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
