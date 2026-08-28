import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { Network, Plus, Pencil, Trash2, Users as UsersIcon, RefreshCw, Loader2, AlertTriangle } from "lucide-react";
import PageHeader from "../../components/ui/PageHeader";
import SearchInput from "../../components/ui/SearchInput";
import Button from "../../components/ui/Button";
import GlassCard from "../../components/ui/GlassCard";
import StatusBadge from "../../components/ui/StatusBadge";
import Modal from "../../components/ui/Modal";
import Toast from "../../components/ui/Toast";
import { useSelectedUser } from "../../context/SelectedUserContext";
import { API_BASE_URL } from "../../lib/apiBase";
import {
  validateTextField,
  validateIPv4,
  hasNoErrors,
  INVALID_INPUT_CLASS,
} from "../../lib/validation";

// Site / VPN Gateway Management — Company Admin only (see
// constants/modules.js COMPANY_ADMIN_ONLY_MODULES / Backend/api/
// company_users.py's GRANTABLE_USER_MODULE_KEYS, which never grants a
// User the "site_management" module). A Site is purely a network/access
// grouping this app records (see Backend/api/sites.py's own docstring)
// — this page never opens, configures, or manages the real WireGuard
// tunnel itself, and never asks for a WireGuard PRIVATE key.
const emptyForm = {
  site_name: "",
  vpn_gateway_ip: "",
  camera_network: "",
  vpn_public_key: "",
};

const inputClass =
  "w-full rounded-xl glass px-3.5 py-2.5 text-sm text-ink-100 placeholder:text-ink-500 outline-none focus:border-accent-cyan/50 focus:ring-2 focus:ring-accent-cyan/20";

function FieldError({ error }) {
  if (!error) return null;
  return <p className="mt-1.5 text-xs text-red-400">{error}</p>;
}

// vpn_status from the backend is lowercase ("unknown" | "online" |
// "offline") — StatusBadge's tone map keys on the capitalized form
// ("Online"/"Offline") that every other status in this app already
// uses, so this just aligns the casing rather than teaching StatusBadge
// a second convention.
function formatVpnStatus(vpnStatus) {
  const value = vpnStatus || "unknown";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export default function SiteManagement() {
  const { users: companyUsers } = useSelectedUser();
  const [query, setQuery] = useState("");
  const [sites, setSites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const fetchSites = () => {
    setLoading(true);
    setError(null);

    return axios
      .get(`${API_BASE_URL}/company/sites`)
      .then((res) => setSites(res.data.sites || []))
      .catch((err) => {
        console.error("Company Sites API Error :", err);
        setError("Unable to load sites. Please check the server and try again.");
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchSites();
  }, []);

  const filtered = useMemo(
    () => sites.filter((s) => s.site_name.toLowerCase().includes(query.toLowerCase())),
    [sites, query]
  );

  // ---------------- Add / Edit ----------------

  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null); // null = Add
  const [form, setForm] = useState(emptyForm);
  const [touched, setTouched] = useState({});
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  const errors = {
    site_name: validateTextField(form.site_name, "Site Name", { minLen: 2, maxLen: 120 }),
    vpn_gateway_ip: validateIPv4(form.vpn_gateway_ip, "VPN Gateway IP"),
  };
  const isFormValid = hasNoErrors(errors);

  const openAdd = () => {
    setEditTarget(null);
    setForm(emptyForm);
    setTouched({});
    setFormError(null);
    setFormOpen(true);
  };

  const openEdit = (site) => {
    setEditTarget(site);
    setForm({
      site_name: site.site_name,
      vpn_gateway_ip: site.vpn_gateway_ip,
      camera_network: site.camera_network || "",
      vpn_public_key: site.vpn_public_key || "",
    });
    setTouched({});
    setFormError(null);
    setFormOpen(true);
  };

  const closeForm = () => {
    if (saving) return;
    setFormOpen(false);
  };

  const handleSave = (e) => {
    e.preventDefault();
    setTouched({ site_name: true, vpn_gateway_ip: true });
    if (!isFormValid) return;
    setFormError(null);
    setSaving(true);

    const payload = {
      site_name: form.site_name.trim(),
      vpn_gateway_ip: form.vpn_gateway_ip.trim(),
      camera_network: form.camera_network.trim(),
      vpn_public_key: form.vpn_public_key.trim(),
    };

    const request = editTarget
      ? axios.put(`${API_BASE_URL}/company/sites/${editTarget.site_id}`, payload)
      : axios.post(`${API_BASE_URL}/company/sites`, payload);

    request
      .then(() => {
        setToast({ type: "success", message: editTarget ? "Site updated successfully." : "Site added successfully." });
        setFormOpen(false);
        return fetchSites();
      })
      .catch((err) => {
        setFormError(err.response?.data?.message || "Failed to save site.");
      })
      .finally(() => setSaving(false));
  };

  // ---------------- Delete ----------------

  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const handleConfirmDelete = () => {
    if (!deleteTarget) return;
    setDeleting(true);

    axios
      .delete(`${API_BASE_URL}/company/sites/${deleteTarget.site_id}`)
      .then(() => {
        setToast({ type: "success", message: `${deleteTarget.site_name} deleted successfully.` });
        return fetchSites();
      })
      .catch((err) => setToast({ type: "error", message: err.response?.data?.message || `Failed to delete ${deleteTarget.site_name}.` }))
      .finally(() => {
        setDeleting(false);
        setDeleteTarget(null);
      });
  };

  // ---------------- Activate / Deactivate ----------------

  const [togglingId, setTogglingId] = useState(null);

  const handleToggleStatus = (site) => {
    setTogglingId(site.site_id);

    axios
      .put(`${API_BASE_URL}/company/sites/${site.site_id}/status`, {
        status: site.status === "Active" ? "Inactive" : "Active",
      })
      .then(() => fetchSites())
      .catch(() => setToast({ type: "error", message: `Failed to update status for ${site.site_name}.` }))
      .finally(() => setTogglingId(null));
  };

  // ---------------- Check VPN Status ----------------
  // Best-effort gateway/network reachability only — see Backend/api/
  // sites.py's check_site_status. Never a WireGuard handshake.

  const [checkingId, setCheckingId] = useState(null);

  const handleCheckStatus = (site) => {
    setCheckingId(site.site_id);

    axios
      .post(`${API_BASE_URL}/company/sites/${site.site_id}/check-status`)
      .then(() => fetchSites())
      .catch(() => setToast({ type: "error", message: `Failed to check status for ${site.site_name}.` }))
      .finally(() => setCheckingId(null));
  };

  // ---------------- Manage Access ----------------

  const [accessTarget, setAccessTarget] = useState(null);
  const [accessLoading, setAccessLoading] = useState(false);
  const [accessUsers, setAccessUsers] = useState([]); // [{id, name, email, has_access}]
  const [accessSaving, setAccessSaving] = useState(false);

  const openAccess = (site) => {
    setAccessTarget(site);
    setAccessUsers([]);
    setAccessLoading(true);

    axios
      .get(`${API_BASE_URL}/company/sites/${site.site_id}/access`)
      .then((res) => setAccessUsers(res.data.users || []))
      .catch(() => {
        setToast({ type: "error", message: "Unable to load user access for this site." });
        setAccessTarget(null);
      })
      .finally(() => setAccessLoading(false));
  };

  const toggleAccessUser = (userId) => {
    setAccessUsers((list) => list.map((u) => (u.id === userId ? { ...u, has_access: !u.has_access } : u)));
  };

  const handleSaveAccess = () => {
    if (!accessTarget) return;
    setAccessSaving(true);

    const user_ids = accessUsers.filter((u) => u.has_access).map((u) => u.id);

    axios
      .put(`${API_BASE_URL}/company/sites/${accessTarget.site_id}/access`, { user_ids })
      .then(() => {
        setToast({ type: "success", message: `Access updated for ${accessTarget.site_name}.` });
        setAccessTarget(null);
      })
      .catch(() => setToast({ type: "error", message: "Failed to update site access." }))
      .finally(() => setAccessSaving(false));
  };

  return (
    <div>
      <PageHeader
        eyebrow="Infrastructure"
        title="Sites / VPN"
        description="Manage your company's Sites, VPN gateway details, and which Users can access each one."
        actions={
          <Button icon={Plus} onClick={openAdd}>
            Add Site
          </Button>
        }
      />

      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SearchInput value={query} onChange={setQuery} placeholder="Search by site name…" className="max-w-sm" />
        <p className="font-mono text-xs text-ink-500">{loading ? "Loading…" : `${filtered.length} of ${sites.length} sites`}</p>
      </div>

      {loading && (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-ink-500">
          <Loader2 size={22} className="animate-spin" />
          <p className="text-xs">Loading sites…</p>
        </div>
      )}

      {!loading && error && (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-center text-ink-500">
          <AlertTriangle size={22} className="text-red-400" />
          <p className="text-xs">{error}</p>
        </div>
      )}

      {!loading && !error && (
        <GlassCard className="p-4 sm:p-5">
          <div className="custom-scroll overflow-x-auto">
            <table className="w-full min-w-[820px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-accent-cyan/10 text-xs uppercase tracking-wide text-ink-500">
                  <th className="px-3 py-3 font-medium">Site Name</th>
                  <th className="px-3 py-3 font-medium">VPN Gateway IP</th>
                  <th className="px-3 py-3 font-medium">Camera Network</th>
                  <th className="px-3 py-3 font-medium">VPN Status</th>
                  <th className="px-3 py-3 font-medium">Cameras</th>
                  <th className="px-3 py-3 font-medium">Active</th>
                  <th className="w-32 px-3 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((site) => (
                  <tr key={site.site_id} className="border-b border-white/5 transition hover:bg-white/[0.03]">
                    <td className="px-3 py-3 font-medium text-ink-100">{site.site_name}</td>
                    <td className="px-3 py-3 font-mono text-xs text-ink-400">{site.vpn_gateway_ip}</td>
                    <td className="px-3 py-3 font-mono text-xs text-ink-400">{site.camera_network || "—"}</td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-2">
                        <StatusBadge status={formatVpnStatus(site.vpn_status)} />
                        <button
                          type="button"
                          title="Check Status"
                          disabled={checkingId === site.site_id}
                          onClick={() => handleCheckStatus(site)}
                          className="rounded-md p-1.5 text-ink-400 hover:bg-white/5 hover:text-accent-cyan disabled:opacity-50"
                        >
                          <RefreshCw size={13} className={checkingId === site.site_id ? "animate-spin" : ""} />
                        </button>
                      </div>
                    </td>
                    <td className="px-3 py-3 text-xs text-ink-400">{site.camera_count}</td>
                    <td className="px-3 py-3">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={site.status === "Active"}
                        disabled={togglingId === site.site_id}
                        onClick={() => handleToggleStatus(site)}
                        title={site.status === "Active" ? "Active — click to deactivate" : "Inactive — click to activate"}
                        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-300 ease-in-out disabled:opacity-50 ${
                          site.status === "Active" ? "bg-signal-green" : "bg-white/15"
                        }`}
                      >
                        <span
                          className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition-transform duration-300 ease-in-out ${
                            site.status === "Active" ? "translate-x-[22px]" : "translate-x-0.5"
                          }`}
                        />
                      </button>
                    </td>
                    <td className="px-3 py-3 text-right">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => openAccess(site)}
                          title="Manage Access"
                          className="rounded-md p-2 text-ink-400 hover:bg-white/5 hover:text-accent-cyan"
                        >
                          <UsersIcon size={15} />
                        </button>
                        <button
                          type="button"
                          onClick={() => openEdit(site)}
                          title="Edit"
                          className="rounded-md p-2 text-ink-400 hover:bg-white/5 hover:text-accent-cyan"
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(site)}
                          title="Delete"
                          className="rounded-md p-2 text-ink-400 hover:bg-signal-red/10 hover:text-signal-red"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}

                {sites.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-16 text-center text-ink-500">
                      <div className="flex flex-col items-center gap-2">
                        <Network size={22} />
                        <p>No sites have been added yet.</p>
                      </div>
                    </td>
                  </tr>
                )}

                {sites.length > 0 && filtered.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-12 text-center text-ink-500">
                      No sites match "{query}".
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </GlassCard>
      )}

      {/* Add / Edit */}
      <Modal open={formOpen} onClose={closeForm} title={editTarget ? "Edit Site" : "Add Site"} size="lg">
        <form className="space-y-4" onSubmit={handleSave}>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-400">Site Name</label>
            <input
              type="text"
              value={form.site_name}
              onChange={(e) => setForm((f) => ({ ...f, site_name: e.target.value }))}
              onBlur={() => setTouched((t) => ({ ...t, site_name: true }))}
              placeholder="Office A"
              className={`${inputClass} ${touched.site_name && errors.site_name ? INVALID_INPUT_CLASS : ""}`}
            />
            {touched.site_name && <FieldError error={errors.site_name} />}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink-400">VPN Gateway IP</label>
              <input
                type="text"
                value={form.vpn_gateway_ip}
                onChange={(e) => setForm((f) => ({ ...f, vpn_gateway_ip: e.target.value }))}
                onBlur={() => setTouched((t) => ({ ...t, vpn_gateway_ip: true }))}
                placeholder="10.50.0.2"
                className={`${inputClass} ${touched.vpn_gateway_ip && errors.vpn_gateway_ip ? INVALID_INPUT_CLASS : ""}`}
              />
              {touched.vpn_gateway_ip && <FieldError error={errors.vpn_gateway_ip} />}
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink-400">Camera Network (Optional)</label>
              <input
                type="text"
                value={form.camera_network}
                onChange={(e) => setForm((f) => ({ ...f, camera_network: e.target.value }))}
                placeholder="192.168.1.0/24"
                className={inputClass}
              />
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-400">WireGuard Public Key (Optional)</label>
            <input
              type="text"
              value={form.vpn_public_key}
              onChange={(e) => setForm((f) => ({ ...f, vpn_public_key: e.target.value }))}
              placeholder="e.g. AbCdEf...=="
              className={inputClass}
            />
            <p className="mt-1.5 text-xs text-ink-500">
              Only the gateway's public key. Never enter a private key here — it is not needed and must never be stored by this app.
            </p>
          </div>

          {formError && (
            <div className="flex items-start gap-2 rounded-xl border border-signal-red/30 bg-signal-red/10 px-3.5 py-2.5 text-xs text-signal-red">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{formError}</span>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="ghost" onClick={closeForm} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !isFormValid}>
              {saving ? "Saving…" : "Save Site"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Delete Confirmation */}
      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Delete Site">
        <p className="text-sm text-ink-300">
          Are you sure you want to delete <span className="text-white">{deleteTarget?.site_name}</span>? Cameras
          currently assigned to this site will keep working and simply become unassigned.
        </p>
        <div className="flex justify-end gap-3 pt-5">
          <Button type="button" variant="ghost" onClick={() => setDeleteTarget(null)} disabled={deleting}>
            Cancel
          </Button>
          <Button type="button" variant="danger" onClick={handleConfirmDelete} disabled={deleting}>
            {deleting ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </Modal>

      {/* Manage Access */}
      <Modal open={!!accessTarget} onClose={() => (accessSaving ? null : setAccessTarget(null))} title={`Manage Access — ${accessTarget?.site_name || ""}`}>
        {accessLoading ? (
          <div className="flex flex-col items-center justify-center gap-3 py-10 text-ink-500">
            <Loader2 size={20} className="animate-spin" />
            <p className="text-xs">Loading users…</p>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-xs text-ink-500">
              Choose which of your company's Users can see and select this site when adding a camera.
            </p>
            <div className="custom-scroll max-h-72 space-y-2 overflow-y-auto">
              {accessUsers.map((u) => (
                <label
                  key={u.id}
                  className="flex items-center gap-3 rounded-xl glass px-3.5 py-2.5 text-sm text-ink-200"
                >
                  <input
                    type="checkbox"
                    checked={u.has_access}
                    onChange={() => toggleAccessUser(u.id)}
                    className="h-4 w-4 rounded border-white/20 bg-transparent accent-accent-cyan"
                  />
                  <span className="flex-1">
                    <span className="block text-ink-100">{u.name}</span>
                    <span className="block text-xs text-ink-500">{u.email}</span>
                  </span>
                </label>
              ))}

              {accessUsers.length === 0 && (
                <p className="px-3 py-6 text-center text-xs text-ink-500">This company has no Users yet.</p>
              )}
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="ghost" onClick={() => setAccessTarget(null)} disabled={accessSaving}>
                Cancel
              </Button>
              <Button type="button" onClick={handleSaveAccess} disabled={accessSaving}>
                {accessSaving ? "Saving…" : "Save Access"}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
