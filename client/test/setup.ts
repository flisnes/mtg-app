// Dexie captures indexedDB from globalThis, so the shim must land before any
// test file imports db/schema.ts. Vitest runs setup files first, which is why
// this lives here and not at the top of each test.
import 'fake-indexeddb/auto';
