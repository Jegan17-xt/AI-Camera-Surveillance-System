// Compact two-option segmented control — [ Enabled | Disabled ] — used
// everywhere a Super Admin flips a boolean (Module Access & Billing, AI
// Config, catalog item enabled/disabled) so every one of those controls
// shares this exact size, alignment, and behavior — never a
// per-instance variant. Same public API as the sliding-switch design it
// replaces (`checked`/`onChange`/`label`/`description`/`disabled`), so
// every existing caller works unchanged.
export default function AdminToggle({ checked = false, onChange, label, description, disabled = false }) {
  const segmentBase =
    "px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide rounded-md transition-all duration-200 disabled:cursor-not-allowed";

  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div>
        <p className="text-sm font-medium text-ink-100">{label}</p>
        {description && <p className="text-xs text-ink-500">{description}</p>}
      </div>

      <div
        role="group"
        aria-label={typeof label === "string" ? label : "Module access"}
        // Opacity only fades the group while it's resolved to Disabled —
        // a group resolved to Enabled always stays at full brightness,
        // disabled or not (a permanently-on control, e.g. an "Always
        // Unlocked" module, must read as clearly enabled, not washed
        // out next to every other active control beside it).
        className={`inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-white/10 bg-white/[0.03] p-0.5 transition-opacity duration-200 ${
          disabled && !checked ? "opacity-50" : ""
        }`}
      >
        <button
          type="button"
          disabled={disabled}
          aria-pressed={checked}
          onClick={() => !checked && onChange?.(true)}
          className={`${segmentBase} ${
            checked ? "bg-admin-accent text-white" : "text-ink-500 enabled:hover:text-ink-300"
          }`}
        >
          Enabled
        </button>
        <button
          type="button"
          disabled={disabled}
          aria-pressed={!checked}
          onClick={() => checked && onChange?.(false)}
          className={`${segmentBase} ${
            !checked ? "bg-white/10 text-ink-300" : "text-ink-500 enabled:hover:text-ink-300"
          }`}
        >
          Disabled
        </button>
      </div>
    </div>
  );
}
