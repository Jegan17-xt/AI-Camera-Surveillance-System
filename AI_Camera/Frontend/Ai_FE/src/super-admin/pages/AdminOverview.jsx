import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import { Loader2, AlertTriangle, HardDrive, Video, UserRound, Boxes, ChevronRight } from "lucide-react";
import AdminPageHeader from "../ui/AdminPageHeader";
import AdminSearchInput from "../ui/AdminSearchInput";
import AdminCard from "../ui/AdminCard";
import AdminBadge from "../ui/AdminBadge";

// Read-only rollup, computed server-side from real DB rows and real
// files on disk (see Backend/api/admin_overview.py) — nothing here is
// hardcoded or estimated except attendance's own clearly-labeled
// proportional share, shown one level down on the Admin detail page.
export default function AdminOverview() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);

    axios
      .get("http://localhost:5000/admin-overview/companies")
      .then((res) => setCompanies(res.data.companies || []))
      .catch((err) => {
        console.error("Admin & User Overview API Error :", err);
        setError("Unable to load the Admin & User Overview. Please check the server and try again.");
      })
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return companies;
    return companies.filter(
      (c) => c.name?.toLowerCase().includes(q) || c.email?.toLowerCase().includes(q)
    );
  }, [companies, query]);

  const formatGb = (gb) => `${(gb ?? 0).toFixed(2)} GB`;

  return (
    <div>
      <AdminPageHeader
        eyebrow="Super Admin"
        title="Admin & User Overview"
        description="Real storage, camera, and user usage for every Company Admin — computed from the actual database and files on disk."
      />

      <div className="mb-5">
        <AdminSearchInput value={query} onChange={setQuery} placeholder="Search by admin name or email…" className="max-w-sm" />
      </div>

      {loading && (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-ink-500">
          <Loader2 size={22} className="animate-spin text-admin-accent" />
          <p className="text-xs">Loading admin overview…</p>
        </div>
      )}

      {!loading && error && (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center text-ink-500">
          <AlertTriangle size={22} className="text-red-400" />
          <p className="text-xs">{error}</p>
        </div>
      )}

      {!loading && !error && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {filtered.map((c) => {
            const hasLimit = c.storage_limit_gb !== null && c.storage_limit_gb !== undefined;
            const pct = hasLimit && c.storage_limit_gb > 0
              ? Math.min(100, (c.storage_used_gb / c.storage_limit_gb) * 100)
              : null;

            return (
              <AdminCard
                key={c.customer_id}
                className="cursor-pointer p-4 transition hover:border-admin-accent/40 sm:p-5"
                onClick={() => navigate(`/super-admin/admin-overview/${c.customer_id}`)}
              >
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div>
                    <p className="font-display text-base font-semibold text-white">{c.name}</p>
                    <p className="text-xs text-ink-500">{c.email}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <AdminBadge status={c.status} />
                    <ChevronRight size={16} className="text-ink-500" />
                  </div>
                </div>

                <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div>
                    <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-ink-500">
                      <Video size={12} /> Cameras
                    </p>
                    <p className="mt-1 font-mono text-sm text-ink-100">{c.camera_count}</p>
                  </div>
                  <div>
                    <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-ink-500">
                      <UserRound size={12} /> Users
                    </p>
                    <p className="mt-1 font-mono text-sm text-ink-100">{c.user_count}</p>
                  </div>
                  <div>
                    <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-ink-500">
                      <Boxes size={12} /> Modules
                    </p>
                    <p className="mt-1 font-mono text-sm text-ink-100">{c.modules_enabled?.length ?? 0}</p>
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between text-[11px] uppercase tracking-wide text-ink-500">
                    <span className="flex items-center gap-1.5">
                      <HardDrive size={12} /> Storage
                    </span>
                    <span className="font-mono text-ink-300">
                      {formatGb(c.storage_used_gb)} {hasLimit ? `/ ${formatGb(c.storage_limit_gb)}` : "(Unlimited)"}
                    </span>
                  </div>
                  {pct !== null && (
                    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/5">
                      <div
                        className={`h-full rounded-full ${pct >= 90 ? "bg-signal-red" : "bg-admin-accent"}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  )}
                </div>

                {/* Camera Limit / Camera Quota Management */}
                {c.camera_quota && (
                  <div className="mt-3">
                    <div className="flex items-center justify-between text-[11px] uppercase tracking-wide text-ink-500">
                      <span className="flex items-center gap-1.5">
                        <Video size={12} /> Camera Quota
                      </span>
                      <span className={`font-mono ${c.camera_quota.status === "Over Limit" ? "text-signal-red" : "text-ink-300"}`}>
                        {c.camera_quota.used} {c.camera_quota.camera_limit === null ? "(Unlimited)" : `/ ${c.camera_quota.camera_limit}`}
                        {c.camera_quota.status === "Over Limit" && " · Over Limit"}
                      </span>
                    </div>
                    {c.camera_quota.camera_limit !== null && (
                      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/5">
                        <div
                          className={`h-full rounded-full ${c.camera_quota.usage_percent >= 100 ? "bg-signal-red" : c.camera_quota.usage_percent >= 90 ? "bg-amber-400" : "bg-admin-accent"}`}
                          style={{ width: `${Math.min(100, c.camera_quota.usage_percent)}%` }}
                        />
                      </div>
                    )}
                  </div>
                )}
              </AdminCard>
            );
          })}

          {filtered.length === 0 && (
            <div className="col-span-full flex flex-col items-center justify-center gap-2 py-16 text-center text-ink-500">
              <Boxes size={22} />
              <p>No Company Admins match this search.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
