import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { UserPlus, ImageUp, Pencil, Trash2, X, Loader2, AlertTriangle, Users } from "lucide-react";
import PageHeader from "../components/ui/PageHeader";
import SearchInput from "../components/ui/SearchInput";
import Button from "../components/ui/Button";
import GlassCard from "../components/ui/GlassCard";
import StatusBadge from "../components/ui/StatusBadge";
import Modal from "../components/ui/Modal";
import Toast from "../components/ui/Toast";
import UserScopeSelector from "../components/ui/UserScopeSelector";
import UserSelect from "../components/ui/UserSelect";
import { DATA_EVENTS, emitDataEvent } from "../lib/dataEvents";
import { validateTextField, validateFileUpload, hasNoErrors, INVALID_INPUT_CLASS } from "../lib/validation";
import { useAuth } from "../context/AuthContext";
import { useSelectedUser } from "../context/SelectedUserContext";
import { hasModule } from "../lib/permissions";
import { API_BASE_URL } from "../lib/apiBase";

// Backend/api/registered.py's MIN_IMAGES must stay in sync with this —
// independent constants in different languages, not a shared value.
const MIN_IMAGES = 20;

const inputClass =
  "w-full rounded-xl glass px-3.5 py-2.5 text-sm text-ink-100 placeholder:text-ink-500 outline-none focus:border-accent-cyan/50 focus:ring-2 focus:ring-accent-cyan/20";

function ImagePickerButton({ label, onSelect }) {
  return (
    <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-white/15 py-3 text-xs text-ink-400 transition hover:border-accent-cyan/40 hover:text-ink-200">
      <ImageUp size={16} />
      <span>{label}</span>
      <input
        type="file"
        accept="image/jpeg,image/png"
        multiple
        className="hidden"
        onChange={(e) => {
          onSelect(Array.from(e.target.files || []));
          e.target.value = "";
        }}
      />
    </label>
  );
}

function ImageThumbGrid({ items, onRemove }) {
  return (
    <div className="custom-scroll grid max-h-40 grid-cols-5 gap-2 overflow-y-auto pr-1">
      {items.map((item) => (
        <div key={item.key} className="relative aspect-square overflow-hidden rounded-md ring-1 ring-white/10">
          <img src={item.url} alt="" className="h-full w-full object-cover" />
          <button
            type="button"
            onClick={() => onRemove(item.key)}
            aria-label="Remove image"
            className="absolute right-0.5 top-0.5 rounded bg-black/60 p-0.5 text-white hover:bg-signal-red/80"
          >
            <X size={10} />
          </button>
        </div>
      ))}
    </div>
  );
}

function MinImagesHint({ count }) {
  const short = count < MIN_IMAGES;
  return (
    <div className="mt-2">
      <p className={`text-xs ${short ? "text-signal-red" : "text-signal-green"}`}>
        {short
          ? `Minimum ${MIN_IMAGES} face images are required for registration. (${count}/${MIN_IMAGES} selected)`
          : `${count} face images selected.`}
      </p>
      <p className="mt-1 text-xs text-ink-500">
        Every image is automatically scored for quality (sharpness, lighting, angle, single clear face) — only the
        best-scoring images are kept for recognition, so blurry, dark, or poorly-angled shots never make the cut.
      </p>
    </div>
  );
}

export default function RegisteredPersons() {
  const { user } = useAuth();
  // "registered_persons" grants full Add/Edit/Delete; the view-only
  // "registered_persons_view" grant only ever reaches this page to see
  // the list/images (both satisfy the module_required on the GET routes).
  const canEdit = hasModule(user, "registered_persons");
  const isCompanyAdmin = user?.role === "Company Admin";

  const { selectedUserId, users: companyUsers } = useSelectedUser();

  const [query, setQuery] = useState("");

  const [persons, setPersons] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [toast, setToast] = useState(null);

  // Add Person
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState({ name: "", employeeId: "", ownerUserId: "" });
  const [addImages, setAddImages] = useState([]); // File[]
  const [addSaving, setAddSaving] = useState(false);
  const [addError, setAddError] = useState(null);
  const [addTouched, setAddTouched] = useState({});

  const addErrors = {
    name: validateTextField(addForm.name, "Name", { minLen: 2, maxLen: 50 }),
    employeeId: validateTextField(addForm.employeeId, "Employee ID", { minLen: 1, maxLen: 30, required: false }),
  };
  const isAddFormValid = hasNoErrors(addErrors);

  // Edit Person
  const [editTarget, setEditTarget] = useState(null);
  const [editForm, setEditForm] = useState({ name: "", employeeId: "", ownerUserId: "" });
  const [editExistingImages, setEditExistingImages] = useState([]); // [{filename, url}]
  const [editRemovedFilenames, setEditRemovedFilenames] = useState(new Set());
  const [editNewImages, setEditNewImages] = useState([]); // File[]
  const [editLoadingImages, setEditLoadingImages] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState(null);
  const [editTouched, setEditTouched] = useState({});

  const editErrors = {
    name: validateTextField(editForm.name, "Name", { minLen: 2, maxLen: 50 }),
    employeeId: validateTextField(editForm.employeeId, "Employee ID", { minLen: 1, maxLen: 30, required: false }),
  };
  const isEditFormValid = hasNoErrors(editErrors);

  // Delete Person
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const fetchPersons = () => {
    setLoading(true);
    setError(null);

    return axios
      .get(`${API_BASE_URL}/registered`, {
        params: selectedUserId !== null ? { user_id: selectedUserId } : undefined,
      })
      .then((res) => {
        setPersons(res.data.persons || []);
        setTotal(res.data.total ?? (res.data.persons || []).length);
      })
      .catch((err) => {
        console.error("Registered Persons API Error :", err);
        setError("Unable to load registered persons. Please check the server and try again.");
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchPersons();
  }, [selectedUserId]);

  const filtered = useMemo(
    () => persons.filter((p) => p.name.toLowerCase().includes(query.toLowerCase())),
    [persons, query]
  );

  // ---------------- Add Person ----------------

  const addPreviews = useMemo(() => addImages.map((file, idx) => ({ key: idx, url: URL.createObjectURL(file) })), [addImages]);

  useEffect(() => {
    return () => addPreviews.forEach((p) => URL.revokeObjectURL(p.url));
  }, [addPreviews]);

  const openAdd = () => {
    // Per-User Data Isolation: default the new person's owner to whichever
    // User the Admin is currently "viewing as" via UserScopeSelector — not
    // always blank. Registering while scoped to a specific User (their
    // filtered list is what's on screen) previously always saved
    // owner_user_id=None regardless, so the new person showed up in the
    // Admin's own "All Users" aggregate but never in that User's own
    // scoped Dashboard/Registered Persons view — exactly the "shows on
    // Admin page, not on User Dashboard" symptom. "All Users" (null) and
    // "Unassigned" scopes still correctly default to blank (Unassigned),
    // unchanged from before; the Admin can still freely repick from the
    // dropdown before saving either way.
    setAddForm({
      name: "",
      employeeId: "",
      ownerUserId: typeof selectedUserId === "number" ? String(selectedUserId) : "",
    });
    setAddImages([]);
    setAddError(null);
    setAddTouched({});
    setAddOpen(true);
  };

  const closeAdd = () => {
    if (addSaving) return;
    setAddOpen(false);
  };

  const handleAddFilesSelected = (files) => {
    const validFiles = [];
    let fileError = "";

    files.forEach((file) => {
      const err = validateFileUpload(file, {
        allowedExtensions: [".jpg", ".jpeg", ".png"],
        maxBytes: 5 * 1024 * 1024,
        label: `Image "${file.name}"`,
      });

      if (err) {
        fileError = err;
      } else {
        validFiles.push(file);
      }
    });

    if (fileError) {
      setAddError(fileError);
    }

    if (validFiles.length > 0) {
      setAddImages((prev) => [...prev, ...validFiles]);
    }
  };

  const removeAddImage = (idx) => {
    setAddImages((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleAddSave = (e) => {
    e.preventDefault();
    setAddTouched({ name: true, employeeId: true });
    if (!isAddFormValid) return;
    setAddError(null);

    if (addImages.length < MIN_IMAGES) {
      setAddError(`Minimum ${MIN_IMAGES} face images are required for registration.`);
      return;
    }

    setAddSaving(true);

    const formData = new FormData();
    formData.append("name", addForm.name.trim());
    formData.append("employee_id", addForm.employeeId.trim());
    // Only a Company Admin may assign ownership — a User's own
    // additions are always auto-owned by themselves server-side, so
    // this field is never sent (and would be ignored anyway) for a User.
    if (isCompanyAdmin) {
      formData.append("owner_user_id", addForm.ownerUserId || "");
    }
    addImages.forEach((file) => formData.append("images", file));

    const submittedName = addForm.name.trim();

    axios
      .post(`${API_BASE_URL}/registered`, formData, { timeout: 180000 })
      .then(() => {
        setToast({ type: "success", message: `${submittedName} registered successfully.` });
        setAddOpen(false);
        emitDataEvent(DATA_EVENTS.REGISTERED_PERSONS_CHANGED);
        return fetchPersons();
      })
      .catch((err) => {
        // A timeout (or a dropped connection) doesn't mean the save
        // failed server-side — face detection + embedding generation
        // for a full image batch can legitimately take longer than any
        // client-side timeout under real load. Re-check the actual list
        // before reporting failure, so a slow-but-successful save is
        // never shown to the user as a failure.
        return axios
          .get(`${API_BASE_URL}/registered`)
          .then((res) => {
            const persons = res.data.persons || [];
            setPersons(persons);
            setTotal(res.data.total ?? persons.length);

            if (persons.some((p) => p.name === submittedName)) {
              setToast({ type: "success", message: `${submittedName} registered successfully.` });
              setAddOpen(false);
              emitDataEvent(DATA_EVENTS.REGISTERED_PERSONS_CHANGED);
            } else {
              setAddError(err.response?.data?.message || "Failed to register person.");
            }
          })
          .catch(() => {
            setAddError(err.response?.data?.message || "Failed to register person.");
          });
      })
      .finally(() => setAddSaving(false));
  };

  // ---------------- Edit Person ----------------

  const editPreviews = useMemo(
    () => editNewImages.map((file, idx) => ({ key: idx, url: URL.createObjectURL(file) })),
    [editNewImages]
  );

  useEffect(() => {
    return () => editPreviews.forEach((p) => URL.revokeObjectURL(p.url));
  }, [editPreviews]);

  const visibleExistingImages = useMemo(
    () => editExistingImages.filter((img) => !editRemovedFilenames.has(img.filename)),
    [editExistingImages, editRemovedFilenames]
  );

  const editResultingCount = visibleExistingImages.length + editNewImages.length;

  const openEdit = (person) => {
    setEditTarget(person);
    setEditForm({
      name: person.name,
      employeeId: person.employee_id || "",
      ownerUserId: person.owner_user_id != null ? String(person.owner_user_id) : "",
    });
    setEditNewImages([]);
    setEditRemovedFilenames(new Set());
    setEditError(null);
    setEditTouched({});
    setEditLoadingImages(true);

    axios
      .get(`${API_BASE_URL}/registered/${encodeURIComponent(person.name)}/images`)
      .then((res) => setEditExistingImages(res.data.images || []))
      .catch((err) => {
        console.error("Get Registered Person Images API Error :", err);
        setToast({ type: "error", message: "Failed to load existing face images." });
      })
      .finally(() => setEditLoadingImages(false));
  };

  const closeEdit = () => {
    if (editSaving) return;
    setEditTarget(null);
  };

  const handleEditFilesSelected = (files) => {
    const validFiles = [];
    let fileError = "";

    files.forEach((file) => {
      const err = validateFileUpload(file, {
        allowedExtensions: [".jpg", ".jpeg", ".png"],
        maxBytes: 5 * 1024 * 1024,
        label: `Image "${file.name}"`,
      });

      if (err) {
        fileError = err;
      } else {
        validFiles.push(file);
      }
    });

    if (fileError) {
      setEditError(fileError);
    }

    if (validFiles.length > 0) {
      setEditNewImages((prev) => [...prev, ...validFiles]);
    }
  };

  const removeEditNewImage = (idx) => {
    setEditNewImages((prev) => prev.filter((_, i) => i !== idx));
  };

  const markExistingImageRemoved = (filename) => {
    setEditRemovedFilenames((prev) => new Set(prev).add(filename));
  };

  const handleEditSave = (e) => {
    e.preventDefault();
    setEditTouched({ name: true, employeeId: true });
    if (!isEditFormValid) return;
    setEditError(null);

    if (editResultingCount < MIN_IMAGES) {
      setEditError(`Minimum ${MIN_IMAGES} face images are required. (${editResultingCount}/${MIN_IMAGES} after these changes)`);
      return;
    }

    setEditSaving(true);

    const formData = new FormData();
    formData.append("name", editForm.name.trim());
    formData.append("employee_id", editForm.employeeId.trim());
    if (isCompanyAdmin) {
      formData.append("owner_user_id", editForm.ownerUserId || "");
    }
    editNewImages.forEach((file) => formData.append("images", file));
    editRemovedFilenames.forEach((filename) => formData.append("removed_images", filename));

    const finalName = editForm.name.trim();

    axios
      .put(`${API_BASE_URL}/registered/${encodeURIComponent(editTarget.name)}`, formData, { timeout: 180000 })
      .then(() => {
        setToast({ type: "success", message: `${finalName} updated successfully.` });
        setEditTarget(null);
        emitDataEvent(DATA_EVENTS.REGISTERED_PERSONS_CHANGED);
        return fetchPersons();
      })
      .catch((err) => {
        // Same reasoning as Add Person: a lost response doesn't mean the
        // update failed server-side under real load, so re-check the
        // real state before reporting failure.
        return axios
          .get(`${API_BASE_URL}/registered`)
          .then((res) => {
            const persons = res.data.persons || [];
            setPersons(persons);
            setTotal(res.data.total ?? persons.length);

            const updated = persons.find((p) => p.name === finalName);
            if (updated && updated.employee_id === editForm.employeeId.trim()) {
              setToast({ type: "success", message: `${finalName} updated successfully.` });
              setEditTarget(null);
              emitDataEvent(DATA_EVENTS.REGISTERED_PERSONS_CHANGED);
            } else {
              setEditError(err.response?.data?.message || "Failed to update person.");
            }
          })
          .catch(() => {
            setEditError(err.response?.data?.message || "Failed to update person.");
          });
      })
      .finally(() => setEditSaving(false));
  };

  // ---------------- Delete Person ----------------

  const handleConfirmDelete = () => {
    if (!deleteTarget) return;

    setDeleting(true);

    axios
      .delete(`${API_BASE_URL}/registered/${encodeURIComponent(deleteTarget.name)}`)
      .then(() => {
        setToast({ type: "success", message: `${deleteTarget.name} deleted successfully.` });
        emitDataEvent(DATA_EVENTS.REGISTERED_PERSONS_CHANGED);
        // Re-fetch from the backend rather than patching local state, so
        // the count/list shown can never drift from what the database
        // actually contains after the delete.
        return fetchPersons();
      })
      .catch((err) => {
        console.error("Delete Registered Person API Error :", err);
        setToast({ type: "error", message: `Failed to delete ${deleteTarget.name}.` });
      })
      .finally(() => {
        setDeleting(false);
        setDeleteTarget(null);
      });
  };

  return (
    <div>
      <PageHeader
        eyebrow="Personnel"
        title="Registered Persons"
        description="Manage identities enrolled in the facial recognition system."
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <UserScopeSelector />
            {canEdit && (
              <Button icon={UserPlus} onClick={openAdd}>
                Add Person
              </Button>
            )}
          </div>
        }
      />

      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SearchInput value={query} onChange={setQuery} placeholder="Search by name…" className="max-w-sm" />
        <p className="font-mono text-xs text-ink-500">
          {loading ? "Loading…" : `${filtered.length} of ${total} persons`}
        </p>
      </div>

      {loading && (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-ink-500">
          <Loader2 size={22} className="animate-spin" />
          <p className="text-xs">Loading registered persons…</p>
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
            <table className="w-full min-w-[560px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-accent-cyan/10 text-xs uppercase tracking-wide text-ink-500">
                  <th className="px-3 py-3 font-medium">Name</th>
                  <th className="px-3 py-3 font-medium">Employee ID</th>
                  <th className="px-3 py-3 font-medium">Face Status</th>
                  <th className="w-24 px-3 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((person) => (
                  <tr key={person.id} className="border-b border-white/5 transition hover:bg-white/[0.03]">
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-3">
                        <img
                          src={person.image}
                          alt={person.name}
                          className="h-9 w-9 shrink-0 rounded-lg object-cover ring-1 ring-white/10"
                        />
                        <span className="truncate font-medium text-ink-100">{person.name}</span>
                      </div>
                    </td>
                    <td className="px-3 py-3 font-mono text-xs text-ink-400">{person.employee_id || "—"}</td>
                    <td className="px-3 py-3">
                      <StatusBadge status={person.face_status} />
                    </td>
                    <td className="px-3 py-3 text-right">
                      {canEdit && (
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => openEdit(person)}
                            title="Edit"
                            className="rounded-md p-2 text-ink-400 hover:bg-white/5 hover:text-accent-cyan"
                          >
                            <Pencil size={15} />
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(person)}
                            title="Delete"
                            className="rounded-md p-2 text-ink-400 hover:bg-signal-red/10 hover:text-signal-red"
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}

                {persons.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-16 text-center text-ink-500">
                      <div className="flex flex-col items-center gap-2">
                        <Users size={22} />
                        <p>No persons have been registered yet.</p>
                      </div>
                    </td>
                  </tr>
                )}

                {persons.length > 0 && filtered.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-12 text-center text-ink-500">
                      No persons match "{query}".
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </GlassCard>
      )}

      {/* Add Person */}
      <Modal open={addOpen} onClose={closeAdd} title="Add Person">
        <form className="space-y-4" onSubmit={handleAddSave}>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-400">Name</label>
            <input
              type="text"
              required
              value={addForm.name}
              onChange={(e) => setAddForm((f) => ({ ...f, name: e.target.value }))}
              onBlur={() => setAddTouched((t) => ({ ...t, name: true }))}
              placeholder="e.g. Alex Johnson"
              className={`${inputClass} ${addTouched.name && addErrors.name ? INVALID_INPUT_CLASS : ""}`}
            />
            {addTouched.name && addErrors.name && <p className="mt-1.5 text-xs text-red-400">{addErrors.name}</p>}
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-400">Employee ID</label>
            <input
              type="text"
              value={addForm.employeeId}
              onChange={(e) => setAddForm((f) => ({ ...f, employeeId: e.target.value }))}
              onBlur={() => setAddTouched((t) => ({ ...t, employeeId: true }))}
              placeholder="Optional"
              className={`${inputClass} ${addTouched.employeeId && addErrors.employeeId ? INVALID_INPUT_CLASS : ""}`}
            />
            {addTouched.employeeId && addErrors.employeeId && (
              <p className="mt-1.5 text-xs text-red-400">{addErrors.employeeId}</p>
            )}
          </div>

          {isCompanyAdmin && (
            <UserSelect
              users={companyUsers}
              value={addForm.ownerUserId}
              onChange={(e) => setAddForm((f) => ({ ...f, ownerUserId: e.target.value }))}
              label="Assign to User (Optional)"
              emptyOptionLabel="Unassigned"
            />
          )}

          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-400">Face Images</label>
            <ImagePickerButton label="Choose images (select multiple)" onSelect={handleAddFilesSelected} />

            {addImages.length > 0 && <div className="mt-3"><ImageThumbGrid items={addPreviews} onRemove={removeAddImage} /></div>}

            <MinImagesHint count={addImages.length} />
          </div>

          {addError && (
            <div className="flex items-start gap-2 rounded-xl border border-signal-red/30 bg-signal-red/10 px-3.5 py-2.5 text-xs text-signal-red">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{addError}</span>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="ghost" onClick={closeAdd} disabled={addSaving}>
              Cancel
            </Button>
            <Button type="submit" disabled={addSaving || addImages.length < MIN_IMAGES || !isAddFormValid}>
              {addSaving ? "Saving…" : "Save Person"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Edit Person */}
      <Modal open={!!editTarget} onClose={closeEdit} title="Edit Person">
        <form className="space-y-4" onSubmit={handleEditSave}>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-400">Name</label>
            <input
              type="text"
              required
              value={editForm.name}
              onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
              onBlur={() => setEditTouched((t) => ({ ...t, name: true }))}
              className={`${inputClass} ${editTouched.name && editErrors.name ? INVALID_INPUT_CLASS : ""}`}
            />
            {editTouched.name && editErrors.name && <p className="mt-1.5 text-xs text-red-400">{editErrors.name}</p>}
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-400">Employee ID</label>
            <input
              type="text"
              value={editForm.employeeId}
              onChange={(e) => setEditForm((f) => ({ ...f, employeeId: e.target.value }))}
              onBlur={() => setEditTouched((t) => ({ ...t, employeeId: true }))}
              placeholder="Optional"
              className={`${inputClass} ${editTouched.employeeId && editErrors.employeeId ? INVALID_INPUT_CLASS : ""}`}
            />
            {editTouched.employeeId && editErrors.employeeId && (
              <p className="mt-1.5 text-xs text-red-400">{editErrors.employeeId}</p>
            )}
          </div>

          {isCompanyAdmin && (
            <UserSelect
              users={companyUsers}
              value={editForm.ownerUserId}
              onChange={(e) => setEditForm((f) => ({ ...f, ownerUserId: e.target.value }))}
              label="Assign to User (Optional)"
              emptyOptionLabel="Unassigned"
            />
          )}

          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-400">Face Images</label>

            {editLoadingImages ? (
              <div className="flex items-center gap-2 py-3 text-ink-500">
                <Loader2 size={16} className="animate-spin" />
                <p className="text-xs">Loading images…</p>
              </div>
            ) : (
              <>
                {visibleExistingImages.length > 0 && (
                  <div className="mb-3">
                    <p className="mb-1.5 text-[11px] text-ink-500">Existing images</p>
                    <ImageThumbGrid
                      items={visibleExistingImages.map((img) => ({ key: img.filename, url: img.url }))}
                      onRemove={markExistingImageRemoved}
                    />
                  </div>
                )}

                <ImagePickerButton label="Add more images" onSelect={handleEditFilesSelected} />

                {editNewImages.length > 0 && (
                  <div className="mt-3">
                    <p className="mb-1.5 text-[11px] text-ink-500">New images to add</p>
                    <ImageThumbGrid items={editPreviews} onRemove={removeEditNewImage} />
                  </div>
                )}

                <MinImagesHint count={editResultingCount} />
              </>
            )}
          </div>

          {editError && (
            <div className="flex items-start gap-2 rounded-xl border border-signal-red/30 bg-signal-red/10 px-3.5 py-2.5 text-xs text-signal-red">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{editError}</span>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="ghost" onClick={closeEdit} disabled={editSaving}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={editSaving || editLoadingImages || editResultingCount < MIN_IMAGES || !isEditFormValid}
            >
              {editSaving ? "Saving…" : "Save Changes"}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Delete Confirmation */}
      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Delete Person">
        <p className="text-sm text-ink-300">Are you sure you want to delete this registered person?</p>
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
