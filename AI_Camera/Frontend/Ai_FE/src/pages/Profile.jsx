import { useState } from "react";
import axios from "axios";
import { UserCircle2, KeyRound, AlertTriangle } from "lucide-react";
import PageHeader from "../components/ui/PageHeader";
import GlassCard from "../components/ui/GlassCard";
import Button from "../components/ui/Button";
import Toast from "../components/ui/Toast";
import { useAuth } from "../context/AuthContext";
import { DATA_EVENTS, emitDataEvent } from "../lib/dataEvents";
import { API_BASE_URL } from "../lib/apiBase";
import {
  validateTextField,
  validateEmail,
  validatePassword,
  validatePasswordsMatch,
  hasNoErrors,
  INVALID_INPUT_CLASS,
} from "../lib/validation";

const inputClass =
  "w-full rounded-xl glass px-3.5 py-2.5 text-sm text-ink-100 placeholder:text-ink-500 outline-none focus:border-accent-cyan/50 focus:ring-2 focus:ring-accent-cyan/20";

function FieldError({ error }) {
  if (!error) return null;
  return <p className="mt-1.5 text-xs text-red-400">{error}</p>;
}

function SectionHeading({ icon: Icon, title, subtitle }) {
  return (
    <div className="mb-4 flex items-center gap-3">
      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-cyan/10 text-accent-cyan">
        <Icon size={19} />
      </span>
      <div>
        <p className="font-display text-sm font-semibold text-white">{title}</p>
        <p className="text-xs text-ink-500">{subtitle}</p>
      </div>
    </div>
  );
}

// Both /account/profile and /account/password are pre-existing, fully
// generic self-service endpoints (Backend/api/routes.py) — the target
// account always comes from the session, never from anything this page
// sends, so this is structurally incapable of touching any other
// company's account. Avatar upload intentionally isn't duplicated here
// — it already lives on the Settings page.
export default function Profile() {
  const { user, updateUser } = useAuth();
  const [toast, setToast] = useState(null);

  const [profile, setProfile] = useState({
    name: user?.name || "",
    email: user?.email || "",
    username: user?.username || "",
  });
  const [profileError, setProfileError] = useState(null);
  const [profileTouched, setProfileTouched] = useState({});
  const [savingProfile, setSavingProfile] = useState(false);

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState(null);
  const [passwordTouched, setPasswordTouched] = useState({});
  const [savingPassword, setSavingPassword] = useState(false);

  const profileErrors = {
    name: validateTextField(profile.name, "Name", { minLen: 2, maxLen: 50 }),
    email: validateEmail(profile.email),
    username: validateTextField(profile.username, "Username", { minLen: 3, maxLen: 50 }),
  };
  const isProfileValid = hasNoErrors(profileErrors);

  const passwordErrors = {
    newPassword: validatePassword(newPassword, { label: "New Password", strong: true }),
    confirmPassword: validatePasswordsMatch(newPassword, confirmPassword),
  };
  const isPasswordValid = hasNoErrors(passwordErrors);

  const handleSaveProfile = (e) => {
    e.preventDefault();
    setProfileTouched({ name: true, email: true, username: true });
    setProfileError(null);

    if (!isProfileValid) return;

    setSavingProfile(true);

    axios
      .put(`${API_BASE_URL}/account/profile`, {
        name: profile.name.trim(),
        email: profile.email.trim(),
        username: profile.username.trim(),
      })
      .then((res) => {
        setProfile({
          name: res.data.user.name,
          email: res.data.user.email,
          username: res.data.user.username,
        });
        updateUser(res.data.user);
        emitDataEvent(DATA_EVENTS.PROFILE_CHANGED);
        setToast({ type: "success", message: "Profile updated successfully." });
      })
      .catch((err) => {
        setProfileError(err.response?.data?.message || "Failed to update profile.");
      })
      .finally(() => setSavingProfile(false));
  };

  const handleSavePassword = (e) => {
    e.preventDefault();
    setPasswordTouched({ newPassword: true, confirmPassword: true });
    setPasswordError(null);

    if (!isPasswordValid) return;

    setSavingPassword(true);

    axios
      .put(`${API_BASE_URL}/account/password`, { new_password: newPassword })
      .then(() => {
        setToast({ type: "success", message: "Password updated successfully." });
        setNewPassword("");
        setConfirmPassword("");
        setPasswordTouched({});
      })
      .catch((err) => {
        setPasswordError(err.response?.data?.message || "Failed to update password.");
      })
      .finally(() => setSavingPassword(false));
  };

  const handleCancelPassword = () => {
    setPasswordError(null);
    setPasswordTouched({});
    setNewPassword("");
    setConfirmPassword("");
  };

  return (
    <div>
      <PageHeader eyebrow="Account" title="Profile" description="Manage your own profile details and password." />

      <div className="grid grid-cols-1 gap-4">
        <GlassCard className="p-5">
          <SectionHeading icon={UserCircle2} title="Profile" subtitle="Update your name, email, and username" />
          <form className="space-y-4" onSubmit={handleSaveProfile}>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-ink-400">Name</label>
                <input
                  type="text"
                  required
                  value={profile.name}
                  onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value }))}
                  onBlur={() => setProfileTouched((t) => ({ ...t, name: true }))}
                  className={`${inputClass} ${profileTouched.name && profileErrors.name ? INVALID_INPUT_CLASS : ""}`}
                />
                {profileTouched.name && <FieldError error={profileErrors.name} />}
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-ink-400">Email</label>
                <input
                  type="email"
                  required
                  value={profile.email}
                  onChange={(e) => setProfile((p) => ({ ...p, email: e.target.value }))}
                  onBlur={() => setProfileTouched((t) => ({ ...t, email: true }))}
                  className={`${inputClass} ${profileTouched.email && profileErrors.email ? INVALID_INPUT_CLASS : ""}`}
                />
                {profileTouched.email && <FieldError error={profileErrors.email} />}
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-ink-400">Username</label>
                <input
                  type="text"
                  required
                  value={profile.username}
                  onChange={(e) => setProfile((p) => ({ ...p, username: e.target.value }))}
                  onBlur={() => setProfileTouched((t) => ({ ...t, username: true }))}
                  className={`${inputClass} ${profileTouched.username && profileErrors.username ? INVALID_INPUT_CLASS : ""}`}
                />
                {profileTouched.username && <FieldError error={profileErrors.username} />}
              </div>
            </div>

            {profileError && (
              <div className="flex items-start gap-2 rounded-xl border border-signal-red/30 bg-signal-red/10 px-3.5 py-2.5 text-xs text-signal-red">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>{profileError}</span>
              </div>
            )}

            <Button type="submit" disabled={savingProfile || !isProfileValid}>
              {savingProfile ? "Saving…" : "Save Profile"}
            </Button>
          </form>
        </GlassCard>

        <GlassCard className="p-5">
          <SectionHeading icon={KeyRound} title="Change Password" subtitle="Update your own sign-in password" />
          <form className="space-y-4" onSubmit={handleSavePassword}>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink-400">New Password</label>
              <input
                type="password"
                required
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                onBlur={() => setPasswordTouched((t) => ({ ...t, newPassword: true }))}
                placeholder="At least 8 characters, mixed case, number & symbol"
                className={`${inputClass} ${
                  passwordTouched.newPassword && passwordErrors.newPassword ? INVALID_INPUT_CLASS : ""
                }`}
                autoComplete="new-password"
              />
              {passwordTouched.newPassword && <FieldError error={passwordErrors.newPassword} />}
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-ink-400">Confirm Password</label>
              <input
                type="password"
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                onBlur={() => setPasswordTouched((t) => ({ ...t, confirmPassword: true }))}
                className={`${inputClass} ${
                  passwordTouched.confirmPassword && passwordErrors.confirmPassword ? INVALID_INPUT_CLASS : ""
                }`}
                autoComplete="new-password"
              />
              {passwordTouched.confirmPassword && <FieldError error={passwordErrors.confirmPassword} />}
            </div>

            {passwordError && (
              <div className="flex items-start gap-2 rounded-xl border border-signal-red/30 bg-signal-red/10 px-3.5 py-2.5 text-xs text-signal-red">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>{passwordError}</span>
              </div>
            )}

            <div className="flex items-center gap-3">
              <Button type="submit" disabled={savingPassword || !isPasswordValid}>
                {savingPassword ? "Updating…" : "Update Password"}
              </Button>
              <Button type="button" variant="ghost" onClick={handleCancelPassword} disabled={savingPassword}>
                Cancel
              </Button>
            </div>
          </form>
        </GlassCard>
      </div>

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
