// The DeckBehavior row id, apart from behavior.ts: the sync engine and
// dataAccess need it at boot, and importing anything from behavior.ts keeps
// its vocabulary tables (40 kB) in the boot chunk.
export const deckBehaviorId = (deckId: string, oracleId: string): string => `${deckId}:${oracleId}`;
