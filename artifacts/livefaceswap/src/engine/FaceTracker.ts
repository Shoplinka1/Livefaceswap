/**
 * FaceTracker v2
 *
 * Improvements over v1:
 *  • Preprocesses video frames through a small (320 px wide) offscreen canvas
 *    with brightness +60 % / contrast +15 % before running detection.
 *    This dramatically improves detection in dark rooms.
 *  • Three-level cascading score thresholds: 0.10 → 0.06 → 0.04.
 *    The third level catches very challenging lighting conditions.
 *  • Minimum tick gap 66 ms (~15 fps detection, smoother than 80 ms).
 *  • mouthOpen normalised against IOD (inter-ocular distance) — fully
 *    scale-invariant, works at any camera distance.
 *  • All other extracted params are ratio-based, so the smaller preprocessed
 *    canvas produces identical results to the full-resolution frame.
 *  • Eye alpha ×2.5 for crisp, low-latency blink response.
 */
import * as faceapi from '@vladmandic/face-api';
import { type FaceParams, DEFAULT_PARAMS } from './types';

const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model';

export type TrackerStatus = 'idle' | 'loading' | 'ready' | 'error';

// ─── Landmark math helpers ────────────────────────────────────────────────────

function avg(pos: faceapi.Point[], from: number, to: number) {
  let x = 0, y = 0;
  for (let i = from; i < to; i++) { x += pos[i].x; y += pos[i].y; }
  const n = to - from;
  return { x: x / n, y: y / n };
}

/** Eye Aspect Ratio — blink detection. eyeStart = 36 (L) or 42 (R) */
function ear(pos: faceapi.Point[], s: number): number {
  const v1 = Math.hypot(pos[s+1].x - pos[s+5].x, pos[s+1].y - pos[s+5].y);
  const v2 = Math.hypot(pos[s+2].x - pos[s+4].x, pos[s+2].y - pos[s+4].y);
  const h  = Math.hypot(pos[s  ].x - pos[s+3].x, pos[s  ].y - pos[s+3].y);
  return h < 1 ? 0.3 : (v1 + v2) / (2 * h);
}

function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
function clamp(v: number, lo = 0, hi = 1) { return Math.max(lo, Math.min(hi, v)); }

// ─── Cascade thresholds (tried in order until a face is found) ───────────────
const THRESHOLDS = [0.10, 0.06, 0.04] as const;

// ─── FaceTracker ─────────────────────────────────────────────────────────────

export class FaceTracker {
  private _status: TrackerStatus = 'idle';
  private ticker: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private _params: FaceParams = { ...DEFAULT_PARAMS };
  private lastValid: FaceParams = { ...DEFAULT_PARAMS };

  // Preprocessed offscreen canvas for brightness/contrast boost
  private ppCanvas: HTMLCanvasElement;
  private ppCtx: CanvasRenderingContext2D;

  onParams:   ((p: FaceParams)     => void) | null = null;
  onStatus:   ((s: TrackerStatus)  => void) | null = null;
  onProgress: ((pct: number)       => void) | null = null;

  constructor() {
    this.ppCanvas = document.createElement('canvas');
    this.ppCtx    = this.ppCanvas.getContext('2d', { willReadFrequently: true })!;
  }

  get status() { return this._status; }
  get params() { return this._params; }

  // ── Model loading ────────────────────────────────────────────────────────

  async loadModels(): Promise<void> {
    this.setStatus('loading');
    try {
      await (faceapi as any).tf?.ready?.();
      this.onProgress?.(10);
      await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
      this.onProgress?.(65);
      await faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL);
      this.onProgress?.(100);
      this.setStatus('ready');
    } catch (err) {
      console.error('[FaceTracker] model load failed:', err);
      this.setStatus('error');
    }
  }

  // ── Tracking loop ────────────────────────────────────────────────────────

  startTracking(videoEl: HTMLVideoElement): void {
    this.stopTracking();

    const tick = async () => {
      if (!this.busy && videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
        this.busy = true;
        try {
          const src = this.preprocess(videoEl);
          const pW  = src.width;
          const pH  = src.height;

          // Three-level cascade: fast path first, then progressively lower thresholds
          let det: faceapi.WithFaceLandmarks<{ detection: faceapi.FaceDetection }> | undefined;
          for (const t of THRESHOLDS) {
            det = await faceapi
              .detectSingleFace(src, new faceapi.TinyFaceDetectorOptions({ scoreThreshold: t, inputSize: 416 }))
              .withFaceLandmarks(true);
            if (det) break;
          }

          if (det) {
            const raw = this.extract(det, pW, pH);
            this.smooth(raw);
            this.lastValid = { ...this._params };
          } else {
            // Freeze last valid pose, mark as lost
            this._params = { ...this.lastValid, detected: false };
          }
        } catch { /* ignore transient errors */ }

        this.busy = false;
        this.onParams?.(this._params);
      }

      this.ticker = setTimeout(tick, 66); // ~15 fps detection
    };

    tick();
  }

  stopTracking(): void {
    if (this.ticker) clearTimeout(this.ticker);
    this.ticker    = null;
    this.busy      = false;
    this._params   = { ...DEFAULT_PARAMS };
    this.lastValid = { ...DEFAULT_PARAMS };
  }

  // ── Preprocessing ─────────────────────────────────────────────────────────
  // Draw the video frame at half resolution with brightness/contrast boost.
  // Improves detection in low-light without requiring a brighter environment.
  // All params are normalised ratios so the smaller canvas is equivalent.

  private preprocess(videoEl: HTMLVideoElement): HTMLCanvasElement {
    const vW = videoEl.videoWidth;
    const vH = videoEl.videoHeight;
    // Target ~320 px wide for faster inference
    const scale = 320 / vW;
    const pW    = 320;
    const pH    = Math.round(vH * scale);

    if (this.ppCanvas.width !== pW || this.ppCanvas.height !== pH) {
      this.ppCanvas.width  = pW;
      this.ppCanvas.height = pH;
    }

    const ctx = this.ppCtx;
    // Brightness boost for low-light; contrast sharpens edges for landmark accuracy
    ctx.filter = 'brightness(160%) contrast(115%)';
    ctx.drawImage(videoEl, 0, 0, pW, pH);
    ctx.filter = 'none';

    return this.ppCanvas;
  }

  // ── Parameter extraction ──────────────────────────────────────────────────

  private extract(
    det: faceapi.WithFaceLandmarks<{ detection: faceapi.FaceDetection }>,
    _W: number,
    _H: number
  ): FaceParams {
    const pos = det.landmarks.positions;

    const lEyeC = avg(pos, 36, 42);
    const rEyeC = avg(pos, 42, 48);
    const iod   = Math.hypot(rEyeC.x - lEyeC.x, rEyeC.y - lEyeC.y) || 1;
    const eyeMX = (lEyeC.x + rEyeC.x) / 2;
    const eyeMY = (lEyeC.y + rEyeC.y) / 2;

    // Roll — eye-line angle (raw, unmirrored video space)
    const roll = Math.atan2(lEyeC.y - rEyeC.y, lEyeC.x - rEyeC.x);

    // Yaw — nose offset from eye midpoint, normalised by IOD
    const nose = pos[30];
    const yaw  = clamp((nose.x - eyeMX) / iod, -1.5, 1.5) * 0.67;

    // Pitch — nose position between eye line and jaw
    const jaw      = avg(pos, 6, 11);
    const pitchRng = jaw.y - eyeMY;
    const pitch    = pitchRng > 0
      ? clamp(((nose.y - eyeMY) / pitchRng - 0.5) * 2, -1, 1)
      : 0;

    // Normalised position in frame
    const tx = clamp((eyeMX / _W - 0.5) * 2, -1, 1);
    const ty = clamp((eyeMY / _H - 0.4) * 2, -1, 1);

    // Mouth open — inner lip gap normalised against IOD (scale-invariant)
    // IOD * 0.35 ≈ fully open mouth gap for an average face
    const ulInner   = pos[62];
    const llInner   = pos[66];
    const mouthOpen = clamp((llInner.y - ulInner.y) / (iod * 0.35));

    // Smile — mouth width vs IOD
    const mLeft = pos[48], mRight = pos[54];
    const mW    = Math.hypot(mRight.x - mLeft.x, mRight.y - mLeft.y);
    const smile = clamp((mW / iod - 0.65) / 0.5);

    // Eye blink (Eye Aspect Ratio)
    const EAR_OPEN   = 0.28;
    const EAR_CLOSED = 0.10;
    const lEAR = ear(pos, 36);
    const rEAR = ear(pos, 42);
    const leftEyeOpen  = clamp((lEAR - EAR_CLOSED) / (EAR_OPEN - EAR_CLOSED));
    const rightEyeOpen = clamp((rEAR - EAR_CLOSED) / (EAR_OPEN - EAR_CLOSED));

    // Eyebrow raise — brow-to-eye vertical distance vs IOD
    const lBrow = avg(pos, 17, 22);
    const rBrow = avg(pos, 22, 27);
    const browDist = ((lEyeC.y - lBrow.y) + (rEyeC.y - rBrow.y)) / 2;
    const eyebrowRaise = clamp((browDist / (iod * 0.45) - 0.4) / 0.6);

    return {
      detected: true,
      roll, yaw, pitch, tx, ty,
      mouthOpen, smile,
      leftEyeOpen, rightEyeOpen,
      eyebrowRaise,
    };
  }

  // ── Exponential smoothing ─────────────────────────────────────────────────

  private smooth(target: FaceParams): void {
    const s  = this._params;
    const A  = 0.30;       // base alpha — head pose
    const AE = A * 2.5;   // eyes snap faster (blinks need crisp response)
    const AM = A * 1.8;   // mouth slightly snappier than head pose
    const AP = A * 0.55;  // position smoothest (no drift jitter)
    this._params = {
      detected:      true,
      roll:          lerp(s.roll,          target.roll,          A),
      yaw:           lerp(s.yaw,           target.yaw,           A),
      pitch:         lerp(s.pitch,         target.pitch,         A),
      tx:            lerp(s.tx,            target.tx,            AP),
      ty:            lerp(s.ty,            target.ty,            AP),
      mouthOpen:     lerp(s.mouthOpen,     target.mouthOpen,     AM),
      smile:         lerp(s.smile,         target.smile,         A),
      leftEyeOpen:   lerp(s.leftEyeOpen,   target.leftEyeOpen,   AE),
      rightEyeOpen:  lerp(s.rightEyeOpen,  target.rightEyeOpen,  AE),
      eyebrowRaise:  lerp(s.eyebrowRaise,  target.eyebrowRaise,  A),
    };
  }

  private setStatus(s: TrackerStatus) {
    this._status = s;
    this.onStatus?.(s);
  }
}
