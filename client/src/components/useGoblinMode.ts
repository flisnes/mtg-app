import { useLiveQuery } from 'dexie-react-hooks';
import { getSetting, setSetting } from '../db/settings.js';

// Goblin mode (About & settings): unlocks the pile view — the collection as
// one scattered heap you dig through by hand. Off by default; humans get
// sorting and filtering, goblins get shiny chaos.

export const KEY_GOBLIN_MODE = 'goblinMode';

/** Reactive goblin-mode flag (false until the setting loads or is set). */
export function useGoblinMode(): boolean {
  return useLiveQuery(async () => (await getSetting<boolean>(KEY_GOBLIN_MODE)) === true, [], false);
}

export async function setGoblinMode(on: boolean): Promise<void> {
  await setSetting(KEY_GOBLIN_MODE, on);
}
