import { randomInt } from 'node:crypto';
import { CODE_ALPHABET, CODE_LENGTH, type TradeErrorCode } from '@mtg/shared';

// Shared plumbing for the in-memory, code-keyed stores (trade sessions and
// device transfers): code allocation, per-IP quotas, TTL timers, and removal
// bookkeeping. Subclasses add their domain state on top.

export class TransitionError extends Error {
  constructor(public code: TradeErrorCode, message?: string) {
    super(message ?? code);
  }
}

export interface CodeEntry {
  code: string;
  ip: string;
  createdAt: number;
  ttlTimer?: ReturnType<typeof setTimeout>;
}

export abstract class CodeStore<T extends CodeEntry> {
  private entries = new Map<string, T>();
  private ipCounts = new Map<string, number>();

  constructor(private opts: { maxPerIp: number; ttlMs: number }) {}

  /** Invoked whenever an entry leaves the store, whatever triggered the removal. */
  onRemove?: (entry: T) => void;

  get(code: string): T | undefined {
    return this.entries.get(code);
  }

  /** Allocate a code, enforce the per-IP quota, insert the entry, arm its TTL. */
  protected register(ip: string, build: (code: string) => T): T {
    const count = this.ipCounts.get(ip) ?? 0;
    if (count >= this.opts.maxPerIp) throw new TransitionError('rate_limited', 'too many sessions');
    const entry = build(this.genCode());
    this.entries.set(entry.code, entry);
    this.ipCounts.set(ip, count + 1);
    entry.ttlTimer = setTimeout(() => this.remove(entry.code), this.opts.ttlMs);
    return entry;
  }

  private genCode(): string {
    for (let attempt = 0; attempt < 100; attempt++) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.entries.has(code)) return code;
    }
    throw new TransitionError('rate_limited', 'could not allocate a code');
  }

  remove(code: string): void {
    const entry = this.entries.get(code);
    if (!entry) return;
    if (entry.ttlTimer) clearTimeout(entry.ttlTimer);
    this.entries.delete(code);
    const count = (this.ipCounts.get(entry.ip) ?? 1) - 1;
    if (count <= 0) this.ipCounts.delete(entry.ip);
    else this.ipCounts.set(entry.ip, count);
    this.onRemove?.(entry);
  }
}
