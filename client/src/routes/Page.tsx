import type { ReactNode } from 'react';

// Shared page scaffold and empty-state placeholder.

export function Page({
  title,
  subtitle,
  menu,
  children,
}: {
  title: string;
  subtitle?: string;
  /** Page-specific options, top-right of the header (usually an OptionsMenu). */
  menu?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="page">
      <header className="page-header">
        <div className="page-header-text">
          <h1>{title}</h1>
          {subtitle && <p className="page-subtitle">{subtitle}</p>}
        </div>
        {menu}
      </header>
      <div className="page-body">{children}</div>
    </section>
  );
}

export function EmptyState({ hint, children }: { hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="empty-state">
      <p>{children}</p>
      {hint && <p className="empty-phase">{hint}</p>}
    </div>
  );
}
