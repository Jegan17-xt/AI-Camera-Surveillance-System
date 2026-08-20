import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import axios from "axios";
import {
  ArrowLeft,
  UserRound,
  Loader2,
  AlertTriangle,
  Camera,
  CalendarCheck,
  UserX,
  Video,
  FileText,
  HardDrive,
  Info,
} from "lucide-react";
import AdminPageHeader from "../ui/AdminPageHeader";
import AdminCard from "../ui/AdminCard";
import AdminButton from "../ui/AdminButton";
import AdminBadge from "../ui/AdminBadge";

// MB below 1 GB, GB above — same real, server-computed byte figures
// either way (Backend/api/admin_overview.py), just the more readable
// unit for whichever this user's numbers land in.
const formatSize = (gb) => {
  const value = gb ?? 0;
  return value < 1 ? `${(value * 1024).toFixed(1)} MB` : `${value.toFixed(2)} GB`;
};

export default function AdminOverviewUserDetail() {
  const { id, userId } = useParams();
  const navigate = useNavigate();

  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);

    axios
      .get(`http://localhost:5000/admin-overview/companies/${id}/users/${userId}`)
      .then((res) => setDetail(res.data))
      .catch((err) => {
        console.error("User Storage Overview API Error :", err);
        setError("Unable to load this User's storage overview. Please check the server and try again.");
      })
      .finally(() => setLoading(false));
  }, [id, userId]);

  const categories = detail
    ? [
        {
          key: "registered_persons",
          label: "Registered Persons",
          icon: Camera,
          count: detail.registered_persons.count,
          gb: detail.registered_persons.gb,
        },
        {
          key: "attendance",
          label: "Attendance",
          icon: CalendarCheck,
          count: detail.attendance.count,
          gb: detail.attendance.gb_estimated,
          note: detail.attendance.note,
          estimated: true,
        },
        {
          key: "unknown_persons",
          label: "Unknown Persons",
          icon: UserX,
          count: detail.unknown_persons.count,
          gb: detail.unknown_persons.gb,
        },
        {
          key: "reports",
          label: "Reports",
          icon: FileText,
          count: detail.reports.count,
          gb: detail.reports.gb,
        },
      ]
    : [];

  return (
    <div>
      <AdminPageHeader
        eyebrow="Admin & User Overview"
        title="User Storage Overview"
        description="Exactly what's consuming this User's storage, broken down by category."
        actions={
          <AdminButton variant="ghost" icon={ArrowLeft} onClick={() => navigate(`/super-admin/admin-overview/${id}`)}>
            Back to Admin
          </AdminButton>
        }
      />

      {loading && (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-ink-500">
          <Loader2 size={22} className="animate-spin text-admin-accent" />
          <p className="text-xs">Loading user overview…</p>
        </div>
      )}

      {!loading && error && (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center text-ink-500">
          <AlertTriangle size={22} className="text-red-400" />
          <p className="text-xs">{error}</p>
        </div>
      )}

      {!loading && !error && detail && (
        <>
          <AdminCard className="p-4 sm:p-5">
            <div className="mb-4 flex items-center justify-between gap-3 border-b border-white/5 pb-4">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-white/[0.04] text-admin-accent">
                  <UserRound size={20} strokeWidth={2} />
                </div>
                <div>
                  <p className="font-display text-lg font-semibold text-white">{detail.name}</p>
                  <p className="text-xs text-ink-500">{detail.email}</p>
                </div>
              </div>
              <AdminBadge status={detail.status} />
            </div>

            <div className="flex flex-wrap items-end gap-6">
              <div>
                <p className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-ink-500">
                  <HardDrive size={12} /> Total Storage Used
                </p>
                <p className="mt-1 font-mono text-lg font-semibold text-ink-100">{formatSize(detail.total_gb)}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-ink-500">Remaining</p>
                <p className="mt-1 font-mono text-sm text-ink-500">
                  — <span className="text-[11px]">(quotas are set at the company level, see Admin Overview)</span>
                </p>
              </div>
            </div>
          </AdminCard>

          <p className="mb-3 mt-6 text-xs font-medium uppercase tracking-wide text-ink-500">Storage by Category</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {categories.map((cat) => {
              const Icon = cat.icon;
              const pct = detail.total_gb > 0 ? Math.min(100, (cat.gb / detail.total_gb) * 100) : 0;

              return (
                <AdminCard key={cat.key} className="p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <p className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-ink-500">
                      <Icon size={13} /> {cat.label}
                    </p>
                    <span className="font-mono text-xs text-ink-500">{cat.count}</span>
                  </div>
                  <p className="font-mono text-lg font-semibold text-ink-100">
                    {cat.noStorage ? "—" : (cat.estimated ? "~" : "") + formatSize(cat.gb)}
                  </p>
                  {!cat.noStorage && (
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/5">
                      <div className="h-full rounded-full bg-admin-accent" style={{ width: `${pct}%` }} />
                    </div>
                  )}
                  {cat.note && (
                    <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-snug text-ink-500">
                      <Info size={11} className="mt-0.5 shrink-0" /> {cat.note}
                    </p>
                  )}
                </AdminCard>
              );
            })}
          </div>

          {/* Camera Limit / Camera Quota Management — this User's own
              Admin-set cap, separate from the storage categories above
              since it's limit/remaining/status, not count/GB. Editing
              stays on the Admin's own User Management page (Company-
              Admin-only); this is read-only, same "quotas are set at the
              company/admin level" convention as the top card's Storage
              Remaining note. */}
          {detail.camera_quota && (
            <>
              <p className="mb-3 mt-6 text-xs font-medium uppercase tracking-wide text-ink-500">Camera Quota</p>
              <AdminCard className="p-4 sm:p-5">
                <div className="flex flex-wrap items-end gap-6">
                  <div>
                    <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-ink-500">
                      <Video size={11} /> Used
                    </p>
                    <p className="mt-1 font-mono text-sm text-ink-100">{detail.camera_quota.used}</p>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-ink-500">Limit</p>
                    <p className="mt-1 font-mono text-sm text-ink-100">
                      {detail.camera_quota.camera_limit === null ? "Unlimited" : detail.camera_quota.camera_limit}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-ink-500">Remaining</p>
                    <p className="mt-1 font-mono text-sm text-ink-100">
                      {detail.camera_quota.camera_limit === null ? "Unlimited" : detail.camera_quota.remaining}
                    </p>
                  </div>
                  {detail.camera_quota.status === "Over Limit" && (
                    <span className="rounded-full border border-signal-red/30 bg-signal-red/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-signal-red">
                      Over Limit by {detail.camera_quota.over_limit_by}
                    </span>
                  )}
                </div>
                {detail.camera_quota.camera_limit !== null && (
                  <div className="mt-3 h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-white/5">
                    <div
                      className={`h-full rounded-full ${
                        detail.camera_quota.usage_percent >= 100
                          ? "bg-signal-red"
                          : detail.camera_quota.usage_percent >= 90
                          ? "bg-amber-400"
                          : "bg-admin-accent"
                      }`}
                      style={{ width: `${Math.min(100, detail.camera_quota.usage_percent)}%` }}
                    />
                  </div>
                )}
                <p className="mt-2.5 text-[11px] text-ink-600">{detail.cameras.note}</p>
              </AdminCard>
            </>
          )}

          {detail.registered_persons_list.length > 0 && (
            <>
              <p className="mb-3 mt-6 text-xs font-medium uppercase tracking-wide text-ink-500">
                Registered Persons — Detail
              </p>
              <AdminCard className="p-4 sm:p-5">
                <div className="custom-scroll overflow-x-auto">
                  <table className="w-full min-w-[480px] border-collapse text-left text-sm">
                    <thead>
                      <tr className="border-b border-admin-accent/10 text-xs uppercase tracking-wide text-ink-500">
                        <th className="px-3 py-3 font-medium">Name</th>
                        <th className="px-3 py-3 font-medium">Employee ID</th>
                        <th className="px-3 py-3 font-medium">Status</th>
                        <th className="px-3 py-3 font-medium">Storage</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.registered_persons_list.map((p) => (
                        <tr key={p.person_name} className="border-b border-white/5">
                          <td className="px-3 py-3 font-medium text-ink-100">{p.person_name}</td>
                          <td className="px-3 py-3 font-mono text-xs text-ink-400">{p.employee_id || "—"}</td>
                          <td className="px-3 py-3">
                            <AdminBadge status={p.status} />
                          </td>
                          <td className="px-3 py-3 font-mono text-xs text-ink-300">{formatSize(p.gb)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </AdminCard>
            </>
          )}
        </>
      )}
    </div>
  );
}
