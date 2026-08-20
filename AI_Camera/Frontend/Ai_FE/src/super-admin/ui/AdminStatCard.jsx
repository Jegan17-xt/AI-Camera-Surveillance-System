import * as Icons from "lucide-react";
import AdminCard from "./AdminCard";

const toneStyles = {
  violet: { icon: "text-admin-accent", glow: "bg-admin-accent/15" },
  gold: { icon: "text-admin-gold", glow: "bg-admin-gold/15" },
  green: { icon: "text-signal-green", glow: "bg-signal-green/15" },
  amber: { icon: "text-signal-amber", glow: "bg-signal-amber/15" },
  red: { icon: "text-signal-red", glow: "bg-signal-red/15" },
};

export default function AdminStatCard({ label, value, delta, icon, tone = "violet" }) {
  const Icon = Icons[icon] || Icons.Activity;
  const style = toneStyles[tone] || toneStyles.violet;

  return (
    <AdminCard className="relative overflow-hidden p-5">
      <div className={`absolute -right-6 -top-6 h-24 w-24 rounded-full ${style.glow} blur-2xl`} />
      <div className="relative flex items-start justify-between">
        {/* min-w-0 lets `truncate` below actually take effect instead of
            forcing the flex row wider than the card — without it, a long
            formatted value (e.g. a large currency amount) gets hard-clipped
            by AdminCard's overflow-hidden with no ellipsis, especially right
            at the sm breakpoint where the grid goes 2→4 cols and this text
            jumps 2xl→3xl at the same time. */}
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</p>
          <p className="mt-2 truncate font-display text-2xl font-semibold text-white sm:text-3xl">{value}</p>
          <p className="mt-1.5 font-mono text-[11px] text-ink-500">{delta}</p>
        </div>
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-white/[0.04] ${style.icon}`}>
          <Icon size={19} strokeWidth={2} />
        </div>
      </div>
    </AdminCard>
  );
}
