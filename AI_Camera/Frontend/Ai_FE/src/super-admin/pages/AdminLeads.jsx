import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { RefreshCw, Loader2, AlertTriangle, UserPlus, Trash2, Phone, Mail, MapPin, Globe, MessageSquare, ExternalLink } from "lucide-react";
import AdminPageHeader from "../ui/AdminPageHeader";
import AdminSearchInput from "../ui/AdminSearchInput";
import AdminCard from "../ui/AdminCard";
import AdminButton from "../ui/AdminButton";
import AdminModal from "../ui/AdminModal";
import AdminToast from "../ui/AdminToast";
import { API_BASE_URL } from "../../lib/apiBase";

export default function AdminLeads() {
  const [query, setQuery] = useState("");
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const fetchLeads = () => {
    setLoading(true);
    setError(null);

    return axios
      .get(`${API_BASE_URL}/leads`)
      .then((res) => setLeads(res.data.leads || []))
      .catch((err) => {
        console.error("Leads API Error :", err);
        setError("Unable to load leads.");
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchLeads();
  }, []);

  const filtered = useMemo(
    () =>
      leads.filter((l) => {
        const q = query.toLowerCase();
        return (
          l.name.toLowerCase().includes(q) ||
          l.phone.toLowerCase().includes(q) ||
          (l.address || "").toLowerCase().includes(q) ||
          (l.email || "").toLowerCase().includes(q) ||
          (l.source || "").toLowerCase().includes(q)
        );
      }),
    [leads, query]
  );

  // "Landing Page" (the Interest & Lead popup) or "Contact Page" (the
  // Contact section form) — see api/leads.py's create_lead(). Any
  // pre-existing row from before `source` existed backfills to
  // "Landing Page" (the only source there was then), so this always
  // has a value to render.
  const SOURCE_STYLE = {
    "Landing Page": { icon: Globe, className: "border-admin-accent/25 bg-admin-accent/10 text-admin-accent" },
    "Contact Page": { icon: MessageSquare, className: "border-sky-400/25 bg-sky-400/10 text-sky-300" },
  };

  const handleConfirmDelete = () => {
    if (!deleteTarget) return;

    setDeleting(true);

    axios
      .delete(`${API_BASE_URL}/leads/${deleteTarget.id}`)
      .then(() => {
        setToast({ type: "success", message: "Lead deleted." });
        setDeleteTarget(null);
        return fetchLeads();
      })
      .catch((err) => {
        setToast({ type: "error", message: err.response?.data?.message || "Failed to delete lead." });
      })
      .finally(() => setDeleting(false));
  };

  return (
    <div>
      <AdminPageHeader
        eyebrow="Landing Page"
        title="Leads"
        description="Interested visitors who submitted their details from the public landing page — either the Interest & Lead popup or the Contact section form."
        actions={
          <AdminButton icon={RefreshCw} variant="secondary" onClick={fetchLeads} disabled={loading} className="whitespace-nowrap">
            Refresh
          </AdminButton>
        }
      />

      <AdminCard className="p-4 sm:p-5">
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <AdminSearchInput value={query} onChange={setQuery} placeholder="Search by name, phone, email, address, source…" className="sm:w-80" />
          <p className="font-mono text-xs text-ink-500">
            {loading ? "Loading…" : `${filtered.length} of ${leads.length} leads`}
          </p>
        </div>

        {loading && (
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-ink-500">
            <Loader2 size={22} className="animate-spin text-admin-accent" />
            <p className="text-xs">Loading leads…</p>
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
            <table className="w-full min-w-[1120px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-admin-accent/10 text-xs uppercase tracking-wide text-ink-500">
                  <th className="px-3 py-3 font-medium">Name</th>
                  <th className="px-3 py-3 font-medium">Phone</th>
                  <th className="px-3 py-3 font-medium">Email</th>
                  <th className="px-3 py-3 font-medium">Address</th>
                  <th className="px-3 py-3 font-medium">Source</th>
                  <th className="px-3 py-3 font-medium">Location</th>
                  <th className="px-3 py-3 font-medium">Date &amp; Time</th>
                  <th className="px-3 py-3 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((lead) => (
                  <tr key={lead.id} className="border-b border-white/5 hover:bg-white/[0.03] transition">
                    <td className="px-3 py-3 font-medium text-ink-100">{lead.name}</td>
                    <td className="px-3 py-3 text-ink-300">
                      <span className="inline-flex items-center gap-1.5">
                        <Phone size={12} className="text-ink-500" />
                        {lead.phone}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-ink-300">
                      {lead.email ? (
                        <span className="inline-flex items-center gap-1.5">
                          <Mail size={12} className="text-ink-500" />
                          {lead.email}
                        </span>
                      ) : (
                        <span className="text-ink-600">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3 max-w-[220px] text-ink-300">
                      {lead.address ? (
                        <span className="inline-flex items-start gap-1.5">
                          <MapPin size={12} className="mt-0.5 shrink-0 text-ink-500" />
                          <span className="truncate">{lead.address}</span>
                        </span>
                      ) : (
                        <span className="text-ink-600">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      {(() => {
                        const style = SOURCE_STYLE[lead.source] || SOURCE_STYLE["Landing Page"];
                        const SourceIcon = style.icon;
                        return (
                          <span
                            className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-medium ${style.className}`}
                          >
                            <SourceIcon size={12} />
                            {lead.source || "Landing Page"}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="px-3 py-3">
                      {lead.latitude != null && lead.longitude != null ? (
                        <a
                          href={`https://www.google.com/maps/search/?api=1&query=${lead.latitude},${lead.longitude}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-admin-accent hover:underline"
                        >
                          <MapPin size={12} />
                          View on Google Maps
                          <ExternalLink size={11} />
                        </a>
                      ) : (
                        <span className="text-xs text-ink-600">Location unavailable</span>
                      )}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap font-mono text-xs text-ink-500">{lead.created_at}</td>
                    <td className="px-3 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(lead)}
                        className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-signal-red/80 hover:bg-signal-red/10 hover:text-signal-red transition"
                      >
                        <Trash2 size={13} />
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}

                {leads.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-3 py-16 text-center text-ink-500">
                      <div className="flex flex-col items-center gap-2">
                        <UserPlus size={22} />
                        <p>No leads have been submitted yet.</p>
                      </div>
                    </td>
                  </tr>
                )}

                {leads.length > 0 && filtered.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-3 py-12 text-center text-ink-500">
                      No leads match "{query}".
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </AdminCard>

      <AdminModal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Delete Lead?">
        <p className="text-sm text-ink-300">
          Are you sure you want to delete this lead? This action cannot be undone.
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

      <AdminToast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
