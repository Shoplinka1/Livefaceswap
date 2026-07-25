/**
 * AvatarRenderer — draws one frame of the animated avatar to a canvas.
 *
 * The reference image is shown full-screen (cover-fit).
 * Facial parameters drive:
 *   • Head rotation / tilt / bob  (canvas transform)
 *   • Mouth open/close            (split-image technique)
 *   • Eye blink                   (eyelid overlay)
 *   • Eyebrow raise               (subtle region shift)
 *
 * The render method is designed to be called from requestAnimationFrame
 * every frame (~60 fps) without any allocations or re-initialisations.
 */
import * as faceapi from '@vladmandic/face-api';
import type { FaceParams, RefFaceData } from './types';
import { DEFAULT_PARAMS } from './types';

const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model';

// ─── Utility ────────────────────────────────────────────────────────────────

interface CoverTransform {
  scale: number;
  dx: number;   // left offset (canvas px)
  dy: number;   // top offset (canvas px)
}

function coverTransform(imgW: number, imgH: number, cW: number, cH: number): CoverTransform {
  const scale = Math.max(cW / imgW, cH / imgH);
  return {
    scale,
    dx: (cW - imgW * scale) / 2,
    dy: (cH - imgH * scale) / 2,
  };
}

/** Map a ref-image pixel coordinate to canvas coordinates */
function toCanvas(x: number, y: number, t: CoverTransform) {
  return { x: x * t.scale + t.dx, y: y * t.scale + t.dy };
}

// ─── AvatarRenderer class ────────────────────────────────────────────────────

export class AvatarRenderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ref: RefFaceData | null = null;
  private lastParams: FaceParams = { ...DEFAULT_PARAMS };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
  }

  // ── Reference face ─────────────────────────────────────────────────────────

  setRefFace(data: RefFaceData | null): void {
    this.ref = data;
  }

  /** Detect 68-pt landmarks in the reference image (call once after upload). */
  async detectRefLandmarks(img: HTMLImageElement): Promise<Array<{ x: number; y: number }> | null> {
    for (const threshold of [0.3, 0.2, 0.1, 0.05]) {
      try {
        const det = await faceapi
          .detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({ scoreThreshold: threshold }))
          .withFaceLandmarks(true);
        if (det) {
          return det.landmarks.positions.map(p => ({ x: p.x, y: p.y }));
        }
      } catch { /* try lower threshold */ }
    }
    return null;
  }

  // ── Main render ────────────────────────────────────────────────────────────

  render(params: FaceParams): void {
    this.lastParams = params;
    this.drawFrame(params);
  }

  /** Draw the latest frame again (used for freeze on tracking loss). */
  redraw(): void {
    this.drawFrame(this.lastParams);
  }

  private drawFrame(params: FaceParams): void {
    const canvas = this.canvas;
    const ctx    = this.ctx;

    // Sync canvas pixel size to CSS size
    const cW = canvas.clientWidth  || canvas.width;
    const cH = canvas.clientHeight || canvas.height;
    if (canvas.width !== cW || canvas.height !== cH) {
      canvas.width  = cW;
      canvas.height = cH;
    }

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cW, cH);

    const ref = this.ref;
    if (!ref || !ref.image.naturalWidth) return;

    const { image, landmarks } = ref;
    const cover = coverTransform(image.naturalWidth, image.naturalHeight, cW, cH);

    // ── Head transform ─────────────────────────────────────────────────────
    // Pivot around the visual face centre (slightly above canvas centre)
    const pivotX = cW * 0.5;
    const pivotY = cH * 0.45;

    const maxBob = cW  * 0.07;  // max horizontal sway pixels
    const maxNod = cH  * 0.05;  // max vertical nod pixels
    const txPx   = -params.yaw   * maxBob;  // yaw right → image shifts left
    const tyPx   =  params.pitch * maxNod;  // pitch down → image shifts down

    ctx.save();
    ctx.translate(pivotX + txPx, pivotY + tyPx);
    ctx.rotate(params.roll);
    ctx.translate(-pivotX, -pivotY);

    if (landmarks && landmarks.length >= 68) {
      this.renderPuppet(ctx, image, landmarks, cover, cW, cH, params);
    } else {
      // No ref landmarks — just draw the image with head motion
      ctx.drawImage(
        image,
        cover.dx, cover.dy,
        image.naturalWidth  * cover.scale,
        image.naturalHeight * cover.scale
      );
    }

    ctx.restore();

    // ── Searching indicator (no tracking) ─────────────────────────────────
    if (!params.detected) {
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(0, 0, cW, cH);
    }
  }

  // ── Puppet rendering ───────────────────────────────────────────────────────

  private renderPuppet(
    ctx: CanvasRenderingContext2D,
    image: HTMLImageElement,
    lm: Array<{ x: number; y: number }>,
    cover: CoverTransform,
    cW: number,
    cH: number,
    params: FaceParams
  ): void {
    const toLm = (i: number) => toCanvas(lm[i].x, lm[i].y, cover);

    const imgX = cover.dx;
    const imgY = cover.dy;
    const imgW = image.naturalWidth  * cover.scale;
    const imgH = image.naturalHeight * cover.scale;

    // Key mouth landmarks in canvas space
    const upperLipInner = toLm(62);  // inner upper lip centre
    const lowerLipInner = toLm(66);  // inner lower lip centre
    const mouthLeft     = toLm(48);
    const mouthRight    = toLm(54);
    const mouthCX       = (mouthLeft.x + mouthRight.x) / 2;
    const mouthCY       = (upperLipInner.y + lowerLipInner.y) / 2;
    const mouthW        = Math.abs(mouthRight.x - mouthLeft.x);

    // Gap in canvas pixels (how far the lower face drops when mouth opens)
    const naturalLipGap = Math.max(0, lowerLipInner.y - upperLipInner.y);
    const maxGap        = Math.max(naturalLipGap * 3, imgH * 0.06);
    const gap           = params.mouthOpen * maxGap;

    // ── Image split (mouth animation) ─────────────────────────────────────
    const splitY = mouthCY;

    if (gap < 2) {
      // Mouth closed — draw whole image
      ctx.drawImage(image, imgX, imgY, imgW, imgH);
    } else {
      // Upper portion (above split)
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, cW, splitY);
      ctx.clip();
      ctx.drawImage(image, imgX, imgY, imgW, imgH);
      ctx.restore();

      // Lower portion (below split) — shifted down by gap
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, splitY, cW, cH - splitY);
      ctx.clip();
      ctx.translate(0, gap);
      ctx.drawImage(image, imgX, imgY, imgW, imgH);
      ctx.restore();

      // Dark "open mouth" ellipse in the gap
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(
        mouthCX, splitY + gap / 2,
        mouthW / 2 + 4, gap / 2 + 3,
        0, 0, Math.PI * 2
      );
      ctx.fillStyle = '#080808';
      ctx.fill();
      ctx.restore();
    }

    // ── Eye blink overlays ─────────────────────────────────────────────────
    // Left eye in ref image = landmarks 36-41
    // Right eye in ref image = landmarks 42-47
    // Note: in the ref photo these are the actual anatomical eyes (not mirrored)
    this.renderEyelid(ctx, image, lm, cover, 36, 1 - params.leftEyeOpen);
    this.renderEyelid(ctx, image, lm, cover, 42, 1 - params.rightEyeOpen);

    // ── Eyebrow raise ──────────────────────────────────────────────────────
    if (params.eyebrowRaise > 0.1) {
      this.renderEyebrowRaise(ctx, image, lm, cover, cW, params.eyebrowRaise);
    }
  }

  // ── Eyelid closing ────────────────────────────────────────────────────────

  private renderEyelid(
    ctx: CanvasRenderingContext2D,
    image: HTMLImageElement,
    lm: Array<{ x: number; y: number }>,
    cover: CoverTransform,
    eyeStart: number,
    closedness: number   // 0 = open, 1 = fully closed
  ): void {
    if (closedness < 0.12) return;

    const toLm = (i: number) => toCanvas(lm[i].x, lm[i].y, cover);
    const pts  = [0, 1, 2, 3, 4, 5].map(i => toLm(eyeStart + i));

    const leftX  = pts[0].x;
    const rightX = pts[3].x;
    const eyeW   = Math.abs(rightX - leftX);
    const topY   = Math.min(...pts.map(p => p.y));
    const botY   = Math.max(...pts.map(p => p.y));
    const eyeH   = Math.max(botY - topY, 4);
    const eyeCX  = (leftX + rightX) / 2;
    const eyeCY  = (topY  + botY)   / 2;

    // Draw closing eyelid by painting skin texture from just above the eye
    // (clipped to a shrinking ellipse that represents the eyelid)
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(
      eyeCX, eyeCY,
      eyeW / 2 + 3,
      (eyeH / 2 + 4) * closedness,
      0, 0, Math.PI * 2
    );
    ctx.clip();

    // Source from the forehead region of the ref image (skin texture = natural eyelid)
    const pad    = eyeW * 0.5;
    const srcX   = Math.max(0, (leftX  - pad     - cover.dx) / cover.scale);
    const srcY   = Math.max(0, (eyeCY  - eyeH * 2.5 - cover.dy) / cover.scale);
    const srcW   = Math.max(1, (eyeW + pad * 2) / cover.scale);
    const srcH   = Math.max(1, (eyeH * 3) / cover.scale);

    ctx.drawImage(
      image,
      srcX, srcY, srcW, srcH,
      leftX - pad, eyeCY - eyeH * 2.5,
      eyeW + pad * 2, eyeH * 3
    );
    ctx.restore();
  }

  // ── Eyebrow raise ─────────────────────────────────────────────────────────

  private renderEyebrowRaise(
    ctx: CanvasRenderingContext2D,
    image: HTMLImageElement,
    lm: Array<{ x: number; y: number }>,
    cover: CoverTransform,
    cW: number,
    raise: number   // 0–1
  ): void {
    // Bounding box of both eyebrows + some forehead above them
    const leftBrowPts  = [17, 18, 19, 20, 21].map(i => toCanvas(lm[i].x, lm[i].y, cover));
    const rightBrowPts = [22, 23, 24, 25, 26].map(i => toCanvas(lm[i].x, lm[i].y, cover));
    const allPts = [...leftBrowPts, ...rightBrowPts];

    const minX = Math.min(...allPts.map(p => p.x)) - 8;
    const maxX = Math.max(...allPts.map(p => p.x)) + 8;
    const minY = Math.min(...allPts.map(p => p.y)) - 14;
    const maxY = Math.max(...allPts.map(p => p.y)) + 4;

    const regionW = maxX - minX;
    const regionH = maxY - minY;
    if (regionW < 4 || regionH < 4) return;

    const shiftUp = raise * regionH * 0.4;  // pixels upward

    // Re-draw the eyebrow strip shifted upward
    const srcX = Math.max(0, (minX - cover.dx) / cover.scale);
    const srcY = Math.max(0, (minY - cover.dy) / cover.scale);
    const srcW = Math.max(1, regionW / cover.scale);
    const srcH = Math.max(1, regionH / cover.scale);

    ctx.save();
    // Clip to only the brow region so the shifted copy doesn't bleed into surrounding area
    ctx.beginPath();
    ctx.rect(minX, minY - shiftUp - 4, regionW, regionH + 4);
    ctx.clip();

    // First cover the original position with the image (in case it moved)
    ctx.drawImage(image,
      srcX, srcY, srcW, srcH,
      minX, minY, regionW, regionH
    );

    // Then draw the brow shifted upward
    ctx.drawImage(image,
      srcX, srcY, srcW, srcH,
      minX, minY - shiftUp, regionW, regionH
    );
    ctx.restore();
  }
}
