import { useEffect } from "react";
import { CheckCircle2, XCircle } from "lucide-react";

export default function Toast({ toast, onClose }) {
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(onClose, 3000);
    return () => clearTimeout(timer);
  }, [toast, onClose]);

  if (!toast) return null;

  const isSuccess = toast.type === "success";

  return (
    <div className="fixed bottom-6 right-6 z-[60] flex max-w-[min(24rem,calc(100vw-3rem))] items-center gap-2.5 rounded-xl glass-strong px-4 py-3 shadow-2xl">
      {isSuccess ? (
        <CheckCircle2 size={18} className="shrink-0 text-signal-green" />
      ) : (
        <XCircle size={18} className="shrink-0 text-signal-red" />
      )}
      <p className="break-words text-sm text-ink-100">{toast.message}</p>
    </div>
  );
}
