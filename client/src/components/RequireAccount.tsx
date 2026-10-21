import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { AccountSession } from '../account/session.js';
import { useAccount } from '../account/useAccount.js';
import { EmptyState, Page } from '../routes/Page.js';

/**
 * The gate in front of every server-backed page: signed out (or a build with
 * no accounts) gets a pointer to Settings, the session still loading gets an
 * empty page under the same title, and signed in renders `children`.
 */
export function RequireAccount({
  title,
  subtitle,
  signedOutText,
  children,
}: {
  title: string;
  subtitle?: string;
  /** What signing in unlocks, e.g. "Sign in to view profiles." */
  signedOutText: string;
  children: (session: AccountSession) => ReactNode;
}) {
  const account = useAccount();

  if (!account.enabled || account.session === null) {
    return (
      <Page title={title} subtitle={subtitle}>
        <EmptyState hint={<Link to="/settings">Go to Settings</Link>}>
          {account.enabled ? signedOutText : 'Accounts aren’t configured for this build yet.'}
        </EmptyState>
      </Page>
    );
  }
  // Same title and subtitle as the loaded page, so the header doesn't jump when
  // the session resolves.
  if (account.session === undefined) return <Page title={title} subtitle={subtitle}>{null}</Page>;
  return <>{children(account.session)}</>;
}
