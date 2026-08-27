import { useEffect, useRef, useSyncExternalStore } from 'react';
import { overlayOpen } from '../components/useDismiss.js';
import {
  CLIPBOARD_MIME,
  cutSlotIds,
  heldFor,
  hold,
  isPayload,
  payloadText,
  subscribeClipboard,
  type ClipboardPayload,
  type ClipboardSlot,
} from './cardClipboard.js';

// Ctrl+C / Ctrl+X / Ctrl+V on a container page.
//
// These ride the browser's own copy/cut/paste events rather than the shortcut
// registry, because that's the only way to reach clipboardData: on those events
// it's handed over freely, while navigator.clipboard has to ask permission and
// Firefox declines to read at all. It also lets one copy write two formats at
// once, which is the point (see cardClipboard.ts).
//
// The same guards the shortcut registry applies are applied here by hand, plus
// one these events need and keys don't: if the user has selected text on the
// page, Ctrl+C is theirs. Hijacking a copy of a card's rules text to hand back
// a decklist would be its own small betrayal.

export interface ClipboardHandlers {
  /** The slots Ctrl+C should write, or null when there's nothing to copy. */
  onCopy: () => ClipboardSlot[] | null;
  /** The slots Ctrl+X marks, with the ids (and container) paste will move. */
  onCut: () => { slots: ClipboardSlot[]; slotIds: string[]; containerId: string } | null;
  /** Structured cards arriving from this app. */
  onPastePayload: (payload: ClipboardPayload) => void;
  /** Anything else on the clipboard, handed over as written. */
  onPasteText: (text: string) => void;
  /** Off while the page is still loading. */
  enabled?: boolean;
}

function textSelected(): boolean {
  const sel = window.getSelection();
  return !!sel && !sel.isCollapsed && sel.toString().trim().length > 0;
}

function typingInto(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
}

export function useCardClipboard(handlers: ClipboardHandlers): void {
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    const busy = (e: ClipboardEvent) =>
      latest.current.enabled === false || overlayOpen() || typingInto(e.target) || !e.clipboardData;

    function write(e: ClipboardEvent, payload: ClipboardPayload): void {
      const text = payloadText(payload.slots);
      e.clipboardData!.setData('text/plain', text);
      // Best effort: a browser that refuses the custom type still leaves the
      // decklist behind, and paste falls back to reading that.
      try {
        e.clipboardData!.setData(CLIPBOARD_MIME, JSON.stringify(payload));
      } catch {
        /* text/plain is enough */
      }
      hold(payload, text);
      e.preventDefault();
    }

    const onCopy = (e: ClipboardEvent) => {
      if (busy(e) || textSelected()) return;
      const slots = latest.current.onCopy();
      if (!slots?.length) return;
      write(e, { app: 'mtg-pwa', v: 1, slots });
    };

    const onCut = (e: ClipboardEvent) => {
      if (busy(e) || textSelected()) return;
      const cut = latest.current.onCut();
      if (!cut?.slots.length) return;
      write(e, {
        app: 'mtg-pwa',
        v: 1,
        slots: cut.slots,
        cut: { containerId: cut.containerId, slotIds: cut.slotIds },
      });
    };

    const onPaste = (e: ClipboardEvent) => {
      if (busy(e)) return;
      const text = e.clipboardData!.getData('text/plain');
      let payload: ClipboardPayload | null = null;
      const raw = e.clipboardData!.getData(CLIPBOARD_MIME);
      if (raw) {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (isPayload(parsed)) payload = parsed;
        } catch {
          /* fall through to the text */
        }
      }
      // No custom format (or a browser that dropped it): fall back to the copy
      // we kept, but only while the plain text still proves it's the same copy.
      payload ??= heldFor(text);
      if (payload) {
        e.preventDefault();
        latest.current.onPastePayload(payload);
        return;
      }
      if (!text.trim()) return;
      e.preventDefault();
      latest.current.onPasteText(text);
    };

    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCut);
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCut);
      document.removeEventListener('paste', onPaste);
    };
  }, []);
}

/** Which of this container's slots are sitting marked for a cut. */
export function useCutSlots(containerId: string): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribeClipboard,
    () => cutSlotIds(containerId),
    () => cutSlotIds(containerId),
  );
}
