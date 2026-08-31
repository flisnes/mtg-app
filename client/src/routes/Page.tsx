import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

// Shared page scaffold and empty-state placeholder.

/**
 * A list page's row count belongs on the header line under the title, not on a
 * line of its own above the cards — the grid is what people came here for.
 * Routes that know their own count pass Page's `meta`; views that count their
 * own rows (CollectionListView) push the line up with `usePageMeta`.
 */
const MetaCtx = createContext<((text: string) => void) | null>(null);

/** Hoist a count line into the surrounding Page header. Returns false when
 *  there is no Page above (render the line yourself then). */
export function usePageMeta(text: string): boolean {
  const set = useContext(MetaCtx);
  useEffect(() => {
    if (!set) return;
    set(text);
    return () => set('');
  }, [set, text]);
  return !!set;
}

export function Page({
  title,
  subtitle,
  meta,
  menu,
  aside,
  children,
  fill,
}: {
  title: string;
  subtitle?: string;
  /** Small count line under the title, e.g. "127 cards". */
  meta?: string;
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
  const [pushed, setPushed] = useState('');
  const metaLine = meta || pushed;
  return (
    <section className={fill ? 'page page-fill' : 'page'}>
      <header className="page-header">
        <div className="page-header-text">
          <h1>{title}</h1>
          {metaLine && <p className="page-meta">{metaLine}</p>}
          {subtitle && <p className="page-subtitle">{subtitle}</p>}
        </div>
        {(aside || menu) && (
          <div className="page-header-aside">
            {aside}
            {menu}
          </div>
        )}
      </header>
      <div className={fill ? 'page-body page-body-fill' : 'page-body'}>
        <MetaCtx.Provider value={setPushed}>{children}</MetaCtx.Provider>
      </div>
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
