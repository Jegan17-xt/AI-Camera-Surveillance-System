import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";

// A themed replacement for a native <select> — browsers render a native
// select's open dropdown using OS chrome, which ignores this app's
// admin-panel/admin-accent theme entirely (hence the "white background,
// theme doesn't match" complaint this fixes). Built on the same
// admin-panel-strong / ink / admin-accent tokens as the rest of the
// Admin Portal, so it also respects the Admin Portal's light/dark theme
// toggle automatically instead of hardcoding a fixed dark palette.
export default function AdminSelect({ value, onChange, options, placeholder = "Select…", disabled = false, className = "", triggerClassName = "" }) {
  const [open, setOpen] = useState(false);
  const [hoveredValue, setHoveredValue] = useState(null);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setHoveredValue(null);

    const handlePointerDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        setOpen(false);
      }
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

  const selected = options.find((o) => o.value === value);

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`flex w-full items-center justify-between gap-2 rounded-md admin-panel px-3.5 py-3 text-left text-sm outline-none transition-colors focus:border-admin-accent/50 focus:ring-2 focus:ring-admin-accent/20 disabled:cursor-not-allowed disabled:opacity-50 ${triggerClassName} ${
          open ? "border-admin-accent/50 ring-2 ring-admin-accent/20" : ""
        }`}
      >
        <span className={selected ? "text-ink-100" : "text-ink-500"}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown
          size={16}
          className={`shrink-0 text-ink-500 transition-transform duration-200 ${open ? "rotate-180 text-admin-accent" : ""}`}
        />
      </button>

      {/* Always mounted (not conditionally rendered) so the open/close
          state is a pure CSS transition on opacity/scale/translate,
          rather than an abrupt mount/unmount with no animation. */}
      <div
        role="listbox"
        className={`absolute left-0 right-0 z-20 mt-2 origin-top rounded-lg admin-panel-strong p-1.5 shadow-2xl transition-all duration-150 ease-out ${
          open ? "pointer-events-auto translate-y-0 scale-100 opacity-100" : "pointer-events-none -translate-y-1 scale-95 opacity-0"
        }`}
      >
        {/* Hover highlight is JS-driven (onMouseEnter/Leave + inline style),
            not a `hover:` CSS class — a `transition-colors` class on these
            rows left the browser's computed background-color stuck at its
            pre-transition (transparent) value even while genuinely
            hovered, so `:hover` utilities never visibly rendered.
            Deliberately no `transition-colors` on these option rows. The
            inline color-mix() (not a fixed rgba literal) keeps this
            correct in both the light and dark Admin Portal themes, since
            --color-admin-accent is redefined per theme. */}
        <div className="custom-scroll max-h-60 space-y-0.5 overflow-y-auto">
          {options.map((option) => {
            const isSelected = option.value === value;
            const isHovered = hoveredValue === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                onMouseEnter={() => setHoveredValue(option.value)}
                onMouseLeave={() => setHoveredValue(null)}
                style={!isSelected && isHovered ? { backgroundColor: "color-mix(in srgb, var(--color-admin-accent) 12%, transparent)" } : undefined}
                className={`flex w-full items-center justify-between gap-2 rounded-md px-3 py-2.5 text-left text-sm ${
                  isSelected ? "bg-admin-accent/15 text-admin-accent" : isHovered ? "text-white" : "text-ink-200"
                }`}
              >
                <span>{option.label}</span>
                {isSelected && <Check size={14} className="shrink-0 text-admin-accent" />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
