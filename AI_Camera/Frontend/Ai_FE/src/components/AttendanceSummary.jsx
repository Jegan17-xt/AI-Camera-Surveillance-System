import GlassCard from "./ui/GlassCard";

export default function AttendanceSummary({ data = [] }) {
  const max = Math.max(1, ...data.map((d) => d.present + d.absent));

  return (
    <GlassCard className="p-5">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-sm font-semibold text-white">Attendance Summary</h3>
        <div className="flex items-center gap-3 font-mono text-[10px] text-ink-500">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm bg-accent-cyan" /> Present
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm bg-white/15" /> Absent
          </span>
        </div>
      </div>
      <div className="flex h-48 items-end justify-between gap-2 sm:gap-4">
        {data.map((d) => (
          <div key={d.day} className="flex flex-1 flex-col items-center gap-2">
            <div className="flex h-40 w-full flex-col-reverse justify-end gap-1 overflow-hidden rounded-lg bg-white/[0.02]">
              <div
                className="w-full rounded-t-sm bg-gradient-to-t from-accent-blue to-accent-cyan shadow-[0_-4px_12px_rgba(34,211,238,0.25)] transition-all"
                style={{ height: `${(d.present / max) * 100}%` }}
              />
              <div
                className="w-full rounded-t-sm bg-white/10 transition-all"
                style={{ height: `${(d.absent / max) * 100}%` }}
              />
            </div>
            <span className="font-mono text-[10px] text-ink-500">{d.day}</span>
          </div>
        ))}
      </div>
    </GlassCard>
  );
}
