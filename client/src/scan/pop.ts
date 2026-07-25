// A short, pleasant "pop" for the scan tray: every time a card is added to the
// session list we blip a sine so the user gets audible confirmation without
// looking away from the pile. The pitch climbs a semitone per copy already in
// the pile (capped at +10) so a stack of the same card sounds like a little
// rising run — satisfying, and a cue that you're piling duplicates.

let ctx: AudioContext | null = null;

function audioCtx(): AudioContext | null {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx ??= new Ctor();
    // The context starts suspended until a user gesture; a tap on a tile counts.
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/**
 * Play the pop. `step` (0-based) raises the pitch: 0 for the first copy, +1
 * semitone per extra copy, clamped to +10.
 */
export function playPop(step: number): void {
  const ac = audioCtx();
  if (!ac) return;
  const semis = Math.min(Math.max(Math.round(step), 0), 10);
  const freq = 523.25 * Math.pow(2, semis / 12); // C5, up by `semis` semitones
  const t = ac.currentTime;
  try {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    // A tiny downward glide gives it a rounded "pop" rather than a flat beep.
    osc.frequency.setValueAtTime(freq * 1.5, t);
    osc.frequency.exponentialRampToValueAtTime(freq, t + 0.06);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.22, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    osc.connect(gain).connect(ac.destination);
    osc.start(t);
    osc.stop(t + 0.18);
  } catch {
    /* audio not available — silent is fine */
  }
}
