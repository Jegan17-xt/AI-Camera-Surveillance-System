export default function Button({ children, variant = "primary", className = "", icon: Icon, ...props }) {
  const base = "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/60 disabled:opacity-50 disabled:cursor-not-allowed";
  const variants = {
    primary: "bg-gradient-to-b from-accent-cyan to-accent-blue text-base-950 font-semibold shadow-[0_0_20px_rgba(34,211,238,0.25)] hover:shadow-[0_0_28px_rgba(34,211,238,0.4)] hover:brightness-110 active:brightness-95",
    secondary: "glass text-ink-100 hover:border-accent-cyan/40 hover:text-white",
    ghost: "text-ink-300 hover:text-white hover:bg-white/5",
    danger: "bg-signal-red/10 text-signal-red border border-signal-red/30 hover:bg-signal-red/20",
  };
  return (
    <button className={`${base} ${variants[variant]} ${className}`} {...props}>
      {Icon && <Icon size={16} strokeWidth={2} />}
      {children}
    </button>
  );
}
