const toneMap = {
  Present: "bg-signal-green/10 text-signal-green border-signal-green/30",
  Active: "bg-signal-green/10 text-signal-green border-signal-green/30",
  Online: "bg-signal-green/10 text-signal-green border-signal-green/30",
  Late: "bg-signal-amber/10 text-signal-amber border-signal-amber/30",
  Absent: "bg-signal-red/10 text-signal-red border-signal-red/30",
  Offline: "bg-signal-red/10 text-signal-red border-signal-red/30",
  Inactive: "bg-ink-500/10 text-ink-500 border-ink-500/30",
  Trial: "bg-signal-amber/10 text-signal-amber border-signal-amber/30",
  Expired: "bg-signal-red/10 text-signal-red border-signal-red/30",
  Cancelled: "bg-ink-500/10 text-ink-500 border-ink-500/30",
};

export default function StatusBadge({ status }) {
  const classes = toneMap[status] || "bg-ink-500/10 text-ink-500 border-ink-500/30";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium font-mono tracking-wide ${classes}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {status}
    </span>
  );
}
