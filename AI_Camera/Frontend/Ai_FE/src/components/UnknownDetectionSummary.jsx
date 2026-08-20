import GlassCard from "./ui/GlassCard";
import { ScanFace } from "lucide-react";

export default function UnknownDetectionSummary({ data = [] }) {
  const max = Math.max(1, ...data.map((d) => d.count));

  return (
    <GlassCard className="p-5">
      <div className="mb-5 flex items-center justify-between">
        <h3 className="font-display text-sm font-semibold text-white">Unknown Detection Summary</h3>
        <ScanFace size={16} className="text-signal-red/70" />
      </div>
      <div className="space-y-4">
        {data.map((d) => (
          <div key={d.zone}>
            <div className="mb-1.5 flex items-center justify-between text-xs">
              <span className="text-ink-300">{d.zone}</span>
              <span className="font-mono text-ink-500">{d.count} detections</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.05]">
              <div
                className="h-full rounded-full bg-gradient-to-r from-signal-red/70 to-signal-amber"
                style={{ width: `${(d.count / max) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </GlassCard>
  );
}
