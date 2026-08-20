import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Check } from "lucide-react";
import { useDropdownPosition } from "./useDropdownPosition";

// The one User dropdown primitive for the Admin module — same rendering
// everywhere a User needs to be picked, whether that's a labeled form
// field (Camera/Registered Person "Assign to User") or a compact,
// icon-led header filter (the page-header "view as" selector).
//
// A CUSTOM-rendered listbox, not a native <select> — a native select's
// OPEN dropdown is drawn by the browser/OS using its own light-themed
// chrome, which plain CSS on the <select>/<option> elements cannot
// reliably reach or restyle (that's the "white background, invisible
// text, no real hover state" bug this replaces). Built on this portal's
// own dark-theme tokens (glass/glass-strong/accent-cyan/ink-*) — the
// same tokens every other panel in this app already uses — so it's
// always dark, high-contrast, and gets real, fully custom hover/
// selected states, not whatever the OS happens to render.
//
// The open panel is rendered via a React portal straight into
// document.body, positioned with `fixed` coordinates measured from the
// trigger's own bounding box — NOT nested inside this component's own
// DOM tree. Every GlassCard on this portal uses `.glass`/`.glass-strong`,
// which set `backdrop-filter` — a CSS property that creates a brand new
// stacking context on the element it's applied to, regardless of
// position/z-index. That trapped an in-place `position: absolute`
// dropdown panel inside its own card's local stacking context, so any
// LATER sibling card (each with its own backdrop-filter-created context)
// painted over it — the "dropdown hidden behind the cards below" bug.
// Portaling to document.body escapes every ancestor's stacking context
// entirely, so the panel always paints above all page content.
//
// `onChange` keeps the exact native-<select> event shape
// ({ target: { value } }) on purpose, so every existing call site
// (UserScopeSelector, Camera Management, Registered Persons) keeps
// working completely unchanged — this is a rendering swap only, the
// value/onChange contract and all business logic are identical to
// before.
export default function UserSelect({
  users,
  value,
  onChange,
  label,
  emptyOptionLabel,
  icon: Icon,
  className = "",
  title,
  // Only meaningful in the no-`label` ("compact") mode, which otherwise
  // hardcodes a fixed w-44 (matching the header "view as" filter this
  // was originally built for) — set this when the compact trigger needs
  // to stretch instead, e.g. sitting alongside other full-width filter
  // inputs in a grid. Defaults to false so every existing compact call
  // site (UserScopeSelector, etc.) is completely unaffected.
  fullWidth = false,
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

  const normalizedValue = value === null || value === undefined ? "" : String(value);
  const options = users.map((u) => ({ value: String(u.id), label: u.name }));
  const selectedOption = options.find((o) => o.value === normalizedValue);
  const displayLabel = selectedOption ? selectedOption.label : emptyOptionLabel || "Select…";

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
        <div className="custom-scroll space-y-0.5 overflow-y-auto" style={{ maxHeight: panelRect.maxHeight }}>
          {/* Hover highlight below is JS-driven (onMouseEnter/Leave + inline
              style), not a `hover:` CSS class — a `transition-colors` class
              on these rows left the browser's computed background-color
              stuck at its pre-transition (transparent) value even once
              hovered, so `:hover` utilities never visibly rendered here.
              Deliberately no `transition-colors` on these option rows. */}
          {emptyOptionLabel && (
            <button
              type="button"
              role="option"
              aria-selected={normalizedValue === ""}
              onClick={() => selectValue("")}
              onMouseEnter={() => setHoveredValue("")}
              onMouseLeave={() => setHoveredValue(null)}
              style={normalizedValue !== "" && hoveredValue === "" ? { backgroundColor: "rgba(255,255,255,0.1)" } : undefined}
              className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-left text-sm ${
                normalizedValue === ""
                  ? "bg-accent-cyan/15 text-accent-cyan"
                  : hoveredValue === ""
                    ? "text-white"
                    : "text-ink-200"
              }`}
            >
              <span>{emptyOptionLabel}</span>
              {normalizedValue === "" && <Check size={14} className="shrink-0 text-accent-cyan" />}
            </button>
          )}

          {options.map((option) => {
            const isSelected = option.value === normalizedValue;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => selectValue(option.value)}
                onMouseEnter={() => setHoveredValue(option.value)}
                onMouseLeave={() => setHoveredValue(null)}
                style={!isSelected && hoveredValue === option.value ? { backgroundColor: "rgba(255,255,255,0.1)" } : undefined}
                className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-left text-sm ${
                  isSelected
                    ? "bg-accent-cyan/15 text-accent-cyan"
                    : hoveredValue === option.value
                      ? "text-white"
                      : "text-ink-200"
                }`}
              >
                <span className="truncate">{option.label}</span>
                {isSelected && <Check size={14} className="shrink-0 text-accent-cyan" />}
              </button>
            );
          })}

          {options.length === 0 && (
            <p className="px-3 py-2.5 text-xs text-ink-500">No Users available.</p>
          )}
        </div>
      </div>,
      document.body
    );

  const dropdown = (
    <div ref={triggerRef} className={`relative ${label || fullWidth ? "w-full" : "w-44"}`}>
      <button
        type="button"
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex w-full items-center justify-between gap-2 rounded-xl glass px-3.5 py-2.5 text-left text-sm outline-none transition-colors focus:border-accent-cyan/50 focus:ring-2 focus:ring-accent-cyan/20 ${
          open ? "border-accent-cyan/50 ring-2 ring-accent-cyan/20" : ""
        }`}
      >
        <span className={`truncate ${selectedOption ? "text-ink-100" : "text-ink-500"}`}>{displayLabel}</span>
        <ChevronDown
          size={14}
          className={`shrink-0 text-ink-500 transition-transform duration-200 ${open ? "rotate-180 text-accent-cyan" : ""}`}
        />
      </button>

      {panel}
    </div>
  );

  if (label) {
    return (
      <div className={className}>
        <label className="mb-1.5 block text-xs font-medium text-ink-400">{label}</label>
        {dropdown}
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {Icon && <Icon size={14} className="shrink-0 text-ink-500" />}
      {dropdown}
    </div>
  );
}
