export default function AdminButton({ children, variant = "primary", className = "", icon: Icon, ...props }) {
  const base = "inline-flex items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium tracking-wide transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-admin-accent/60 disabled:opacity-50 disabled:cursor-not-allowed";
  const variants = {
    // primary/gold buttons keep a permanently-vivid gradient surface in
    // both themes, so their label uses a fixed literal color instead of
    // the theme-remapped `white` / `admin-950` tokens (see index.css).
    primary: "bg-gradient-to-b from-admin-accent to-admin-accent-deep text-[#fff] font-semibold shadow-[0_0_18px_rgba(168,85,247,0.3)] hover:shadow-[0_0_26px_rgba(168,85,247,0.45)] hover:brightness-110 active:brightness-95",
    secondary: "admin-panel text-ink-100 hover:border-admin-accent/50 hover:text-white",
    ghost: "text-ink-300 hover:text-white hover:bg-white/5",
    danger: "bg-signal-red/10 text-signal-red border border-signal-red/30 hover:bg-signal-red/20",
    gold: "bg-gradient-to-b from-admin-gold to-amber-600 text-[#0b0710] font-semibold shadow-[0_0_18px_rgba(245,158,11,0.3)] hover:brightness-110",
  };
  return (
    <button className={`${base} ${variants[variant]} ${className}`} {...props}>
      {Icon && <Icon size={16} strokeWidth={2} />}
      {children}
    </button>
  );
}
