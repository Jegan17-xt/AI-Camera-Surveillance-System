import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Check } from "lucide-react";
import { useDropdownPosition } from "./useDropdownPosition";

// Generic themed replacement for a native <select> in the Admin/User
// portal — same custom-listbox approach as UserSelect, generalized over
// arbitrary options instead of a Users list. A native select's OPEN
// dropdown is drawn by the browser/OS using its own light-themed chrome,
// which CSS on the <select>/<option> elements can't reliably restyle;
// this renders its own listbox instead, always matching this portal's
// dark theme.
//
// The open panel is rendered via a React portal straight into
// document.body, positioned with `fixed` coordinates measured from the
// trigger's own bounding box — see UserSelect.jsx for the full
// explanation: every GlassCard's `.glass`/`.glass-strong` sets
// `backdrop-filter`, which creates its own stacking context, trapping an
// in-place `position: absolute` panel inside its own card so a LATER
// sibling card painted over it. Portaling to document.body escapes that
// entirely.
//
// `onChange` keeps the native-<select> event shape ({ target: { value } })
// so it's a drop-in replacement at existing call sites.
export default function Select({
  value,
  onChange,
  options,
  placeholder = "Select…",
  disabled = false,
  className = "w-full",
}) {
  const [open, setOpen] = useState(false);
  const [hoveredValue, setHoveredValue] = useState(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);

  const panelRect = useDropdownPosition(triggerRef, open);

  useEffect(() => {
    if (!open) return;
    setHoveredValue(null);

    const handlePointerDown = (e) => {
      const insideTrigger = triggerRef.current && triggerRef.current.contains(e.target);
      const insidePanel = panelRef.current && panelRef.current.contains(e.target);
      if (!insideTrigger && !insidePanel) setOpen(false);
    };

    const handleKeyDown = (e) => {
      if (e.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const normalizedOptions = options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  const selected = normalizedOptions.find((o) => o.value === value);

  const selectValue = (v) => {
    onChange({ target: { value: v } });
    setOpen(false);
  };

  // Mounted from the first open onward (not re-conditioned on `open`
  // itself) so open/close stays a pure CSS transition instead of an
  // abrupt mount/unmount, exactly as before — only WHERE it renders
  // (portaled, fixed-positioned) changed, not how it animates.
  const panel = panelRect &&
    createPortal(
      <div
        ref={panelRef}
        role="listbox"
        style={{
          position: "fixed",
          left: panelRect.left,
          width: panelRect.width,
          ...(panelRect.openUpward ? { bottom: panelRect.bottom } : { top: panelRect.top }),
        }}
        className={`z-50 rounded-xl border border-white/10 bg-base-900 p-1.5 shadow-2xl transition-all duration-150 ease-out ${
          panelRect.openUpward ? "origin-bottom" : "origin-top"
        } ${
          open
            ? "pointer-events-auto translate-y-0 scale-100 opacity-100"
            : `pointer-events-none scale-95 opacity-0 ${panelRect.openUpward ? "translate-y-1" : "-translate-y-1"}`
        }`}
      >
        {/* Hover highlight is JS-driven (onMouseEnter/Leave + inline style),
            not a `hover:` CSS class — see UserSelect.jsx for why: a
            `transition-colors` class on these rows left the browser's
            computed background-color stuck at its pre-transition
            (transparent) value even while genuinely hovered, so `:hover`
            utilities never visibly rendered. Deliberately no
            `transition-colors` on these option rows. */}
        <div className="custom-scroll space-y-0.5 overflow-y-auto" style={{ maxHeight: panelRect.maxHeight }}>
          {normalizedOptions.map((option) => {
            const isSelected = option.value === value;
            const isHovered = hoveredValue === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => selectValue(option.value)}
                onMouseEnter={() => setHoveredValue(option.value)}
                onMouseLeave={() => setHoveredValue(null)}
                style={!isSelected && isHovered ? { backgroundColor: "rgba(255,255,255,0.1)" } : undefined}
                className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-left text-sm ${
                  isSelected ? "bg-accent-cyan/15 text-accent-cyan" : isHovered ? "text-white" : "text-ink-200"
                }`}
              >
                <span className="truncate">{option.label}</span>
                {isSelected && <Check size={14} className="shrink-0 text-accent-cyan" />}
              </button>
            );
          })}

          {normalizedOptions.length === 0 && (
            <p className="px-3 py-2.5 text-xs text-ink-500">No options available.</p>
          )}
        </div>
      </div>,
      document.body
    );

  return (
    <div ref={triggerRef} className={`relative ${className}`}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex w-full items-center justify-between gap-2 rounded-xl glass px-3.5 py-2.5 text-left text-sm outline-none transition-colors focus:border-accent-cyan/50 focus:ring-2 focus:ring-accent-cyan/20 disabled:cursor-not-allowed disabled:opacity-50 ${
          open ? "border-accent-cyan/50 ring-2 ring-accent-cyan/20" : ""
        }`}
      >
        <span className={`truncate ${selected ? "text-ink-100" : "text-ink-500"}`}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown
          size={14}
          className={`shrink-0 text-ink-500 transition-transform duration-200 ${open ? "rotate-180 text-accent-cyan" : ""}`}
        />
      </button>

      {panel}
    </div>
  );
}
