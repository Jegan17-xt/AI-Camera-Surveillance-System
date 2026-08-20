import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { Cctv, Plus, Pencil, Trash2, Loader2, AlertTriangle } from "lucide-react";
import PageHeader from "../components/ui/PageHeader";
import SearchInput from "../components/ui/SearchInput";
import Button from "../components/ui/Button";
import GlassCard from "../components/ui/GlassCard";
import Modal from "../components/ui/Modal";
import Toast from "../components/ui/Toast";
import UserSelect from "../components/ui/UserSelect";
import { useSelectedUser } from "../context/SelectedUserContext";
import { validateTextField, hasNoErrors, INVALID_INPUT_CLASS } from "../lib/validation";

const emptyForm = {
  camera_name: "",
  camera_location: "",
  owner_user_id: "",
  description: "",
};

const inputClass =
  "w-full rounded-xl glass px-3.5 py-2.5 text-sm text-ink-100 placeholder:text-ink-500 outline-none focus:border-accent-cyan/50 focus:ring-2 focus:ring-accent-cyan/20";

function FieldError({ error }) {
  if (!error) return null;
  return <p className="mt-1.5 text-xs text-red-400">{error}</p>;
}

// A separate, deliberately minimal camera registry — name/location/
// assigned User/description only. No RTSP connection, no live preview,
// no AI detection; unlike Camera Management, this page only ever saves
// and displays metadata. Same page shape (PageHeader, filter bar,
// GlassCard table, Add/Edit Modal, delete confirmation) as Camera
// Management/Dashboard, reusing the exact same shared components.
export default function NormalCamera() {
  const { users: companyUsers } = useSelectedUser();

  // ---------------- Filters (client-side, over the fetched list) ----------------
  const [userFilter, setUserFilter] = useState("");
  const [nameFilter, setNameFilter] = useState("");
  const [locationFilter, setLocationFilter] = useState("");

  const [cameras, setCameras] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const fetchCameras = () => {
    setLoading(true);
    setError(null);

    return axios
      .get("http://localhost:5000/company/normal-cameras")
      .then((res) => setCameras(res.data.cameras || []))
      .catch((err) => {
        console.error("Normal Cameras API Error :", err);
        setError("Unable to load cameras. Please check the server and try again.");
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchCameras();
  }, []);

  const filtered = useMemo(
    () =>
      cameras.filter((c) => {
        if (userFilter && String(c.owner_user_id ?? "") !== userFilter) return false;
        if (nameFilter && !c.camera_name.toLowerCase().includes(nameFilter.toLowerCase())) return false;
        if (locationFilter && !c.camera_location.toLowerCase().includes(locationFilter.toLowerCase())) return false;
        return true;
      }),
    [cameras, userFilter, nameFilter, locationFilter]
  );

  const hasActiveFilters = userFilter || nameFilter || locationFilter;
  const clearFilters = () => {
    setUserFilter("");
    setNameFilter("");
    setLocationFilter("");
  };

  // ---------------- Add / Edit ----------------

  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null); // null = Add
  const [form, setForm] = useState(emptyForm);
  const [touched, setTouched] = useState({});
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  const errors = {
    camera_name: validateTextField(form.camera_name, "Camera Name", { minLen: 3, maxLen: 50 }),
    camera_location: validateTextField(form.camera_location, "Location", { maxLen: 100, addressLike: true }),
    description: form.description.length > 500 ? "Description must be 500 characters or fewer." : "",
  };
  const isFormValid = hasNoErrors(errors);

  const openAdd = () => {
    setEditTarget(null);
    setForm(emptyForm);
    setTouched({});
    setFormError(null);
    setFormOpen(true);
  };

  const openEdit = (camera) => {
    setEditTarget(camera);
    setForm({
      camera_name: camera.camera_name,
      camera_location: camera.camera_location,
      owner_user_id: camera.owner_user_id != null ? String(camera.owner_user_id) : "",
      description: camera.description || "",
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
    setTouched({ camera_name: true, camera_location: true, description: true });
    if (!isFormValid) return;
    setFormError(null);
    setSaving(true);

    const payload = {
      camera_name: form.camera_name.trim(),
      camera_location: form.camera_location.trim(),
      description: form.description.trim(),
      owner_user_id: form.owner_user_id === "" ? null : Number(form.owner_user_id),
    };

    const request = editTarget
      ? axios.put(`http://localhost:5000/company/normal-cameras/${editTarget.id}`, payload)
      : axios.post("http://localhost:5000/company/normal-cameras", payload);

    request
      .then(() => {
        setToast({ type: "success", message: editTarget ? "Camera updated successfully." : "Camera added successfully." });
        setFormOpen(false);
        return fetchCameras();
      })
      .catch((err) => {
        setFormError(err.response?.data?.message || "Failed to save camera.");
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
      .delete(`http://localhost:5000/company/normal-cameras/${deleteTarget.id}`)
      .then(() => {
        setToast({ type: "success", message: `${deleteTarget.camera_name} deleted successfully.` });
        return fetchCameras();
      })
      .catch(() => setToast({ type: "error", message: `Failed to delete ${deleteTarget.camera_name}.` }))
      .finally(() => {
        setDeleting(false);
        setDeleteTarget(null);
      });
  };

  return (
    <div>
      <PageHeader
        eyebrow="Infrastructure"
        title="Normal Camera"
        description="A simple camera registry — name, location, and assignment only. No live stream or AI detection."
        actions={
          <Button icon={Plus} onClick={openAdd}>
            Add Camera
          </Button>
        }
      />

      <GlassCard className="mb-5 p-4 sm:p-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <UserSelect
            users={companyUsers}
            value={userFilter}
            onChange={(e) => setUserFilter(e.target.value)}
            emptyOptionLabel="All Users"
            fullWidth
          />
          <SearchInput value={nameFilter} onChange={setNameFilter} placeholder="Filter by camera name…" />
          <SearchInput value={locationFilter} onChange={setLocationFilter} placeholder="Filter by location…" />
        </div>
      </GlassCard>

      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="font-mono text-xs text-ink-500">{loading ? "Loading…" : `${filtered.length} of ${cameras.length} cameras`}</p>
        {hasActiveFilters && (
          <button type="button" onClick={clearFilters} className="text-left text-xs text-accent-cyan hover:underline sm:text-right">
            Clear filters
          </button>
        )}
      </div>

      {loading && (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-ink-500">
          <Loader2 size={22} className="animate-spin" />
          <p className="text-xs">Loading cameras…</p>
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
            <table className="w-full min-w-[680px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-accent-cyan/10 text-xs uppercase tracking-wide text-ink-500">
                  <th className="px-3 py-3 font-medium">Camera Name</th>
                  <th className="px-3 py-3 font-medium">Location</th>
                  <th className="px-3 py-3 font-medium">Assigned User</th>
                  <th className="px-3 py-3 font-medium">Description</th>
                  <th className="w-24 px-3 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((camera) => (
                  <tr key={camera.id} className="border-b border-white/5 transition hover:bg-white/[0.03]">
                    <td className="px-3 py-3 font-medium text-ink-100">{camera.camera_name}</td>
                    <td className="px-3 py-3 text-xs text-ink-400">{camera.camera_location}</td>
                    <td className="px-3 py-3 text-xs text-ink-400">
                      {companyUsers.find((u) => u.id === camera.owner_user_id)?.name || "Unassigned"}
                    </td>
                    <td className="max-w-xs truncate px-3 py-3 text-xs text-ink-400" title={camera.description || ""}>
                      {camera.description || "—"}
                    </td>
                    <td className="px-3 py-3 text-right">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => openEdit(camera)}
                          title="Edit"
                          className="rounded-md p-2 text-ink-400 hover:bg-white/5 hover:text-accent-cyan"
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(camera)}
                          title="Delete"
                          className="rounded-md p-2 text-ink-400 hover:bg-signal-red/10 hover:text-signal-red"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}

                {cameras.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-16 text-center text-ink-500">
                      <div className="flex flex-col items-center gap-2">
                        <Cctv size={22} />
                        <p>No cameras have been added yet.</p>
                      </div>
                    </td>
                  </tr>
                )}

                {cameras.length > 0 && filtered.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-12 text-center text-ink-500">
                      No cameras match the current filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </GlassCard>
      )}

      {/* Add / Edit */}
      <Modal open={formOpen} onClose={closeForm} title={editTarget ? "Edit Camera" : "Add Camera"}>
        <form className="space-y-4" onSubmit={handleSave}>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-400">Camera Name</label>
            <input
              type="text"
              value={form.camera_name}
              onChange={(e) => setForm((f) => ({ ...f, camera_name: e.target.value }))}
              onBlur={() => setTouched((t) => ({ ...t, camera_name: true }))}
              className={`${inputClass} ${touched.camera_name && errors.camera_name ? INVALID_INPUT_CLASS : ""}`}
            />
            {touched.camera_name && <FieldError error={errors.camera_name} />}
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-400">Location</label>
            <input
              type="text"
              value={form.camera_location}
              onChange={(e) => setForm((f) => ({ ...f, camera_location: e.target.value }))}
              onBlur={() => setTouched((t) => ({ ...t, camera_location: true }))}
              className={`${inputClass} ${touched.camera_location && errors.camera_location ? INVALID_INPUT_CLASS : ""}`}
            />
            {touched.camera_location && <FieldError error={errors.camera_location} />}
          </div>

          <UserSelect
            users={companyUsers}
            value={form.owner_user_id}
            onChange={(e) => setForm((f) => ({ ...f, owner_user_id: e.target.value }))}
            label="Assign to User (Optional)"
            emptyOptionLabel="Unassigned"
          />

          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-400">Description (Optional)</label>
            <textarea
              rows={3}
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              onBlur={() => setTouched((t) => ({ ...t, description: true }))}
              placeholder="Optional notes about this camera…"
              className={`${inputClass} resize-none ${touched.description && errors.description ? INVALID_INPUT_CLASS : ""}`}
            />
            {touched.description && <FieldError error={errors.description} />}
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
              {saving ? "Saving…" : "Save Camera"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Delete Confirmation */}
      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Delete Camera">
        <p className="text-sm text-ink-300">
          Are you sure you want to delete <span className="text-white">{deleteTarget?.camera_name}</span>?
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

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
