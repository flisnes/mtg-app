import type { ReactNode } from 'react';

// Shared page scaffold. Views are intentionally empty in Phase 0 — the goal is
// that every route navigates and renders its purpose.

export function Page({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children?: ReactNode;
}) {
  return (
    <section className="page">
      <header className="page-header">
        <h1>{title}</h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </header>
      <div className="page-body">{children}</div>
    </section>
  );
}

export function EmptyState({ phase, children }: { phase: string; children: ReactNode }) {
  return (
    <div className="empty-state">
      <p>{children}</p>
      <p className="empty-phase">Coming in {phase}.</p>
    </div>
  );
}
