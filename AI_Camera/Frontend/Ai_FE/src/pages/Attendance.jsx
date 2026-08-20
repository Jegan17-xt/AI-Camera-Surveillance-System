import { Fragment, useEffect, useMemo, useState } from "react";
import axios from "axios";
import { RefreshCw, FileDown, Loader2, AlertTriangle, ClipboardList, ChevronDown } from "lucide-react";
import PageHeader from "../components/ui/PageHeader";
import SearchInput from "../components/ui/SearchInput";
import GlassCard from "../components/ui/GlassCard";
import StatusBadge from "../components/ui/StatusBadge";
import StatCard from "../components/StatCard";
import Button from "../components/ui/Button";
import Toast from "../components/ui/Toast";
import UserScopeSelector from "../components/ui/UserScopeSelector";
import Select from "../components/ui/Select";
import { useSelectedUser } from "../context/SelectedUserContext";
import { DATA_EVENTS, useDataEvent } from "../lib/dataEvents";
import { validateDate, todayDateValue } from "../lib/validation";

const toDDMMYYYY = (isoDate) => {
  if (!isoDate) return "";
  const [year, month, day] = isoDate.split("-");
  return `${day}-${month}-${year}`;
};

const todayDDMMYYYY = () => {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  return `${day}-${month}-${now.getFullYear()}`;
};

const escapeCsvField = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;

const parseDateTime = (dateStr, timeStr) => {
  const [day, month, year] = String(dateStr || "").split("-").map(Number);
  const [h = 0, m = 0, s = 0] = String(timeStr || "").split(":").map(Number);
  if (!day || !month || !year) return 0;
  return new Date(year, month - 1, day, h, m, s).getTime();
};

export default function Attendance() {
  const { selectedUserId } = useSelectedUser();
  const [query, setQuery] = useState("");
  const [dateFilter, setDateFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const [records, setRecords] = useState([]);
  const [registeredPersons, setRegisteredPersons] = useState([]);
  const [registeredTotal, setRegisteredTotal] = useState(0);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [downloading, setDownloading] = useState(false);
  const [toast, setToast] = useState(null);

  const fetchAttendance = () => {
    setLoading(true);
    setError(null);

    return axios
      .get("http://localhost:5000/attendance", {
        params: selectedUserId !== null ? { user_id: selectedUserId } : undefined,
      })
      .then((res) => {
        setRecords(res.data.attendance || []);
      })
      .catch((err) => {
        console.error("Attendance API Error :", err);
        setError("Unable to load attendance records. Please check the server and try again.");
      })
      .finally(() => {
        setLoading(false);
      });
  };

  // Registered Persons is a different module than Attendance — a User
  // granted only Attendance (not Registered Persons) legitimately gets a
  // 403 here. That must only omit this one number, not evict them from a
  // page they otherwise have every right to be on (see AuthContext.jsx's
  // response interceptor for the other half of this fix).
  const fetchRegisteredTotal = () =>
    axios
      .get("http://localhost:5000/registered", {
        suppressAuthRedirect: true,
        params: selectedUserId !== null ? { user_id: selectedUserId } : undefined,
      })
      .then((res) => {
        const persons = res.data.persons || [];
        setRegisteredPersons(persons);
        setRegisteredTotal(res.data.total ?? persons.length);
      })
      .catch((err) => {
        console.error("Registered Persons API Error :", err);
      });

  useEffect(() => {
    fetchAttendance();
    fetchRegisteredTotal();
  }, [selectedUserId]);

  // Registered Persons is a different page — adding/editing/deleting
  // someone there must not leave this page's "Total Attendance"/Absent
  // computation stale.
  useDataEvent(DATA_EVENTS.REGISTERED_PERSONS_CHANGED, fetchRegisteredTotal);

  // Settings > Clear Attendance Logs mutates the same records this page
  // displays.
  useDataEvent(DATA_EVENTS.ATTENDANCE_CHANGED, fetchAttendance);

  const selectedDateKey = dateFilter ? toDDMMYYYY(dateFilter) : todayDDMMYYYY();

  const presentNamesForSelectedDate = useMemo(
    () => new Set(records.filter((r) => r.date === selectedDateKey).map((r) => r.name)),
    [records, selectedDateKey]
  );

  const presentCount = presentNamesForSelectedDate.size;

  // Absent = Registered Persons - Present (for the selected date), not derived from attendance rows alone.
  const absentRows = useMemo(
    () =>
      registeredPersons
        .filter((p) => !presentNamesForSelectedDate.has(p.name))
        .map((p) => ({
          name: p.name,
          date: selectedDateKey,
          in_time: "--",
          out_time: "--",
          status: "Absent",
        })),
    [registeredPersons, presentNamesForSelectedDate, selectedDateKey]
  );

  const absentCount = absentRows.length;

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    if (statusFilter === "Absent") {
      return absentRows
        .filter((r) => r.name.toLowerCase().includes(normalizedQuery))
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    return records
      .filter((r) => {
        const matchesName = r.name.toLowerCase().includes(normalizedQuery);
        const matchesDate = dateFilter ? r.date === toDDMMYYYY(dateFilter) : true;
        const matchesStatus = statusFilter ? r.status === statusFilter : true;
        return matchesName && matchesDate && matchesStatus;
      })
      .sort((a, b) => parseDateTime(b.date, b.in_time) - parseDateTime(a.date, a.in_time));
  }, [records, absentRows, query, dateFilter, statusFilter]);

  const groupedByDate = useMemo(() => {
    const groups = new Map();
    filtered.forEach((r) => {
      if (!groups.has(r.date)) groups.set(r.date, []);
      groups.get(r.date).push(r);
    });
    return Array.from(groups.entries());
  }, [filtered]);

  const [collapsedDates, setCollapsedDates] = useState(new Set());

  const toggleDateGroup = (date) => {
    setCollapsedDates((prev) => {
      const next = new Set(prev);
      if (next.has(date)) {
        next.delete(date);
      } else {
        next.add(date);
      }
      return next;
    });
  };

  const handleRefresh = () => {
    Promise.all([fetchAttendance(), fetchRegisteredTotal()]).then(() => {
      setToast({ type: "success", message: "Attendance refreshed." });
    });
  };

  const handleExportCSV = () => {
    if (filtered.length === 0) {
      setToast({ type: "error", message: "No records to export." });
      return;
    }

    const header = ["Name", "Date", "In Time", "Out Time", "Status"].map(escapeCsvField).join(",");
    const rows = filtered.map((r) =>
      [r.name, r.date, r.in_time, r.out_time, r.status].map(escapeCsvField).join(",")
    );
    const csvContent = [header, ...rows].join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "attendance_export.csv";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    setToast({ type: "success", message: "Attendance exported successfully." });
  };

  const handleDownloadReport = () => {
    const isoDate = dateFilter || todayDateValue();
    const dateError = validateDate(isoDate, { label: "Date", allowFuture: false });

    if (dateError) {
      setToast({ type: "error", message: dateError });
      return;
    }

    const date = dateFilter ? toDDMMYYYY(dateFilter) : todayDDMMYYYY();

    setDownloading(true);

    axios
      .get(`http://localhost:5000/attendance/download/${date}`, { responseType: "blob" })
      .then((res) => {
        const blob = new Blob([res.data], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `report_${date}.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        setToast({ type: "success", message: `Report for ${date} downloaded.` });
      })
      .catch((err) => {
        console.error("Attendance Report Download Error :", err);
        setToast({ type: "error", message: `No report found for ${date}.` });
      })
      .finally(() => {
        setDownloading(false);
      });
  };

  return (
    <div>
      <PageHeader
        eyebrow="Records"
        title="Attendance"
        description="Automated check-in and check-out logs captured via facial recognition."
        actions={
          <>
            <UserScopeSelector />
            <Button icon={RefreshCw} variant="secondary" onClick={handleRefresh} disabled={loading}>
              Refresh
            </Button>
            <Button icon={FileDown} variant="secondary" onClick={handleExportCSV}>
              Export CSV
            </Button>
            <Button icon={FileDown} onClick={handleDownloadReport} disabled={downloading}>
              {downloading ? "Downloading…" : "Download Report"}
            </Button>
          </>
        }
      />

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Total Attendance" value={loading ? "—" : registeredTotal} delta="Registered Persons" icon="Users" tone="cyan" />
        <StatCard label="Present" value={loading ? "—" : presentCount} delta="Marked Present" icon="UserCheck" tone="green" />
        <StatCard label="Absent" value={loading ? "—" : absentCount} delta="Marked Absent" icon="UserX" tone="amber" />
      </div>

      <GlassCard className="p-4 sm:p-5">
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
          <SearchInput value={query} onChange={setQuery} placeholder="Search by name…" className="sm:w-64" />
          <input
            type="date"
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value)}
            max={todayDateValue()}
            className="rounded-xl glass px-3.5 py-2.5 text-sm text-ink-100 outline-none focus:border-accent-cyan/50 focus:ring-2 focus:ring-accent-cyan/20 [color-scheme:dark]"
          />
          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            options={[
              { value: "", label: "All Statuses" },
              { value: "Present", label: "Present" },
              { value: "Absent", label: "Absent" },
            ]}
            placeholder="All Statuses"
            className="w-full sm:w-44"
          />
          {(query || dateFilter || statusFilter) && (
            <button
              onClick={() => {
                setQuery("");
                setDateFilter("");
                setStatusFilter("");
              }}
              className="text-xs font-medium text-accent-cyan hover:underline sm:ml-auto"
            >
              Clear filters
            </button>
          )}
          <p className="font-mono text-xs text-ink-500 sm:ml-auto">
            {loading ? "Loading…" : `${filtered.length} records`}
          </p>
        </div>

        {loading && (
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-ink-500">
            <Loader2 size={22} className="animate-spin" />
            <p className="text-xs">Loading attendance records…</p>
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
            <table className="w-full min-w-[640px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-white/8 text-xs uppercase tracking-wide text-ink-500">
                  <th className="px-3 py-3 font-medium">Name</th>
                  <th className="px-3 py-3 font-medium">Date</th>
                  <th className="px-3 py-3 font-medium">In Time</th>
                  <th className="px-3 py-3 font-medium">Out Time</th>
                  <th className="px-3 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {groupedByDate.map(([date, rows]) => {
                  const isCollapsed = collapsedDates.has(date);
                  return (
                    <Fragment key={date}>
                      <tr className="border-b border-white/8 bg-white/[0.02]">
                        <td colSpan={5} className="px-3 py-2.5">
                          <button
                            type="button"
                            onClick={() => toggleDateGroup(date)}
                            className="flex w-full items-center gap-2 text-left"
                          >
                            <ChevronDown
                              size={14}
                              className={`shrink-0 text-ink-500 transition-transform ${isCollapsed ? "-rotate-90" : ""}`}
                            />
                            <span className="font-mono text-xs font-medium text-ink-100">{date}</span>
                            <span className="font-mono text-[11px] text-ink-500">
                              (Today's Attendance: {rows.length})
                            </span>
                          </button>
                        </td>
                      </tr>

                      {!isCollapsed &&
                        rows.map((r) => (
                          <tr key={`${r.name}-${r.date}`} className="border-b border-white/5 hover:bg-white/[0.03] transition">
                            <td className="px-3 py-3 font-medium text-ink-100">{r.name}</td>
                            <td className="px-3 py-3 font-mono text-xs text-ink-400">{r.date}</td>
                            <td className="px-3 py-3 font-mono text-xs text-ink-400">{r.in_time}</td>
                            <td className="px-3 py-3 font-mono text-xs text-ink-400">{r.out_time}</td>
                            <td className="px-3 py-3">
                              <StatusBadge status={r.status} />
                            </td>
                          </tr>
                        ))}
                    </Fragment>
                  );
                })}

                {filtered.length === 0 && records.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-16 text-center text-ink-500">
                      <div className="flex flex-col items-center gap-2">
                        <ClipboardList size={22} />
                        <p>No attendance records yet.</p>
                      </div>
                    </td>
                  </tr>
                )}

                {filtered.length === 0 && records.length > 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-12 text-center text-ink-500">
                      No attendance records match your filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </GlassCard>

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
