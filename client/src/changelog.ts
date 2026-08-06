// User-facing changelog for the "What's changed" popup (WhatsNewModal.tsx).
// Short, plain-spoken entries — not the fuller writeups in CHANGELOG.md at the
// repo root. Only versions from 0.98.0 onward are listed: every install still
// in the wild is already past that point, so nothing older needs a place here.
//
// Add an entry here on every version bump, same as CHANGELOG.md (see
// CLAUDE.md's Conventions section) — otherwise the popup silently has nothing
// to say about that release.
export type ChangeKind = 'added' | 'changed' | 'fixed' | 'removed';

export interface ChangelogChange {
  kind: ChangeKind;
  text: string;
}

export interface ChangelogEntry {
  version: string;
  changes: ChangelogChange[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.104.0',
    changes: [
      {
        kind: 'added',
        text: 'A “This deck/binder/box” pill in search, so you can search just that container’s cards. It never turns on by itself — tap it when you want it.',
      },
    ],
  },
  {
    version: '0.103.0',
    changes: [
      {
        kind: 'changed',
        text: '“In your collection” now jumps to a Collection search for that card’s name instead of guessing which copy to open.',
      },
    ],
  },
  {
    version: '0.100.1',
    changes: [
      {
        kind: 'fixed',
        text: 'The “What’s changed” popup itself: an install updating for the first time since it shipped looked like a fresh install, so it stayed quiet instead of showing what changed. It now shows the full list in that case.',
      },
    ],
  },
  {
    version: '0.100.0',
    changes: [
      {
        kind: 'added',
        text: 'This “What’s changed” popup, so an update tells you what’s different since you last opened the app.',
      },
    ],
  },
  {
    version: '0.99.0',
    changes: [
      {
        kind: 'changed',
        text: 'Scanning a card into a deck, binder or box now files that exact copy. Already filed elsewhere? You’re asked whether to move it or keep both.',
      },
    ],
  },
  {
    version: '0.98.1',
    changes: [
      {
        kind: 'fixed',
        text: 'Trading away a filed card now clears its filing automatically, when the app can tell which copy left.',
      },
    ],
  },
  {
    version: '0.98.0',
    changes: [
      {
        kind: 'added',
        text: 'Decks now have a Tokens section. Token-making cards suggest what they need, ready to file in one tap.',
      },
    ],
  },
];
