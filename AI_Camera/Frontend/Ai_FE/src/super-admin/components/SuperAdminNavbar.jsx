import { useEffect, useState } from "react";
import { Menu, ShieldHalf } from "lucide-react";
import { useAuth } from "../../context/AuthContext";

export default function SuperAdminNavbar({ onMenuClick }) {
  const { user } = useAuth();
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const dateStr = now.toLocaleDateString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const timeStr = now.toLocaleTimeString(undefined, { hour12: true });

  return (
    <header className="sticky top-0 z-20 border-b border-admin-accent/10 bg-admin-950/90">
      <div className="flex items-center justify-between gap-4 px-4 py-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <button
            onClick={onMenuClick}
            className="shrink-0 rounded-md p-2 text-ink-300 hover:bg-white/5 hover:text-white lg:hidden"
          >
            <Menu size={20} />
          </button>
          <div className="min-w-0">
            <h2 className="truncate font-display text-base font-semibold text-white sm:text-lg">
              Super Admin Console
            </h2>
            <p className="hidden truncate font-mono text-[11px] text-ink-500 sm:block">
              System-wide access and configuration
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-3 sm:gap-4">
          <div className="hidden items-center gap-2 rounded-md admin-panel px-3.5 py-2 md:flex">
            <span className="admin-pulse-dot h-1.5 w-1.5 rounded-full bg-admin-accent" />
            <span className="font-mono text-xs text-ink-300">{dateStr}</span>
            <span className="mx-1 h-3 w-px bg-white/10" />
            <span className="font-mono text-xs text-admin-gold">{timeStr}</span>
          </div>

          <div className="flex items-center gap-2.5 rounded-md admin-panel py-1.5 pl-2 pr-3.5">
            {/* Icon sits on a permanently-vivid gradient badge, so it stays a fixed literal white in both themes. */}
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-gradient-to-br from-admin-accent to-admin-accent-deep text-[#fff]">
              <ShieldHalf size={16} strokeWidth={2.4} />
            </div>
            <span className="hidden text-left sm:block">
              <span className="block text-xs font-medium text-white">{user?.name || "—"}</span>
              <span className="block text-[10px] text-admin-gold">{user?.role || ""}</span>
            </span>
          </div>
        </div>
      </div>
    </header>
  );
}
