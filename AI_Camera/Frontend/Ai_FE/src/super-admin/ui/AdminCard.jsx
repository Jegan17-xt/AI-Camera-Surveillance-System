export default function AdminCard({ children, className = "", strong = false, ...props }) {
  return (
    <div
      className={`${strong ? "admin-panel-strong" : "admin-panel"} rounded-lg ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}
