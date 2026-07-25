/**
 * FaceTracker — runs face detection + landmark extraction on the hidden
 * camera video element every ~100 ms.  Smooths all parameters with
 * exponential moving average to eliminate jitter.
 *
 * Detection is NEVER on the render path — it runs independently via
 * setTimeout so the render loop is never blocked.
 */
import * as faceapi from '@vladmandic/face-api';
import { type FaceParams, DEFAULT_PARAMS } from './types';

const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model';

export type TrackerStatus = 'idle' | 'loading' | 'ready' | 'error';

// ─── Landmark helpers ────────────────────────────────────────────────────────

function pt(positions: faceapi.Point[], i: number) {
  return positions[i];
}

function avgPts(positions: faceapi.Point[], from: number, to: number) {
  let x = 0, y = 0;
  const n = to - from;
  for (let i = from; i < to; i++) { x += positions[i].x; y += positions[i].y; }
  return { x: x / n, y: y / n };
}

/** Eye Aspect Ratio — standard formula.  eyeStart = 36 (left) or 42 (right) */
function ear(positions: faceapi.Point[], eyeStart: number): number {
  const p = (i: number) => positions[eyeStart + i];
  const v1 = Math.hypot(p(1).x - p(5).x, p(1).y - p(5).y);
  const v2 = Math.hypot(p(2).x - p(4).x, p(2).y - p(4).y);
  const h  = Math.hypot(p(0).x - p(3).x, p(0).y - p(3).y);
  return h < 1 ? 0.3 : (v1 + v2) / (2 * h);
}

function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }

function clamp(v: number, lo = 0, hi = 1) { return Math.max(lo, Math.min(hi, v)); }

// ─── FaceTracker class ───────────────────────────────────────────────────────

export class FaceTracker {
  private _status: TrackerStatus = 'idle';
  private ticker: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private _params: FaceParams = { ...DEFAULT_PARAMS };
  private lastValid: FaceParams = { ...DEFAULT_PARAMS };

  // Callbacks
  onParams: ((p: FaceParams) => void) | null = null;
  onStatus: ((s: TrackerStatus) => void) | null = null;
  onProgress: ((pct: number) => void) | null = null;

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
      if (
        !this.busy &&
        videoEl.readyState >= 2 &&
        videoEl.videoWidth > 0
      ) {
        this.busy = true;
        try {
          const det = await faceapi
            .detectSingleFace(
              videoEl,
              new faceapi.TinyFaceDetectorOptions({ scoreThreshold: 0.1, inputSize: 416 })
            )
            .withFaceLandmarks(true);

          if (det) {
            const raw = this.extract(det, videoEl.videoWidth, videoEl.videoHeight);
            this.smooth(raw);
            this.lastValid = { ...this._params };
          } else {
            // Keep last valid pose, mark not detected
            this._params = { ...this.lastValid, detected: false };
          }
        } catch { /* ignore */ }

        this.busy = false;
        this.onParams?.(this._params);
      }

      this.ticker = setTimeout(tick, 100);
    };

    tick();
  }

  stopTracking(): void {
    if (this.ticker) clearTimeout(this.ticker);
    this.ticker = null;
    this.busy = false;
    this._params = { ...DEFAULT_PARAMS };
    this.lastValid = { ...DEFAULT_PARAMS };
  }

  // ── Parameter extraction from 68-pt landmarks ────────────────────────────

  private extract(
    det: faceapi.WithFaceLandmarks<{ detection: faceapi.FaceDetection }>,
    W: number,
    H: number
  ): FaceParams {
    const pos = det.landmarks.positions;
    const bb  = det.detection.box;

    const leftEyeC  = avgPts(pos, 36, 42);
    const rightEyeC = avgPts(pos, 42, 48);
    const eyeMidX   = (leftEyeC.x + rightEyeC.x) / 2;
    const eyeMidY   = (leftEyeC.y + rightEyeC.y) / 2;
    const iod       = Math.hypot(rightEyeC.x - leftEyeC.x, rightEyeC.y - leftEyeC.y); // interocular dist

    // Roll: angle of eye line in raw (unmirrored) video coords.
    // In raw video, left eye (36-41) is on the right side of frame.
    const roll = Math.atan2(
      leftEyeC.y - rightEyeC.y,
      leftEyeC.x - rightEyeC.x
    );

    // Yaw: nose tip offset from eye midpoint, normalized
    const noseTip = pt(pos, 30);
    const yaw = clamp((noseTip.x - eyeMidX) / Math.max(iod, 1), -1.5, 1.5) * 0.67;

    // Pitch: how far nose is between eye line and jaw
    const jawMid = avgPts(pos, 6, 11);
    const pitchRange = jawMid.y - eyeMidY;
    const pitch = pitchRange > 0
      ? clamp(((noseTip.y - eyeMidY) / pitchRange - 0.5) * 2, -1, 1)
      : 0;

    // Normalised position in frame
    const tx = clamp((eyeMidX / W - 0.5) * 2, -1, 1);
    const ty = clamp((eyeMidY / H - 0.4) * 2, -1, 1);

    // Mouth open: inner lip vertical distance / face height
    const upperLipInner = pt(pos, 62);
    const lowerLipInner = pt(pos, 66);
    const mouthOpenPx   = lowerLipInner.y - upperLipInner.y;
    const mouthOpen     = clamp(mouthOpenPx / (bb.height * 0.22));

    // Smile: mouth width relative to IOD
    const mouthLeft  = pt(pos, 48);
    const mouthRight = pt(pos, 54);
    const mouthW     = Math.hypot(mouthRight.x - mouthLeft.x, mouthRight.y - mouthLeft.y);
    const smile      = clamp((mouthW / iod - 0.65) / 0.5);

    // Eye openness (eye aspect ratio → 0–1)
    const EAR_OPEN   = 0.28;
    const EAR_CLOSED = 0.10;
    const leftEyeOpen  = clamp((ear(pos, 36) - EAR_CLOSED) / (EAR_OPEN - EAR_CLOSED));
    const rightEyeOpen = clamp((ear(pos, 42) - EAR_CLOSED) / (EAR_OPEN - EAR_CLOSED));

    // Eyebrow raise: avg brow-to-eye vertical gap, normalized by IOD
    const leftBrow  = avgPts(pos, 17, 22);
    const rightBrow = avgPts(pos, 22, 27);
    const browDist  = ((leftEyeC.y - leftBrow.y) + (rightEyeC.y - rightBrow.y)) / 2;
    const eyebrowRaise = clamp((browDist / (iod * 0.45) - 0.4) / 0.6);

    return {
      detected: true,
      roll, yaw, pitch, tx, ty,
      mouthOpen, smile,
      leftEyeOpen, rightEyeOpen,
      eyebrowRaise,
    };
  }

  // ── Exponential smoothing ────────────────────────────────────────────────

  private smooth(target: FaceParams): void {
    const s = this._params;
    const A = 0.3; // base alpha — higher = more responsive
    this._params = {
      detected:      true,
      roll:          lerp(s.roll,          target.roll,          A),
      yaw:           lerp(s.yaw,           target.yaw,           A),
      pitch:         lerp(s.pitch,         target.pitch,         A),
      tx:            lerp(s.tx,            target.tx,            A * 0.5),
      ty:            lerp(s.ty,            target.ty,            A * 0.5),
      mouthOpen:     lerp(s.mouthOpen,     target.mouthOpen,     A * 1.8),
      smile:         lerp(s.smile,         target.smile,         A),
      leftEyeOpen:   lerp(s.leftEyeOpen,   target.leftEyeOpen,   A * 2.5),
      rightEyeOpen:  lerp(s.rightEyeOpen,  target.rightEyeOpen,  A * 2.5),
      eyebrowRaise:  lerp(s.eyebrowRaise,  target.eyebrowRaise,  A),
    };
  }

  private setStatus(s: TrackerStatus) {
    this._status = s;
    this.onStatus?.(s);
  }
}
