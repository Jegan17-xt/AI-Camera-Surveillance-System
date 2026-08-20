import * as Icons from "lucide-react";
import GlassCard from "./ui/GlassCard";

const toneStyles = {
  cyan: { icon: "text-accent-cyan", glow: "bg-accent-cyan/15" },
  blue: { icon: "text-accent-blue", glow: "bg-accent-blue/15" },
  green: { icon: "text-signal-green", glow: "bg-signal-green/15" },
  amber: { icon: "text-signal-amber", glow: "bg-signal-amber/15" },
  red: { icon: "text-signal-red", glow: "bg-signal-red/15" },
};

export default function StatCard({ label, value, delta, icon, tone = "cyan" }) {
  const Icon = Icons[icon] || Icons.Activity;
  const style = toneStyles[tone] || toneStyles.cyan;

  return (
    <GlassCard className="relative overflow-hidden p-5 transition-transform duration-200 hover:-translate-y-0.5">
      <div className={`absolute -right-6 -top-6 h-24 w-24 rounded-full ${style.glow} blur-2xl`} />
      <div className="relative flex items-start justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</p>
          <p className="mt-2 font-display text-2xl font-semibold text-white sm:text-3xl">{value}</p>
          <p className="mt-1.5 font-mono text-[11px] text-ink-500">{delta}</p>
        </div>
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/[0.04] ${style.icon}`}>
          <Icon size={19} strokeWidth={2} />
        </div>
      </div>
    </GlassCard>
  );
}
