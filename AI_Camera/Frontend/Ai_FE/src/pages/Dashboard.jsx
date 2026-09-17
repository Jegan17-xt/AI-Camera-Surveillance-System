import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { authLog } from "../debugLog";

import PageHeader from "../components/ui/PageHeader";
import StatCard from "../components/StatCard";
import RecentActivity from "../components/RecentActivity";
import UserScopeSelector from "../components/ui/UserScopeSelector";
import { useAuth } from "../context/AuthContext";
import { useSelectedUser } from "../context/SelectedUserContext";
import { DATA_EVENTS, useDataEvent } from "../lib/dataEvents";
import { usePolling } from "../lib/usePolling";
import { API_BASE_URL } from "../lib/apiBase";

// New attendance marks and unknown-person detections are written by the
// backend's 24/7 AI Detection Engine (camera/detection_service.py) —
// a background thread with no HTTP request behind it, so there is
// structurally no CRUD success handler to emit a dataEvent from for
// those; a browser can only ever learn about them by asking again. This
// bounded poll is what catches them (and anything from another
// session) instead; see src/lib/usePolling.js for how it avoids wasted
// requests while the tab is hidden. Shortened from 20s to 5s (Critical
// Production Fix) so a mark made by the always-on engine shows up
// close to immediately, matching "Dashboard should reflect the new
// data immediately after the database is updated" — this is genuine
// polling, not a push, so "immediately" here means "within one 5s
// cycle," not an instant server-initiated update.
const DASHBOARD_POLL_MS = 5000;

const today = new Date().toLocaleDateString(undefined, {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
});

export default function Dashboard() {

  const { user } = useAuth();
  const { selectedUserId } = useSelectedUser();
  const [statCards, setStatCards] = useState([]);
  const [recentActivity, setRecentActivity] = useState([]);

  const fetchDashboard = useCallback(() => {

    authLog("Dashboard.jsx: firing GET /dashboard");

    return axios
      .get(`${API_BASE_URL}/dashboard`, {
        params: selectedUserId !== null ? { user_id: selectedUserId } : undefined,
      })
      .then((res) => {

        authLog("Dashboard.jsx: GET /dashboard resolved 200");

        const data = res.data;

        const camerasTotal = data.cameras_total || 0;
        const camerasOnline = data.cameras_online || 0;

        setStatCards([
          {
            id: 1,
            label: "Registered Persons",
            value: data.registered,
            icon: "Users",
            tone: "cyan",
          },
          {
            id: 2,
            label: "Today's Attendance",
            value: data.present,
            icon: "UserCheck",
            tone: "green",
          },
          {
            id: 3,
            label: "Unknown Persons",
            value: data.unknown,
            icon: "ScanFace",
            tone: "red",
          },
          {
            id: 4,
            label: "Cameras Online",
            value: camerasTotal > 0 ? `${camerasOnline} / ${camerasTotal}` : "0",
            delta: camerasTotal > 0 ? `${camerasTotal} camera(s) configured` : "No cameras configured",
            icon: "Camera",
            tone: "blue",
          },
          {
            id: 5,
            label: "Attendance Rate (%)",
            value: `${data.attendance_rate ?? 0}%`,
            delta: data.registered > 0 ? `${data.present} of ${data.registered} present` : "No registered persons",
            icon: "Percent",
            tone: "green",
          },
          {
            id: 6,
            label: "Vehicles Today",
            value: data.vehicles_today ?? 0,
            delta: "Detected today",
            icon: "Car",
            tone: "cyan",
          },
          {
            id: 7,
            label: "Animals Today",
            value: data.animals_today ?? 0,
            delta: "Detected today",
            icon: "PawPrint",
            tone: "amber",
          },
          {
            id: 8,
            label: "Birds Today",
            value: data.birds_today ?? 0,
            delta: "Detected today",
            icon: "Bird",
            tone: "cyan",
          },
          {
            id: 9,
            label: "Fire / Smoke Today",
            value: data.fire_events_today ?? 0,
            delta: (data.fire_events_today ?? 0) > 0 ? "Review Detection Events" : "No fire alerts today",
            icon: "Flame",
            tone: "red",
          },
        ]);

        // Real events only, merged + de-duplicated server-side from
        // attendance.csv and unknown_log.csv (see Backend/api/dashboard.py)
        // — already sorted newest first.
        setRecentActivity(data.recent_activity || []);

      })
      .catch((err) => {
        authLog("Dashboard.jsx: GET /dashboard REJECTED", err.response?.status);
        console.error("Dashboard API Error :", err);
      });

  }, [selectedUserId]);

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  // Every stat card here is sourced from a different page's own data
  // (Registered Persons, Unknown Persons, Attendance, Cameras) — refresh
  // whenever any of them changes, so the numbers shown are never stale
  // just because the user hasn't manually reloaded /dashboard.
  useDataEvent(
    [
      DATA_EVENTS.REGISTERED_PERSONS_CHANGED,
      DATA_EVENTS.UNKNOWN_PERSONS_CHANGED,
      DATA_EVENTS.DETECTION_EVENTS_CHANGED,
      DATA_EVENTS.ATTENDANCE_CHANGED,
      DATA_EVENTS.CAMERAS_CHANGED,
    ],
    fetchDashboard
  );

  usePolling(fetchDashboard, DASHBOARD_POLL_MS);

  return (
    <div>

      <PageHeader
        eyebrow="Overview"
        title={`Welcome back, ${user?.name || "there"}`}
        description={today}
        actions={<UserScopeSelector />}
      />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-5">

        {statCards.map((card) => (
          <StatCard
            key={card.id}
            {...card}
          />
        ))}

      </div>

      <div className="mt-6 flex justify-center">

        <div className="w-full max-w-3xl">
          <RecentActivity items={recentActivity} onChanged={fetchDashboard} />
        </div>

      </div>

    </div>
  );
}
