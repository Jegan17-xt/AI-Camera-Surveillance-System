import { Video, Wifi, WifiOff } from "lucide-react";
import GlassCard from "./ui/GlassCard";

export default function CameraPreview({ name, status }) {
  const isOnline = status === "online";
  return (
    <GlassCard className="viewfinder overflow-hidden">
      <div className={`scanline-overlay relative flex aspect-video items-center justify-center bg-gradient-to-br from-base-800 to-base-900`}>
        {isOnline ? (
          <Video size={28} className="text-ink-700" strokeWidth={1.5} />
        ) : (
          <WifiOff size={28} className="text-signal-red/60" strokeWidth={1.5} />
        )}
        <div className="absolute left-3 top-3 flex items-center gap-1.5 rounded-md bg-black/50 px-2 py-1 backdrop-blur-sm">
          <span
            className={`h-1.5 w-1.5 rounded-full ${isOnline ? "pulse-dot bg-signal-green" : "bg-signal-red"}`}
          />
          <span className="font-mono text-[10px] uppercase tracking-wide text-ink-100">
            {isOnline ? "LIVE" : "OFFLINE"}
          </span>
        </div>
        <div className="absolute right-3 top-3 rounded-md bg-black/50 px-2 py-1 backdrop-blur-sm">
          {isOnline ? (
            <Wifi size={12} className="text-signal-green" />
          ) : (
            <Wifi size={12} className="text-ink-700" />
          )}
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 px-3.5 py-2.5">
        <p className="min-w-0 flex-1 truncate text-xs font-medium text-ink-200">{name}</p>
        <p className="shrink-0 font-mono text-[10px] text-ink-500">CAM-{String(name.length).padStart(2, "0")}</p>
      </div>
    </GlassCard>
  );
}
