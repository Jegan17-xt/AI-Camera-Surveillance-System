import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { CalendarDays, TrendingUp, Loader2, AlertTriangle } from "lucide-react";
import PageHeader from "../components/ui/PageHeader";
import GlassCard from "../components/ui/GlassCard";
import AnalyticsLineChart from "../components/AnalyticsLineChart";
import UserScopeSelector from "../components/ui/UserScopeSelector";
import { useSelectedUser } from "../context/SelectedUserContext";
import { DATA_EVENTS, useDataEvent } from "../lib/dataEvents";
import { usePolling } from "../lib/usePolling";
import { API_BASE_URL } from "../lib/apiBase";

// New unknown-person detections happen on the backend's camera-processing
// thread — a different process than this tab — so polling is what
// actually catches them; the DATA_EVENTS hook below only covers the rare
// case of a same-tab action (e.g. deleting an unknown person from the
// Unknown Persons page) needing an instant refresh too, at zero extra cost.
const POLL_MS = 15000;

export default function UnknownPersonAnalytics() {
  const { selectedUserId } = useSelectedUser();
  const [daily, setDaily] = useState([]);
  const [monthly, setMonthly] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchData = useCallback(() => {
    setError(null);

    return axios
      .get(`${API_BASE_URL}/company/unknown-analytics`, {
        params: selectedUserId !== null ? { user_id: selectedUserId } : undefined,
      })
      .then((res) => {
        setDaily(res.data.daily || []);
        setMonthly(res.data.monthly || []);
      })
      .catch((err) => {
        console.error("Unknown Person Analytics API Error :", err);
        setError("Unable to load analytics. Please check the server and try again.");
      })
      .finally(() => setLoading(false));
  }, [selectedUserId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useDataEvent(DATA_EVENTS.UNKNOWN_PERSONS_CHANGED, fetchData);
  usePolling(fetchData, POLL_MS);

  return (
    <div>
      <PageHeader
        eyebrow="AI Detection"
        title="Unknown Person Analytics"
        description="Unique unknown persons detected, by day and by month. The same face is never counted twice on the same day."
        actions={<UserScopeSelector />}
      />

      {loading && (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-ink-500">
          <Loader2 size={22} className="animate-spin" />
          <p className="text-xs">Loading analytics…</p>
        </div>
      )}

      {!loading && error && (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-center text-ink-500">
          <AlertTriangle size={22} className="text-red-400" />
          <p className="text-xs">{error}</p>
        </div>
      )}

      {!loading && !error && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <GlassCard className="p-5">
            <div className="mb-2 flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-cyan/10 text-accent-cyan">
                <CalendarDays size={19} />
              </span>
              <div>
                <p className="font-display text-sm font-semibold text-white">Daily Unknown Person Report</p>
                <p className="text-xs text-ink-500">Unique unknown persons detected each day, last 7 days</p>
              </div>
            </div>
            <AnalyticsLineChart data={daily} color="#22d3ee" />
          </GlassCard>

          <GlassCard className="p-5">
            <div className="mb-2 flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-blue/10 text-accent-blue">
                <TrendingUp size={19} />
              </span>
              <div>
                <p className="font-display text-sm font-semibold text-white">Monthly Unknown Person Report</p>
                <p className="text-xs text-ink-500">Unique unknown persons detected each month, year to date</p>
              </div>
            </div>
            <AnalyticsLineChart data={monthly} color="#3b82f6" />
          </GlassCard>
        </div>
      )}
    </div>
  );
}
