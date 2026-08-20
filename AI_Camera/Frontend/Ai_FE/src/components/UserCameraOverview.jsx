import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { Loader2 } from "lucide-react";
import GlassCard from "./ui/GlassCard";
import StatCard from "./StatCard";
import StatusBadge from "./ui/StatusBadge";
import { DATA_EVENTS, useDataEvent } from "../lib/dataEvents";
import { usePolling } from "../lib/usePolling";

const POLL_MS = 5000;

// "User & Camera Overview" — its own standalone page (see
// admin/pages/UserCameraOverviewPage.jsx, mounted at
// /admin/user-camera-overview, Company-Admin-only), matching the
// backend's company_admin_required gate on GET
// /dashboard/user-camera-overview. Originally embedded directly in
// pages/Dashboard.jsx; moved out into its own page but left otherwise
// unchanged so the data logic below is unaffected by where it's
// rendered. Fully self-contained: fetches and refreshes itself on a 5s
// poll, PLUS an immediate refetch the instant a User or Camera actually
// changes anywhere else in the app (User Management, Camera
// Management) — nothing here is ever hardcoded or cached stale; every
// number comes straight from the same users/cameras tables and
// owner_user_id assignment every other per-user feature already uses.
export default function UserCameraOverview() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchOverview = useCallback(() => {
    return axios
      .get("http://localhost:5000/dashboard/user-camera-overview")
      .then((res) => setData(res.data))
      .catch((err) => {
        console.error("User & Camera Overview API Error :", err);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchOverview();
  }, [fetchOverview]);

  useDataEvent([DATA_EVENTS.COMPANY_USERS_CHANGED, DATA_EVENTS.CAMERAS_CHANGED], fetchOverview);

  usePolling(fetchOverview, POLL_MS);

  if (loading && !data) {
    return (
      <GlassCard className="mb-6 flex items-center gap-2 p-5 text-ink-500">
        <Loader2 size={16} className="animate-spin" />
        <p className="text-xs">Loading User & Camera Overview…</p>
      </GlassCard>
    );
  }

  if (!data) return null;

  const miniStats = [
    { id: "total-users", label: "Total Users", value: data.total_users, icon: "Users", tone: "cyan" },
    { id: "active-users", label: "Active Users", value: data.active_users, icon: "UserCheck", tone: "green" },
    { id: "total-cameras", label: "Total Cameras", value: data.total_cameras, icon: "Camera", tone: "blue" },
    { id: "online-cameras", label: "Online Cameras", value: data.online_cameras, icon: "Wifi", tone: "green" },
    { id: "offline-cameras", label: "Offline Cameras", value: data.offline_cameras, icon: "WifiOff", tone: "red" },
  ];

  return (
    <div className="mb-6">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-5">
        {miniStats.map((card) => (
          <StatCard key={card.id} label={card.label} value={card.value} icon={card.icon} tone={card.tone} />
        ))}
      </div>

      <GlassCard className="mt-4 p-4 sm:p-5">
        <p className="mb-3 text-sm font-medium text-ink-100">User-wise Camera Summary</p>
        <div className="custom-scroll overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-accent-cyan/10 text-xs uppercase tracking-wide text-ink-500">
                <th className="px-3 py-3 font-medium">User Name</th>
                <th className="px-3 py-3 font-medium">Email</th>
                <th className="px-3 py-3 font-medium">Assigned Cameras</th>
                <th className="px-3 py-3 font-medium">Online</th>
                <th className="px-3 py-3 font-medium">Offline</th>
                <th className="px-3 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id} className="border-b border-white/5 transition hover:bg-white/[0.03]">
                  <td className="px-3 py-3 font-medium text-ink-100">{u.name}</td>
                  <td className="px-3 py-3 font-mono text-xs text-ink-400">{u.email}</td>
                  <td className="px-3 py-3 font-mono text-xs text-ink-400">{u.assigned_cameras}</td>
                  <td className="px-3 py-3 font-mono text-xs text-signal-green">{u.online_cameras}</td>
                  <td className="px-3 py-3 font-mono text-xs text-ink-400">{u.offline_cameras}</td>
                  <td className="px-3 py-3">
                    <StatusBadge status={u.status} />
                  </td>
                </tr>
              ))}

              {data.users.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-10 text-center text-ink-500">
                    No users have been added yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </GlassCard>
    </div>
  );
}
