import { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import {
  FileDown,
  FileText,
  CalendarDays,
  CalendarRange,
  Eye,
  RefreshCw,
  Loader2,
  AlertTriangle,
  FolderOpen,
} from "lucide-react";
import PageHeader from "../components/ui/PageHeader";
import GlassCard from "../components/ui/GlassCard";
import Button from "../components/ui/Button";
import SearchInput from "../components/ui/SearchInput";
import Modal from "../components/ui/Modal";
import StatusBadge from "../components/ui/StatusBadge";
import Toast from "../components/ui/Toast";
import UserScopeSelector from "../components/ui/UserScopeSelector";
import { useSelectedUser } from "../context/SelectedUserContext";
import { DATA_EVENTS, useDataEvent } from "../lib/dataEvents";
import { validateDate, validateMonth, todayDateValue, currentMonthValue } from "../lib/validation";

const isoDateToDDMMYYYY = (isoDate) => {
  if (!isoDate) return "";
  const [year, month, day] = isoDate.split("-");
  return `${day}-${month}-${year}`;
};

const readErrorMessage = (err, fallback) => {
  const data = err.response?.data;

  if (!(data instanceof Blob)) {
    return Promise.resolve(data?.message || fallback);
  }

  return data
    .text()
    .then((text) => JSON.parse(text)?.message || fallback)
    .catch(() => fallback);
};

export default function Reports() {
  const { selectedUserId } = useSelectedUser();
  const [query, setQuery] = useState("");

  const [reports, setReports] = useState([]);
  const [totalReports, setTotalReports] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [viewTarget, setViewTarget] = useState(null);
  const [viewRecords, setViewRecords] = useState([]);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewError, setViewError] = useState(null);

  const [downloadingFile, setDownloadingFile] = useState(null);

  const dailyDateRef = useRef(null);
  const monthRef = useRef(null);
  const [exportingDaily, setExportingDaily] = useState({ csv: false, pdf: false });
  const [exportingMonthly, setExportingMonthly] = useState({ csv: false, pdf: false });

  const fetchReports = () => {
    setLoading(true);
    setError(null);

    return axios
      .get("http://localhost:5000/reports", {
        params: selectedUserId !== null ? { user_id: selectedUserId } : undefined,
      })
      .then((res) => {
        setReports(res.data.reports || []);
        setTotalReports(res.data.total_reports ?? (res.data.reports || []).length);
      })
      .catch((err) => {
        console.error("Reports API Error :", err);
        setError("Unable to load reports. Please check the server and try again.");
      })
      .finally(() => {
        setLoading(false);
      });
  };

  useEffect(() => {
    fetchReports();
  }, [selectedUserId]);

  // New reports are generated as a side-effect of attendance being
  // recorded (or invalidated by clearing attendance logs from
  // Settings) — refresh this list whenever either happens.
  useDataEvent([DATA_EVENTS.ATTENDANCE_CHANGED, DATA_EVENTS.REPORTS_CHANGED], fetchReports);

  const filtered = useMemo(
    () => reports.filter((r) => r.date.toLowerCase().includes(query.trim().toLowerCase())),
    [reports, query]
  );

  const handleRefresh = () => {
    fetchReports().then(() => {
      setToast({ type: "success", message: "Reports refreshed." });
    });
  };

  const handleView = (report) => {
    setViewTarget(report);
    setViewRecords([]);
    setViewError(null);
    setViewLoading(true);

    axios
      .get(`http://localhost:5000/reports/view/${encodeURIComponent(report.file_name)}`, {
        params: selectedUserId !== null ? { user_id: selectedUserId } : undefined,
      })
      .then((res) => {
        setViewRecords(res.data.records || []);
      })
      .catch((err) => {
        console.error("Report View API Error :", err);
        setViewError("Unable to load this report's records.");
      })
      .finally(() => {
        setViewLoading(false);
      });
  };

  const handleDownload = (report) => {
    setDownloadingFile(report.file_name);

    axios
      .get(`http://localhost:5000/reports/download/${encodeURIComponent(report.file_name)}`, {
        responseType: "blob",
      })
      .then((res) => {
        const blob = new Blob([res.data], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = report.file_name;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        setToast({ type: "success", message: `${report.file_name} downloaded.` });
      })
      .catch((err) => {
        console.error("Report Download API Error :", err);
        setToast({ type: "error", message: `Failed to download ${report.file_name}.` });
      })
      .finally(() => {
        setDownloadingFile(null);
      });
  };

  const handleExport = (format, scope) => {
    let label;
    const params = new URLSearchParams();

    if (scope === "daily") {
      const isoDate = dailyDateRef.current?.value;
      const dateError = validateDate(isoDate, { label: "Date", allowFuture: false });
      if (dateError) {
        setToast({ type: "error", message: dateError });
        return;
      }
      label = isoDateToDDMMYYYY(isoDate);
      params.set("date", label);
    } else {
      const month = monthRef.current?.value;
      const monthError = validateMonth(month, { label: "Month", allowFuture: false });
      if (monthError) {
        setToast({ type: "error", message: monthError });
        return;
      }
      label = month;
      params.set("month", month);
    }

    if (selectedUserId !== null) {
      params.set("user_id", selectedUserId);
    }

    const setExporting = scope === "daily" ? setExportingDaily : setExportingMonthly;
    setExporting((prev) => ({ ...prev, [format]: true }));

    axios
      .get(`http://localhost:5000/attendance/export/${format}?${params.toString()}`, {
        responseType: "blob",
      })
      .then((res) => {
        const blob = new Blob([res.data], {
          type: format === "csv" ? "text/csv;charset=utf-8;" : "application/pdf",
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `attendance_report_${label}.${format}`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        setToast({ type: "success", message: `Attendance report (${label}) exported.` });
      })
      .catch((err) => {
        console.error("Attendance Export API Error :", err);
        readErrorMessage(err, `Failed to export ${format.toUpperCase()}.`).then((message) => {
          setToast({ type: "error", message });
        });
      })
      .finally(() => {
        setExporting((prev) => ({ ...prev, [format]: false }));
      });
  };

  return (
    <div>
      <PageHeader
        eyebrow="Analytics"
        title="Reports"
        description="Generate and export attendance and detection reports."
        actions={<UserScopeSelector />}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <GlassCard className="p-5">
          <div className="mb-3 flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-cyan/10 text-accent-cyan">
              <CalendarDays size={19} />
            </span>
            <div>
              <p className="font-display text-sm font-semibold text-white">Daily Report</p>
              <p className="text-xs text-ink-500">Attendance &amp; detections for a single day</p>
            </div>
          </div>
          <input
            type="date"
            ref={dailyDateRef}
            defaultValue="2026-07-23"
            max={todayDateValue()}
            className="mb-4 w-full rounded-xl glass px-3.5 py-2.5 text-sm text-ink-100 outline-none focus:border-accent-cyan/50 focus:ring-2 focus:ring-accent-cyan/20 [color-scheme:dark]"
          />
          <div className="flex gap-3">
            <Button icon={FileDown} className="flex-1" onClick={() => handleExport("csv", "daily")} disabled={exportingDaily.csv}>
              CSV
            </Button>
            <Button icon={FileText} variant="secondary" className="flex-1" onClick={() => handleExport("pdf", "daily")} disabled={exportingDaily.pdf}>
              PDF
            </Button>
          </div>
        </GlassCard>

        <GlassCard className="p-5">
          <div className="mb-3 flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-blue/10 text-accent-blue">
              <CalendarRange size={19} />
            </span>
            <div>
              <p className="font-display text-sm font-semibold text-white">Monthly Report</p>
              <p className="text-xs text-ink-500">Aggregated summary across the full month</p>
            </div>
          </div>
          <input
            type="month"
            ref={monthRef}
            defaultValue="2026-07"
            max={currentMonthValue()}
            className="mb-4 w-full rounded-xl glass px-3.5 py-2.5 text-sm text-ink-100 outline-none focus:border-accent-cyan/50 focus:ring-2 focus:ring-accent-cyan/20 [color-scheme:dark]"
          />
          <div className="flex gap-3">
            <Button icon={FileDown} className="flex-1" onClick={() => handleExport("csv", "monthly")} disabled={exportingMonthly.csv}>
              CSV
            </Button>
            <Button icon={FileText} variant="secondary" className="flex-1" onClick={() => handleExport("pdf", "monthly")} disabled={exportingMonthly.pdf}>
              PDF
            </Button>
          </div>
        </GlassCard>
      </div>

      <GlassCard className="mt-4 p-4 sm:p-5">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h3 className="font-display text-sm font-semibold text-white">Attendance Reports</h3>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <SearchInput value={query} onChange={setQuery} placeholder="Search by date (DD-MM-YYYY)…" className="w-full flex-1 sm:w-80" />
            <Button icon={RefreshCw} variant="secondary" onClick={handleRefresh} disabled={loading} className="!py-2.5">
              Refresh
            </Button>
          </div>
        </div>

        {loading && (
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-ink-500">
            <Loader2 size={22} className="animate-spin" />
            <p className="text-xs">Loading reports…</p>
          </div>
        )}

        {!loading && error && (
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-center text-ink-500">
            <AlertTriangle size={22} className="text-red-400" />
            <p className="text-xs">{error}</p>
          </div>
        )}

        {!loading && !error && (
          <>
            <p className="mb-3 font-mono text-xs text-ink-500">
              {filtered.length} of {totalReports} reports
            </p>

            <div className="custom-scroll overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-white/8 text-xs uppercase tracking-wide text-ink-500">
                    <th className="px-3 py-3 font-medium">Report Date</th>
                    <th className="px-3 py-3 font-medium">File Name</th>
                    <th className="px-3 py-3 font-medium">Total Records</th>
                    <th className="px-3 py-3 font-medium">Present</th>
                    <th className="px-3 py-3 font-medium">Absent</th>
                    <th className="px-3 py-3 font-medium">Created Time</th>
                    <th className="px-3 py-3 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <tr key={r.file_name} className="border-b border-white/5 hover:bg-white/[0.03] transition">
                      <td className="px-3 py-3 font-medium text-ink-100">{r.date}</td>
                      <td className="px-3 py-3 font-mono text-xs text-ink-400">{r.file_name}</td>
                      <td className="px-3 py-3 font-mono text-xs text-ink-400">{r.total_records}</td>
                      <td className="px-3 py-3 font-mono text-xs text-signal-green">{r.present}</td>
                      <td className="px-3 py-3 font-mono text-xs text-signal-red">{r.absent}</td>
                      <td className="px-3 py-3 font-mono text-xs text-ink-400">{r.created_time}</td>
                      <td className="px-3 py-3 text-right">
                        <div className="inline-flex gap-2">
                          <button
                            onClick={() => handleView(r)}
                            className="rounded-lg p-2 text-ink-400 hover:bg-white/5 hover:text-accent-cyan"
                            title="View Report"
                          >
                            <Eye size={16} />
                          </button>
                          <button
                            onClick={() => handleDownload(r)}
                            disabled={downloadingFile === r.file_name}
                            className="rounded-lg p-2 text-ink-400 hover:bg-white/5 hover:text-accent-cyan disabled:opacity-50"
                            title="Download CSV"
                          >
                            {downloadingFile === r.file_name ? (
                              <Loader2 size={16} className="animate-spin" />
                            ) : (
                              <FileDown size={16} />
                            )}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}

                  {reports.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-3 py-16 text-center text-ink-500">
                        <div className="flex flex-col items-center gap-2">
                          <FolderOpen size={22} />
                          <p>No reports have been generated yet.</p>
                        </div>
                      </td>
                    </tr>
                  )}

                  {reports.length > 0 && filtered.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-3 py-12 text-center text-ink-500">
                        No reports match “{query}”.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </GlassCard>

      <Modal
        open={!!viewTarget}
        onClose={() => setViewTarget(null)}
        title={viewTarget ? `Report — ${viewTarget.date}` : "Report"}
      >
        {viewLoading && (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-ink-500">
            <Loader2 size={20} className="animate-spin" />
            <p className="text-xs">Loading records…</p>
          </div>
        )}

        {!viewLoading && viewError && (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center text-ink-500">
            <AlertTriangle size={20} className="text-red-400" />
            <p className="text-xs">{viewError}</p>
          </div>
        )}

        {!viewLoading && !viewError && (
          <div className="custom-scroll max-h-[60vh] overflow-x-auto overflow-y-auto">
            <table className="w-full min-w-[480px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-white/8 text-xs uppercase tracking-wide text-ink-500">
                  <th className="px-3 py-2.5 font-medium">Name</th>
                  <th className="px-3 py-2.5 font-medium">Date</th>
                  <th className="px-3 py-2.5 font-medium">In Time</th>
                  <th className="px-3 py-2.5 font-medium">Out Time</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {viewRecords.map((rec) => (
                  <tr key={`${rec.name}-${rec.date}`} className="border-b border-white/5">
                    <td className="px-3 py-2.5 font-medium text-ink-100">{rec.name}</td>
                    <td className="px-3 py-2.5 font-mono text-xs text-ink-400">{rec.date}</td>
                    <td className="px-3 py-2.5 font-mono text-xs text-ink-400">{rec.in_time}</td>
                    <td className="px-3 py-2.5 font-mono text-xs text-ink-400">{rec.out_time}</td>
                    <td className="px-3 py-2.5">
                      <StatusBadge status={rec.status} />
                    </td>
                  </tr>
                ))}

                {viewRecords.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-10 text-center text-ink-500">
                      No attendance records found for this date.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Modal>

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
