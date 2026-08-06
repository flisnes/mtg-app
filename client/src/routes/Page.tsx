import type { ReactNode } from 'react';

// Shared page scaffold and empty-state placeholder.

export function Page({
  title,
  subtitle,
  menu,
  aside,
  children,
  fill,
}: {
  title: string;
  subtitle?: string;
  /** Page-specific options, top-right of the header (usually an OptionsMenu). */
  menu?: ReactNode;
  /** Extra header content shown left of the menu (e.g. a total-value readout). */
  aside?: ReactNode;
  children?: ReactNode;
  /**
   * Fill the viewport instead of scrolling with the rest of the app: the
   * header stays put and `.page-body` becomes a fixed-height flex column, so
   * only whatever the caller scrolls internally moves (e.g. the trade board's
   * independently-scrolling columns).
   */
  fill?: boolean;
}) {
  return (
    <section className={fill ? 'page page-fill' : 'page'}>
      <header className="page-header">
        <div className="page-header-text">
          <h1>{title}</h1>
          {subtitle && <p className="page-subtitle">{subtitle}</p>}
        </div>
        {(aside || menu) && (
          <div className="page-header-aside">
            {aside}
            {menu}
          </div>
        )}
      </header>
      <div className={fill ? 'page-body page-body-fill' : 'page-body'}>{children}</div>
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
