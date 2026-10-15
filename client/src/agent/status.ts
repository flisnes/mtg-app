// The eager half of the agent bridge: the status store Settings reads, and the
// launch hook that loads bridge.ts (tools, registry, socket) only once the
// pref is on. Off by default, so most phones never download the rest.

import { getPrefs, subscribePrefs } from '../prefs.js';

/**
 * off: pref disabled. waiting: enabled, no bridge answering (it only runs
 * while a Claude Code session has spawned it). connected: live. replaced:
 * another tab took over; this one stays quiet until re-enabled or reloaded.
 */
export type AgentStatus = 'off' | 'waiting' | 'connected' | 'replaced';

let status: AgentStatus = 'off';
const statusListeners = new Set<() => void>();

export function setAgentStatus(next: AgentStatus): void {
  if (status === next) return;
  status = next;
  statusListeners.forEach((cb) => cb());
}

export function getAgentStatusSnapshot(): AgentStatus {
  return status;
}

export function subscribeAgentStatus(cb: () => void): () => void {
  statusListeners.add(cb);
  return () => statusListeners.delete(cb);
}

let started = false;

/** Called once from App.tsx: no-op until the pref is (or becomes) on. */
export function initAgentBridge(): void {
  if (started) return;
  const load = () => {
    if (started || !getPrefs().agentBridge) return;
    started = true;
    unsubscribe();
    void import('./bridge.js').then((m) => m.initAgentBridge());
  };
  const unsubscribe = subscribePrefs(load);
  load();
}
