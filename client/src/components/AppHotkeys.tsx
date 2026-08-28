import { useState } from 'react';
import { ShortcutsSheet } from './ShortcutsSheet.js';
import { useShortcuts } from './useShortcuts.js';
import { useViewMode } from './CardViews.js';

// The keys that belong to the app rather than to any one screen. Mounted once,
// inside the router, so they work wherever you are.
//
// Search's own keys (Ctrl+K and /) live with the search, because they need its
// context to open it.

export function AppHotkeys() {
  const [mode, setMode] = useViewMode();
  const [helpOpen, setHelpOpen] = useState(false);

  useShortcuts({
    // The list/grid preference is shared by every screen, so one key flips it
    // everywhere rather than each page owning its own.
    v: () => setMode(mode === 'grid' ? 'list' : 'grid'),
    // Shift+/ on most layouts.
    '?': () => setHelpOpen(true),
  });

  return helpOpen ? <ShortcutsSheet onClose={() => setHelpOpen(false)} /> : null;
}
