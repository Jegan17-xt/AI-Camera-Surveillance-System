import { X } from "lucide-react";

const sizeClass = {
  md: "max-w-lg",
  lg: "max-w-3xl",
  // ~800-900px — wide enough for a two-column form (e.g. Add/Edit Camera)
  // without feeling cramped, while still comfortably fitting a
  // 1366px-wide viewport with margin either side.
  xl: "max-w-[880px]",
};

export default function AdminModal({ open, onClose, title, children, size = "md" }) {
  if (!open) return null;
  // Mirrors components/ui/Modal.jsx: the default "md" size (max-w-lg) is
  // the one most likely to be viewed at very narrow widths (320-375px),
  // where a fixed px-8 (64px total) eats a disproportionate share of the
  // already-small panel. "lg"/"xl" stay at px-8 — those callers use them
  // deliberately for wider two-column forms.
  const spacious = size !== "md";
  const padX = spacious ? "px-8" : "px-6";
  const padTop = spacious ? "pt-8" : "pt-6";
  const padBottom = spacious ? "pb-8" : "pb-6";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/75" onClick={onClose} />
      {/* max-h + overflow-y-auto is what keeps this perfectly centered
          (via the wrapper's flex items-center) even when the form is
          taller than the viewport — e.g. at 1366x768 — instead of the
          panel's top edge being pushed off-screen with no way to reach
          it. Scrolls internally rather than the whole page. */}
      <div
        className={`admin-panel-strong relative flex max-h-[90vh] w-full ${sizeClass[size] || sizeClass.md} animate-admin-modal-in flex-col rounded-lg shadow-2xl`}
      >
        <div className={`flex shrink-0 items-center justify-between gap-4 ${padX} ${padTop} pb-5`}>
          <h3 className="font-display text-lg font-semibold text-white">{title}</h3>
          <button onClick={onClose} className="rounded-md p-1.5 text-ink-500 hover:bg-white/5 hover:text-white">
            <X size={18} />
          </button>
        </div>
        <div className={`custom-scroll overflow-y-auto ${padX} ${padBottom}`}>{children}</div>
      </div>
    </div>
  );
}
