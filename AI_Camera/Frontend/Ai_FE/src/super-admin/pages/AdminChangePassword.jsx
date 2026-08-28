import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { KeyRound, Loader2, AlertTriangle, Building2 } from "lucide-react";
import AdminPageHeader from "../ui/AdminPageHeader";
import AdminSearchInput from "../ui/AdminSearchInput";
import AdminCard from "../ui/AdminCard";
import AdminButton from "../ui/AdminButton";
import AdminModal from "../ui/AdminModal";
import AdminToast from "../ui/AdminToast";
import { DATA_EVENTS, useDataEvent } from "../../lib/dataEvents";
import { validatePassword, validatePasswordsMatch, hasNoErrors, INVALID_INPUT_CLASS } from "../../lib/validation";
import { API_BASE_URL } from "../../lib/apiBase";

function FieldError({ error }) {
  if (!error) return null;
  return <p className="mt-1.5 text-xs text-red-400">{error}</p>;
}

const inputClass =
  "w-full rounded-md admin-panel px-3.5 py-2.5 text-sm text-ink-100 placeholder:text-ink-500 outline-none focus:border-admin-accent/50 focus:ring-2 focus:ring-admin-accent/20";

export default function AdminChangePassword() {
  const [query, setQuery] = useState("");
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const [changeTarget, setChangeTarget] = useState(null);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [validationError, setValidationError] = useState(null);
  const [touched, setTouched] = useState({});
  const [updating, setUpdating] = useState(false);

  const fieldErrors = {
    newPassword: validatePassword(newPassword, { label: "New Password", strong: true }),
    confirmPassword: validatePasswordsMatch(newPassword, confirmPassword),
  };
  const isFormValid = hasNoErrors(fieldErrors);

  const fetchCustomers = () => {
    setLoading(true);
    setError(null);

    return axios
      .get(`${API_BASE_URL}/users`)
      .then((res) => {
        // The Super Admin can only ever change a Company Admin's own
        // password here — never a Super Admin's (managed from Super
        // Admin Management instead) and never a plain User's (a User's
        // password is only ever changed by their own Company Admin, from
        // the Company Admin's own portal — it must never appear here).
        setCustomers((res.data.users || []).filter((u) => u.role === "Company Admin"));
      })
      .catch((err) => {
        console.error("Company Admins API Error :", err);
        setError("Unable to load Company Admins. Please check the server and try again.");
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchCustomers();
  }, []);

  // Another Admin tab/page (Company Admins list) may have added/removed
  // one since this page's own list was fetched — keep the picker in sync
  // without the Admin needing to leave and come back.
  useDataEvent(DATA_EVENTS.CUSTOMERS_CHANGED, fetchCustomers);

  const filtered = useMemo(
    () => customers.filter((c) => c.name.toLowerCase().includes(query.toLowerCase())),
    [customers, query]
  );

  const openChangePassword = (customer) => {
    setChangeTarget(customer);
    setNewPassword("");
    setConfirmPassword("");
    setValidationError(null);
    setTouched({});
  };

  const closeModal = () => {
    setChangeTarget(null);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    setTouched({ newPassword: true, confirmPassword: true });
    setValidationError(null);

    if (!isFormValid) {
      return;
    }

    if (!changeTarget) return;

    setUpdating(true);

    axios
      .put(`${API_BASE_URL}/users/${changeTarget.id}/reset-password`, { password: newPassword })
      .then(() => {
        setToast({ type: "success", message: "Password updated successfully." });
        setChangeTarget(null);
      })
      .catch((err) => {
        setValidationError(err.response?.data?.message || "Failed to update password.");
      })
      .finally(() => setUpdating(false));
  };

  return (
    <div>
      <AdminPageHeader
        eyebrow="Accounts"
        title="Passwords"
        description="Set a new password for a Company Admin account. User passwords are managed only by their own Company Admin."
      />

      <AdminCard className="p-4 sm:p-5">
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <AdminSearchInput value={query} onChange={setQuery} placeholder="Search Company Admin…" className="sm:w-72" />
          <p className="font-mono text-xs text-ink-500">
            {loading ? "Loading…" : `${filtered.length} of ${customers.length} Company Admins`}
          </p>
        </div>

        {loading && (
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-ink-500">
            <Loader2 size={22} className="animate-spin text-admin-accent" />
            <p className="text-xs">Loading Company Admins…</p>
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
                <tr className="border-b border-admin-accent/10 text-xs uppercase tracking-wide text-ink-500">
                  <th className="px-3 py-3 font-medium">Company Name</th>
                  <th className="px-3 py-3 font-medium">Company Admin Name</th>
                  <th className="px-3 py-3 font-medium">Username</th>
                  <th className="w-48 whitespace-nowrap px-3 py-3 font-medium text-right">Change Password</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <tr key={c.id} className="border-b border-white/5 hover:bg-white/[0.03] transition">
                    {/* The account only has a single "name" field today —
                        it doubles as both the company's display name and
                        the Company Admin's own name, so both columns
                        intentionally show the same value. */}
                    <td className="px-3 py-3 font-medium text-ink-100">{c.name}</td>
                    <td className="px-3 py-3 text-ink-300">{c.name}</td>
                    <td className="px-3 py-3 font-mono text-xs text-ink-400">{c.username}</td>
                    <td className="px-3 py-3 text-right">
                      <AdminButton
                        type="button"
                        variant="secondary"
                        icon={KeyRound}
                        onClick={() => openChangePassword(c)}
                        className="!py-1.5 !px-3 whitespace-nowrap text-xs"
                      >
                        Change Password
                      </AdminButton>
                    </td>
                  </tr>
                ))}

                {customers.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-16 text-center text-ink-500">
                      <div className="flex flex-col items-center gap-2">
                        <Building2 size={22} />
                        <p>No Company Admins have been created yet.</p>
                      </div>
                    </td>
                  </tr>
                )}

                {customers.length > 0 && filtered.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-12 text-center text-ink-500">
                      No Company Admins match “{query}”.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </AdminCard>

      <AdminModal open={!!changeTarget} onClose={closeModal} title="Change Password">
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-400">Company Admin Name</label>
            <input type="text" value={changeTarget?.name || ""} readOnly disabled className={`${inputClass} opacity-60`} />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-400">New Password</label>
            <input
              type="password"
              required
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, newPassword: true }))}
              placeholder="At least 8 characters, mixed case, number & symbol"
              className={`${inputClass} ${touched.newPassword && fieldErrors.newPassword ? INVALID_INPUT_CLASS : ""}`}
            />
            {touched.newPassword && <FieldError error={fieldErrors.newPassword} />}
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-ink-400">Confirm Password</label>
            <input
              type="password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, confirmPassword: true }))}
              className={`${inputClass} ${
                touched.confirmPassword && fieldErrors.confirmPassword ? INVALID_INPUT_CLASS : ""
              }`}
            />
            {touched.confirmPassword && <FieldError error={fieldErrors.confirmPassword} />}
          </div>

          {validationError && (
            <div className="flex items-start gap-2 rounded-md border border-signal-red/30 bg-signal-red/10 px-3.5 py-2.5 text-xs text-signal-red">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{validationError}</span>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <AdminButton type="button" variant="ghost" onClick={closeModal} disabled={updating}>
              Cancel
            </AdminButton>
            <AdminButton type="submit" disabled={updating || !isFormValid}>
              {updating ? "Updating…" : "Update Password"}
            </AdminButton>
          </div>
        </form>
      </AdminModal>

      <AdminToast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
