import { BellOff } from "lucide-react";
import PageHeader from "../../components/ui/PageHeader";
import GlassCard from "../../components/ui/GlassCard";
import { ManagingSettingsFor, useSettingsTarget } from "../../components/settings/settingsShared";

// User-portal counterpart of admin/pages/NotificationSettings.jsx. The
// old combined pages/Settings.jsx gated its entire WhatsApp & Reports
// card behind `isAdmin = user?.role !== "User"` — and role "User" is the
// only role UserProtectedRoute ever lets reach /user/*, so that card
// never rendered here even before this split. There is nothing existing
// to move into this page without inventing new functionality, so it
// stays a fixed empty-state (kept as its own page/sidebar entry for
// structural parity with the Admin portal's 4-page Settings split).
export default function NotificationSettings() {
  const { targetUserId, setTargetUserId, selectedUser, companyUsers, isCompanyAdmin } = useSettingsTarget();

  return (
    <div>
      <PageHeader eyebrow="Settings" title="Notifications" description="WhatsApp alerts and Daily Reports." />
      <ManagingSettingsFor
        targetUserId={targetUserId}
        setTargetUserId={setTargetUserId}
        companyUsers={companyUsers}
        isCompanyAdmin={isCompanyAdmin}
        selectedUser={selectedUser}
      />

      <GlassCard className="flex flex-col items-center gap-3 p-10 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-white/5 text-ink-400">
          <BellOff size={22} />
        </span>
        <p className="text-sm font-medium text-ink-100">No notification settings for your account</p>
        <p className="max-w-sm text-xs text-ink-500">
          WhatsApp alerts and Daily Reports are configured by your Company Admin. Contact them if you'd like to
          change how or when you're notified.
        </p>
      </GlassCard>
    </div>
  );
}
