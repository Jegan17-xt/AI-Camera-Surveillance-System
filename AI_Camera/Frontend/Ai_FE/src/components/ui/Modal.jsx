import { X } from "lucide-react";

const sizeClass = {
  md: "max-w-lg",
  lg: "max-w-2xl",
  // ~880px — wide enough for a two-column form (e.g. Add/Edit Camera)
  // without feeling cramped, while still comfortably fitting a
  // 1366px-wide viewport with margin either side.
  xl: "max-w-[880px]",
};

export default function Modal({ open, onClose, title, children, size = "md" }) {
  if (!open) return null;
  const spacious = size !== "md";
  const padX = spacious ? "px-8" : "px-6";
  const padTop = spacious ? "pt-8" : "pt-6";
  const padBottom = spacious ? "pb-8" : "pb-6";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" onClick={onClose} />
      {/* max-h + overflow-y-auto keeps this perfectly centered (via the
          wrapper's flex items-center) even when the form is taller than
          the viewport, scrolling internally instead of pushing the panel
          off-screen. */}
      <div
        className={`glass-strong relative flex max-h-[90vh] w-full ${sizeClass[size] || sizeClass.md} animate-modal-in flex-col rounded-2xl shadow-2xl`}
      >
        <div className={`flex shrink-0 items-center justify-between gap-4 ${padX} ${padTop} pb-5`}>
          <h3 className={`font-display font-semibold text-white ${spacious ? "text-xl" : "text-lg"}`}>{title}</h3>
          <button onClick={onClose} className="rounded-lg p-1.5 text-ink-500 hover:bg-white/5 hover:text-white">
            <X size={18} />
          </button>
        </div>
        <div className={`custom-scroll overflow-y-auto ${padX} ${padBottom}`}>{children}</div>
      </div>
    </div>
  );
}
