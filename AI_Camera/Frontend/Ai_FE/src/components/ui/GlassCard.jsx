export default function GlassCard({ children, className = "", strong = false, ...props }) {
  return (
    <div
      className={`${strong ? "glass-strong" : "glass"} rounded-2xl shadow-[0_8px_32px_rgba(0,0,0,0.35)] ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}
