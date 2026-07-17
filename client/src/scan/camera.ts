import type { ScanIndex } from './blob.js';
import { runScanPipeline, type ScanPipelineResult } from './pipeline.js';

// Live camera scanning (handover §S3). An explicit user tap calls start() —
// never request the camera on mount. Frames are processed through the same
// pipeline as still photos; a match only surfaces after several consecutive
// frames agree (the main defence against foil glare and motion blur).

export type LiveScanState =
  | { status: 'starting' }
  | { status: 'scanning'; cardSeen: boolean; lastDistance: number | null; frameMs: number }
  | { status: 'locked'; result: ScanPipelineResult }
  | { status: 'error'; message: string };

/** Consecutive agreeing frames required to lock. */
const CONSENSUS_FRAMES = 3;
/** Per-frame top-candidate distance must be at most this to count. */
const CONSENSUS_MAX_DISTANCE = 24;
/** Working resolution cap (full frame used for warping/hashing). */
const FULL_WIDTH = 1280;
const DETECT_WIDTH = 480;
/** Idle gap between processed frames — keeps the UI thread breathing. */
const FRAME_GAP_MS = 60;

export class CameraScan {
  private stream: MediaStream | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private streak: { id: string; distance: number; result: ScanPipelineResult }[] = [];
  private readonly fullCanvas = document.createElement('canvas');
  private readonly detectCanvas = document.createElement('canvas');

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly index: ScanIndex,
    private readonly onState: (s: LiveScanState) => void,
  ) {}

  /** Request the camera and begin scanning. Call from a user gesture. */
  async start(): Promise<void> {
    this.onState({ status: 'starting' });
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
    } catch (e) {
      this.onState({ status: 'error', message: e instanceof Error ? e.message : 'camera unavailable' });
      return;
    }
    this.video.srcObject = this.stream;
    try {
      await this.video.play();
    } catch {
      // Autoplay quirks — the attribute set + user gesture normally suffice.
    }
    this.resume();
  }

  /** Continue scanning (also used after a locked result is confirmed/rejected). */
  resume(): void {
    if (!this.stream) return;
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
