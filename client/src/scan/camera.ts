import type { ScanIndex } from './blob.js';
import { runScanPipeline, type ScanPipelineResult } from './pipeline.js';

// Live camera scanning (handover §S3). An explicit user tap calls start() —
// never request the camera on mount. Frames are processed through the same
// pipeline as still photos; a match only surfaces after several consecutive
// frames agree (the main defence against foil glare and motion blur).

export type LiveScanState =
  | { status: 'starting' }
  | {
      status: 'scanning';
      cardSeen: boolean;
      lastDistance: number | null;
      frameMs: number;
      /** Agreeing frames banked so far, 0…CONSENSUS_FRAMES — the lock's progress bar. */
      streak: number;
    }
  | { status: 'locked'; result: ScanPipelineResult }
  | { status: 'error'; message: string };

/** Consecutive agreeing frames required to lock. */
export const CONSENSUS_FRAMES = 3;
/** Per-frame top-candidate distance must be at most this to count. */
const CONSENSUS_MAX_DISTANCE = 24;
/** Working resolution cap (full frame used for warping/hashing). */
const FULL_WIDTH = 1280;
const DETECT_WIDTH = 480;
/** Idle gap between processed frames — keeps the UI thread breathing. */
const FRAME_GAP_MS = 60;

/** One rear/front lens the browser will hand us, for the scan settings picker. */
export interface CameraOption {
  deviceId: string;
  label: string;
}

/**
 * Which lens the scanner opens. Multi-lens phones (Pixel, recent Galaxy) treat
 * `facingMode: environment` as "pick a rear camera for me" and then keep
 * swapping between the wide and the ultrawide as the focus distance drifts —
 * mid-pile that means half the frames come from the lens that can't resolve a
 * collector number. Pinning a deviceId takes the choice away from the OS.
 * `null` = no preference, back to facingMode.
 */
const CAMERA_PREF_KEY = 'scan-camera-device';

export function getPreferredCameraId(): string | null {
  try {
    return localStorage.getItem(CAMERA_PREF_KEY) || null;
  } catch {
    return null;
  }
}

export function setPreferredCameraId(id: string | null): void {
  try {
    if (id) localStorage.setItem(CAMERA_PREF_KEY, id);
    else localStorage.removeItem(CAMERA_PREF_KEY);
  } catch {
    /* private mode — the pin just won't survive the session */
  }
}

/**
 * Android Chrome labels its cameras "camera2 0, facing back", which is not a
 * thing to put in front of a user. Everything else (desktop, iOS) already has a
 * human label, so leave those alone.
 */
function prettyLabel(raw: string, index: number): string {
  const m = /^camera2?\s+(\d+),\s*facing\s+(back|front)$/i.exec(raw.trim());
  if (m) return `${m[2]!.toLowerCase() === 'back' ? 'Back' : 'Front'} camera ${Number(m[1]) + 1}`;
  return raw.trim() || `Camera ${index + 1}`;
}

/**
 * The cameras available to the picker. Labels are blank until the user has
 * granted camera access at least once, so call this while the scanner is live.
 */
export async function listCameras(): Promise<CameraOption[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'videoinput' && d.deviceId)
      .map((d, i) => ({ deviceId: d.deviceId, label: prettyLabel(d.label, i) }));
  } catch {
    return [];
  }
}

export class CameraScan {
  private stream: MediaStream | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  /** Set by stop(); checked after every await in start() so a teardown during
   *  the getUserMedia/play() gap releases the camera instead of leaking it. */
  private stopped = false;
  private streak: { id: string; distance: number; result: ScanPipelineResult }[] = [];
  private readonly fullCanvas = document.createElement('canvas');
  private readonly detectCanvas = document.createElement('canvas');

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly index: ScanIndex,
    private readonly onState: (s: LiveScanState) => void,
  ) {}

  /**
   * The pinned lens if there is one, otherwise "some rear camera". A pinned id
   * that no longer exists (new phone, browser rotated its ids) is dropped
   * rather than left to fail every start from here on.
   */
  private async openStream(): Promise<MediaStream> {
    const size = { width: { ideal: 1920 }, height: { ideal: 1080 } };
    const pinned = getPreferredCameraId();
    if (pinned) {
      try {
        return await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: pinned }, ...size }, audio: false });
      } catch {
        setPreferredCameraId(null);
      }
    }
    return navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, ...size }, audio: false });
  }

  /** Attach a fresh stream to the video element. Returns false if teardown won the race. */
  private async attach(stream: MediaStream): Promise<boolean> {
    // stop() may have run while getUserMedia was pending — don't leave the
    // just-granted camera on with no UI attached.
    if (this.stopped) {
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }
    this.stream = stream;
    this.video.srcObject = this.stream;
    try {
      await this.video.play();
    } catch {
      // Autoplay quirks — the attribute set + user gesture normally suffice.
    }
    if (this.stopped) {
      this.stop();
      return false;
    }
    return true;
  }

  /** Request the camera and begin scanning. Call from a user gesture. */
  async start(): Promise<void> {
    this.stopped = false;
    this.onState({ status: 'starting' });
    let stream: MediaStream;
    try {
      stream = await this.openStream();
    } catch (e) {
      this.onState({ status: 'error', message: e instanceof Error ? e.message : 'camera unavailable' });
      return;
    }
    if (!(await this.attach(stream))) return;
    this.resume();
  }

  /** The lens actually feeding the video, pinned or picked for us. */
  currentDeviceId(): string | null {
    return this.stream?.getVideoTracks()[0]?.getSettings().deviceId ?? null;
  }

  /**
   * Point the scanner at another lens mid-session (the scan settings picker),
   * and remember it. Only the stream swaps — the session, tray and pile pins
   * are untouched, so a wrong first guess costs a tap, not the pile.
   */
  async switchTo(deviceId: string | null): Promise<void> {
    setPreferredCameraId(deviceId);
    if (!this.stream || this.stopped) return;
    const wasRunning = this.running;
    this.pause();
    this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.onState({ status: 'starting' });
    let stream: MediaStream;
    try {
      stream = await this.openStream();
    } catch (e) {
      this.onState({ status: 'error', message: e instanceof Error ? e.message : 'camera unavailable' });
      return;
    }
    if (!(await this.attach(stream))) return;
    if (wasRunning) this.resume();
  }

  /** Continue scanning (also used after a locked result is confirmed/rejected). */
  resume(): void {
    if (this.stopped || !this.stream) return;
    this.streak = [];
    this.running = true;
    this.schedule();
  }

  /** Pause processing but keep the camera on (locked state). */
  pause(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Release the camera entirely. */
  stop(): void {
    this.stopped = true;
    this.pause();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => this.processFrame(), FRAME_GAP_MS);
  }

  private processFrame(): void {
    if (!this.running || !this.stream) return;
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) {
      this.schedule();
      return;
    }

    const t0 = performance.now();
    const scale = Math.min(1, FULL_WIDTH / vw);
    const fw = Math.round(vw * scale);
    const fh = Math.round(vh * scale);
    this.fullCanvas.width = fw;
    this.fullCanvas.height = fh;
    const fctx = this.fullCanvas.getContext('2d', { willReadFrequently: true })!;
    fctx.drawImage(this.video, 0, 0, fw, fh);
    const full = fctx.getImageData(0, 0, fw, fh);

    this.detectCanvas.width = DETECT_WIDTH;
    this.detectCanvas.height = Math.round((fh / fw) * DETECT_WIDTH);
    const dctx = this.detectCanvas.getContext('2d', { willReadFrequently: true })!;
    dctx.drawImage(this.fullCanvas, 0, 0, this.detectCanvas.width, this.detectCanvas.height);
    const detect = dctx.getImageData(0, 0, this.detectCanvas.width, this.detectCanvas.height);

    const out = runScanPipeline({ full, detect }, this.index);
    const frameMs = performance.now() - t0;
    const top = out.match.candidates[0];

    // Consensus: a streak of frames agreeing on the same card. A frame with no
    // quad or a distant match breaks the streak.
    if (out.quad && top && top.distance <= CONSENSUS_MAX_DISTANCE) {
      if (this.streak.length && this.streak[0]!.id !== top.scryfallId) this.streak = [];
      this.streak.push({ id: top.scryfallId, distance: top.distance, result: out });
    } else {
      this.streak = [];
    }

    if (this.streak.length >= CONSENSUS_FRAMES) {
      const bestFrame = this.streak.reduce((a, b) => (b.distance < a.distance ? b : a));
      this.pause();
      this.onState({ status: 'locked', result: this.withNativeFrame(bestFrame.result) });
      return;
    }

    this.onState({
      status: 'scanning',
      cardSeen: !!out.quad,
      lastDistance: top?.distance ?? null,
      frameMs,
      streak: this.streak.length,
    });
    this.schedule();
  }

  /**
   * Frames are processed at a capped resolution for speed, but OCR needs all
   * the detail the sensor has — swap the locked result's frame (and its quad
   * coordinates) for a native-resolution grab of the current video frame.
   */
  private withNativeFrame(result: ScanPipelineResult): ScanPipelineResult {
    const vw = this.video.videoWidth;
    const scale = vw / result.full.width;
    if (scale <= 1.01) return result;
    const canvas = document.createElement('canvas');
    canvas.width = vw;
    canvas.height = this.video.videoHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(this.video, 0, 0);
    const scalePoint = (p: { x: number; y: number }) => ({ x: p.x * scale, y: p.y * scale });
    return {
      ...result,
      full: ctx.getImageData(0, 0, canvas.width, canvas.height),
      warpQuad: result.warpQuad.map(scalePoint) as unknown as ScanPipelineResult['warpQuad'],
      quad: result.quad ? (result.quad.map(scalePoint) as unknown as ScanPipelineResult['quad']) : null,
    };
  }
}
