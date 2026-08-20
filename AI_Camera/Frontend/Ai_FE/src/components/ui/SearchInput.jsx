import { Search } from "lucide-react";

export default function SearchInput({ value, onChange, placeholder = "Search…", className = "" }) {
  return (
    <div className={`relative ${className}`}>
      <Search className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-500" size={16} />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-xl glass py-2.5 pl-10 pr-4 text-sm text-ink-100 placeholder:text-ink-500 outline-none focus:border-accent-cyan/50 focus:ring-2 focus:ring-accent-cyan/20 transition"
      />
    </div>
  );
}
