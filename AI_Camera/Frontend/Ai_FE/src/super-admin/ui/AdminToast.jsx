import { useEffect } from "react";
import { CheckCircle2, XCircle } from "lucide-react";

export default function AdminToast({ toast, onClose }) {
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(onClose, 3000);
    return () => clearTimeout(timer);
  }, [toast, onClose]);

  if (!toast) return null;

  const isSuccess = toast.type === "success";

  return (
    // inset-x-4 + sm:inset-x-auto/sm:right-6/sm:max-w-sm: a fixed, content-sized
    // box anchored only by `right` has no width cap, so a longer message (e.g.
    // "Failed to delete selected activity logs.") can exceed a 320-375px
    // viewport and run off the left edge. Below sm it's boxed between two
    // 1rem margins instead; at sm+ it reverts to the original right-anchored
    // look, just capped so it can't overflow.
    <div className="fixed inset-x-4 bottom-6 z-[60] flex items-center gap-2.5 rounded-lg admin-panel-strong px-4 py-3 shadow-2xl sm:inset-x-auto sm:right-6 sm:max-w-sm">
      {isSuccess ? (
        <CheckCircle2 size={18} className="shrink-0 text-signal-green" />
      ) : (
        <XCircle size={18} className="shrink-0 text-signal-red" />
      )}
      <p className="min-w-0 break-words text-sm text-ink-100">{toast.message}</p>
    </div>
  );
}
