// The single mutation path for user data (beta plan §4). All invariants live
// here, never in UI code, so that trade completion (Phase 4) reuses the exact
// same functions:
//   - tradelist IS quantityForTrade on a CollectionEntry (0..quantity)
//   - collection entries unique on (scryfallId, condition, finish, lang) plus
//     their special conditions (collectionKey vs entryKey, in keys.ts)
//   - "owned" = sum of quantity over all entries with a matching oracleId
//
// Since the sync + history plan, every mutation here also does two more
// things, in the same transaction:
//   - stages the touched rows in the sync outbox (sync/outbox.ts), and
//   - emits UserEvents (the card history: adds/removes with the market price
//    at that moment, deck ins/outs, wishlist journey).
// Changes received FROM sync are applied directly to the tables, never through
// these functions, so they are not re-staged or re-evented.
//
// This file is the barrel. The code lives in one module per table:
//   keys.ts             identity keys, ids, slot keys
//   write.ts            putSynced/deleteSynced, the write context, transaction scopes
//   events.ts           event builders, wish.fulfilled, prices on events
//   collectionWrites.ts collection, tradelist, imports
//   wishlistWrites.ts   wishlist
//   containerWrites.ts  decks, binders, boxes, folders, archive
//   slotWrites.ts       deck slots: add, reconcile, move, patch, tags, for-trade
//   behaviorWrites.ts   per-deck card behavior
//   tradeWrites.ts      trade completion
//   undo.ts             undo/redo of history entries
//   sealedWrites.ts     sealed products
//   userData.ts         wipe and replace everything

export { newId, collectionKey, entryKey, exactSlotKey, slotKey, wishKey } from './keys.js';
export type { CopyRef, SlotWants } from './keys.js';
export type { BatchMeta } from './write.js';
export { editUserEvent } from './events.js';
export {
  addToCollection,
  updateCollectionEntry,
  removeFromCollection,
  setQuantityForTrade,
  setQuantityForTradeBulk,
  markOwnedForTrade,
  removeCollectionEntriesBulk,
  applyImport,
  clearTradelist,
} from './collectionWrites.js';
export type { AddToCollectionInput, MarkForTradeRequest, ImportLine } from './collectionWrites.js';
export { addToWishlist, addToWishlistBulk, updateWishlistEntry, removeFromWishlist } from './wishlistWrites.js';
export type { AddToWishlistInput, WishlistBulkLine } from './wishlistWrites.js';
export {
  createContainer,
  renameDeck,
  setDeckFormat,
  tidyDeckBoards,
  setDeckEmblem,
  deleteDeck,
  createDeckFolder,
  renameDeckFolder,
  deleteDeckFolder,
  setDeckFolder,
  setDeckArchived,
  unfileWholeContainer,
  countFiledCopies,
} from './containerWrites.js';
export { setCardBehavior } from './behaviorWrites.js';
export {
  addDeckCard,
  addDeckCardsBulk,
  reconcileDeck,
  moveDeckCard,
  moveDeckCardsToContainer,
  moveDeckCardsBulk,
  setDeckCardQuantity,
  setDeckCardChosenColor,
  updateDeckCard,
  setDeckCardsUnfiled,
  tagDeckCards,
  renameDeckCardTag,
  deleteDeckCardTag,
  removeDeckCard,
  removeDeckCardsBulk,
  removeDeckCardsMatching,
  setContainerForTrade,
  setDeckCardsForTrade,
} from './slotWrites.js';
export type { AddDeckCardInput } from './slotWrites.js';
export { applyCompletedTrade } from './tradeWrites.js';
export { undoEntry, redoEntry } from './undo.js';
export type { UndoRef, UndoResult, RedoInput, RedoResult } from './undo.js';
export { addSealedItem, setSealedItemQuantity, removeSealedItem } from './sealedWrites.js';
export type { SealedItemInput } from './sealedWrites.js';
export { replaceAllUserData, deleteAllUserData } from './userData.js';
