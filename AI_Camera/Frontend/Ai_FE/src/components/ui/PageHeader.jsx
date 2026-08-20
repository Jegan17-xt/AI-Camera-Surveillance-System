export default function PageHeader({ eyebrow, title, description, actions }) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        {eyebrow && (
          <p className="mb-1.5 font-mono text-xs uppercase tracking-[0.2em] text-accent-cyan/80">{eyebrow}</p>
        )}
        <h1 className="font-display text-2xl font-semibold text-white sm:text-3xl">{title}</h1>
        {description && <p className="mt-1.5 max-w-xl text-sm text-ink-500">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-3">{actions}</div>}
    </div>
  );
}
