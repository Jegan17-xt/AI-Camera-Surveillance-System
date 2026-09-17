import { useEffect, useState } from "react";
import { Users } from "lucide-react";
import GlassCard from "../ui/GlassCard";
import UserSelect from "../ui/UserSelect";
import { useSelectedUser } from "../../context/SelectedUserContext";

// Shared by the split Settings pages in BOTH portals:
// admin/pages/{AISettings,NotificationSettings,DetectionSettings,
// CompanySettings}.jsx (/admin/*) and user/pages/{same 4 names}.jsx
// (/user/*) — each portal's old single combined Settings page (the
// Company Admin one; the User one was pages/Settings.jsx) was split into
// these 4 pages per-portal, but the underlying mechanics (target-user
// picker, presentational helpers) are identical, so they live here once
// instead of being duplicated per portal. Deliberately NOT imported by
// pages/Settings.jsx itself (now unused — see the 2026-09-01 split
// memory) — this is a fresh copy of its old inline logic, not a
// refactor of it.
export const inputClass =
  "w-full rounded-xl glass px-3.5 py-2.5 text-sm text-ink-100 placeholder:text-ink-500 outline-none focus:border-accent-cyan/50 focus:ring-2 focus:ring-accent-cyan/20";

// null = the logged-in account's own settings (the default, and the
// only option a User ever has — useSelectedUser()'s isCompanyAdmin is
// always false and companyUsers always empty on the User portal, so
// ManagingSettingsFor below simply never renders there). A Company
// Admin may pick one of their own Users — every card on whichever page
// then loads/saves/resets ONLY that account's settings.
//
// Deliberately local component state, not shared/persisted across pages
// (each of the 4 split Settings pages calls this independently) — picking
// a User to manage on one Settings page must never carry over to another;
// every page always starts back on "My Own Settings".
export function useSettingsTarget() {
  const { users: companyUsers, isCompanyAdmin } = useSelectedUser();

  const [targetUserId, setTargetUserId] = useState(null);

  // A User selected on this page may since have been removed.
  useEffect(() => {
    if (targetUserId !== null && companyUsers.length > 0 && !companyUsers.some((u) => u.id === targetUserId)) {
      setTargetUserId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyUsers]);

  const selectedUser = targetUserId ? companyUsers.find((u) => u.id === targetUserId) : null;
  const settingsParams = targetUserId ? { user_id: targetUserId } : undefined;

  return { targetUserId, setTargetUserId, selectedUser, settingsParams, companyUsers, isCompanyAdmin };
}

// The "Managing Settings For" picker — identical across every split
// Settings page in both portals. Renders nothing on the User portal
// (isCompanyAdmin is always false there).
export function ManagingSettingsFor({ targetUserId, setTargetUserId, companyUsers, isCompanyAdmin, selectedUser }) {
  if (!isCompanyAdmin || companyUsers.length === 0) return null;
  return (
    <GlassCard className="mb-4 p-4">
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2 text-sm">
          <Users size={16} className="text-accent-cyan" />
          <span className="font-medium text-ink-100">Managing Settings For</span>
        </div>
        <UserSelect
          users={companyUsers}
          value={targetUserId ?? ""}
          onChange={(e) => setTargetUserId(e.target.value === "" ? null : Number(e.target.value))}
          emptyOptionLabel="My Own Settings"
        />
        {targetUserId && (
          <span className="text-xs text-ink-500">
            Every setting below belongs only to {selectedUser?.name || "this User"} — saving here can never affect
            yours or any other User's settings.
          </span>
        )}
      </div>
    </GlassCard>
  );
}

export function SectionHeading({ icon: Icon, title, subtitle }) {
  return (
    <div className="mb-1 flex items-center gap-3">
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

export function Field({ label, children, hint }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-ink-400">{label}</label>
      {children}
      {hint && <p className="mt-1.5 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

// Wraps a toggle switch with a 🟢/🔴 status pill — used by AI Settings'
// AI Detection card only (the 8 controls that save immediately).
//
// `locked` (optional) renders a 🔒 Locked pill instead, disables the
// switch, and shows `lockedMessage` in place of the normal description —
// used by the 3 Security & Detection package-gated flags (vehicle /
// animal / fire) when this company isn't currently entitled to them
// (see api/ai_config.py's get_ai_flag_locks, returned as `locked` by
// GET/PUT /ai-detection-settings). The onChange guard against `locked`
// is defense in depth — the backend would revert the value anyway, but
// this keeps the switch from ever visually flipping on a click that
// cannot stick.
export function AiControlToggle({ label, description, checked, onChange, disabled, locked, lockedMessage }) {
  const isOn = checked && !locked;
  return (
    <div className="py-3">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-ink-100">{label}</p>
          <span
            className={`mt-0.5 inline-flex items-center gap-1 text-xs font-medium ${
              locked ? "text-ink-500" : isOn ? "text-signal-green" : "text-red-400"
            }`}
          >
            {locked ? "🔒 Locked" : isOn ? "🟢 Enabled" : "🔴 Disabled"}
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={isOn}
          disabled={disabled || locked}
          onClick={() => {
            if (locked) return;
            onChange(!checked);
          }}
          title={locked ? lockedMessage : undefined}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors duration-300 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/60 focus-visible:ring-offset-2 focus-visible:ring-offset-base-950 disabled:cursor-not-allowed disabled:opacity-50 ${
            isOn ? "bg-signal-green" : "bg-white/15"
          }`}
        >
          <span
            className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition-transform duration-300 ease-in-out ${
              isOn ? "translate-x-[22px]" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>
      {locked && lockedMessage ? (
        <p className="mt-1.5 text-xs text-signal-amber">{lockedMessage}</p>
      ) : (
        description && <p className="mt-1.5 text-xs text-ink-500">{description}</p>
      )}
    </div>
  );
}
