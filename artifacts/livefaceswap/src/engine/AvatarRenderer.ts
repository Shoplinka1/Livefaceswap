/**
 * AvatarRenderer v4 — upright, expression-only avatar animation.
 *
 * Core guarantees
 * ───────────────
 * 1. The reference image is drawn EXACTLY ONCE per frame, always upright and
 *    centred (cover-fit).  It is never rotated, translated, or scaled beyond
 *    the cover transform — regardless of what the user's head is doing in
 *    front of the webcam.
 *
 * 2. Head pose (roll / yaw / pitch) is intentionally NOT used to move the
 *    canvas.  Rotating the reference photo to match the user's physical head
 *    tilt produces the spinning-photo artefact seen in v3 and is conceptually
 *    wrong for a face-swap app.
 *
 * 3. Only facial expressions (blink, mouth open) are animated.  They are
 *    canvas overlay primitives anchored to landmarks in the reference image
 *    via the same cover transform, so they are always registered to the
 *    correct pixel position on screen.
 *
 * Rendering pipeline per frame
 * ────────────────────────────
 *  1. Fill canvas black.
 *  2. ctx.drawImage() — reference image, cover-fit, one call, no rotation.
 *  3. Blink overlays clipped to eye landmark polygons (gradient fill).
 *  4. Mouth cavity ellipse at inner-lip landmarks (only when clearly open).
 *  5. "Face not detected" badge if needed.
 *
 * Coordinate mapping
 * ──────────────────
 * Landmarks are in reference-image pixel space.  c2c() maps them to canvas
 * space using the same cover transform that positions the drawImage call, so
 * overlays are pixel-accurate.
 */
import * as faceapi from '@vladmandic/face-api';
import type { FaceParams, RefFaceData } from './types';
import { DEFAULT_PARAMS } from './types';

const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model';

// ─── Geometry helpers ──────────────────────────────────────────────────────────

interface Cover {
  scale: number;
  dx: number;
  dy: number;
}

/** Scale + centre a source rectangle into a destination canvas (cover-fit). */
function buildCover(imgW: number, imgH: number, cW: number, cH: number): Cover {
  const scale = Math.max(cW / imgW, cH / imgH);
  return { scale, dx: (cW - imgW * scale) / 2, dy: (cH - imgH * scale) / 2 };
}

/** Map a point from image-pixel space to canvas space via the cover transform. */
function c2c(x: number, y: number, t: Cover): { x: number; y: number } {
  return { x: x * t.scale + t.dx, y: y * t.scale + t.dy };
}

// ─── AvatarRenderer ───────────────────────────────────────────────────────────

export class AvatarRenderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ref: RefFaceData | null = null;
  private lastParams: FaceParams = { ...DEFAULT_PARAMS };

  /** Pre-sampled eyelid skin colour for each eye (RGB). */
  private leftLidRGB:  [number, number, number] = [200, 160, 130];
  private rightLidRGB: [number, number, number] = [200, 160, 130];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  setRefFace(data: RefFaceData | null): void {
    this.ref = data;
    if (data?.image && data.landmarks && data.landmarks.length >= 48) {
      this.presampleLidColors(data.image, data.landmarks);
    }
  }

  /** Detect 68-point landmarks in the reference image (called once per upload). */
  async detectRefLandmarks(
    img: HTMLImageElement,
  ): Promise<Array<{ x: number; y: number }> | null> {
    for (const t of [0.3, 0.2, 0.1, 0.05]) {
      try {
        const det = await faceapi
          .detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({ scoreThreshold: t }))
          .withFaceLandmarks(true);
        if (det) return det.landmarks.positions.map(p => ({ x: p.x, y: p.y }));
      } catch { /* lower threshold and retry */ }
    }
    return null;
  }

  render(params: FaceParams): void {
    this.lastParams = params;
    this.drawFrame(params);
  }

  // ── Lid colour sampling ─────────────────────────────────────────────────────
  // Sampled once at upload time so the blink overlay matches the real skin tone.

  private presampleLidColors(
    img: HTMLImageElement,
    lm: Array<{ x: number; y: number }>,
  ): void {
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    if (W < 1 || H < 1) return;

    try {
      const tmp    = document.createElement('canvas');
      tmp.width    = W;
      tmp.height   = H;
      const tmpCtx = tmp.getContext('2d')!;
      tmpCtx.drawImage(img, 0, 0);

      const sample = (x: number, y: number): [number, number, number] => {
        const px = tmpCtx.getImageData(
          Math.round(Math.max(0, Math.min(W - 1, x))),
          Math.round(Math.max(0, Math.min(H - 1, y))),
          1, 1,
        ).data;
        return [px[0], px[1], px[2]];
      };

      // Left eye — midpoint between brow centre (lm 19-20) and upper lid (lm 37-38)
      this.leftLidRGB = sample(
        ((lm[19].x + lm[20].x) / 2 + (lm[37].x + lm[38].x) / 2) / 2,
        ((lm[19].y + lm[20].y) / 2 + (lm[37].y + lm[38].y) / 2) / 2,
      );

      // Right eye — midpoint between brow centre (lm 23-24) and upper lid (lm 43-44)
      this.rightLidRGB = sample(
        ((lm[23].x + lm[24].x) / 2 + (lm[43].x + lm[44].x) / 2) / 2,
        ((lm[23].y + lm[24].y) / 2 + (lm[43].y + lm[44].y) / 2) / 2,
      );
    } catch {
      /* warm-skin fallback stays */
    }
  }

  // ── Core draw ───────────────────────────────────────────────────────────────

  private drawFrame(params: FaceParams): void {
    const canvas = this.canvas;
    const ctx    = this.ctx;

    // Sync physical pixel size with CSS layout size.
    const cW = canvas.clientWidth  || window.innerWidth;
    const cH = canvas.clientHeight || window.innerHeight;
    if (canvas.width !== cW || canvas.height !== cH) {
      canvas.width  = cW;
      canvas.height = cH;
    }

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cW, cH);

    const ref = this.ref;
    if (!ref || !ref.image.naturalWidth) return;

    const { image, landmarks } = ref;

    // Cover transform — maps the reference image to fill the canvas.
    // No overscan, no rotation.  The image is ALWAYS drawn upright and centred.
    const cover = buildCover(image.naturalWidth, image.naturalHeight, cW, cH);

    // ── Draw reference image — ONE call, no patches, no rotation ────────────
    ctx.drawImage(
      image,
      cover.dx, cover.dy,
      image.naturalWidth  * cover.scale,
      image.naturalHeight * cover.scale,
    );

    // ── Expression overlays ──────────────────────────────────────────────────
    // Drawn directly in canvas space — no extra save/restore, no head-pose CTM.
    // Landmark positions are mapped via the same cover transform as the image.
    if (landmarks && landmarks.length >= 68) {
      // Blink: closedness = 1 − eyeOpen.  Only draw when noticeably closing.
      const lClose = 1 - params.leftEyeOpen;
      const rClose = 1 - params.rightEyeOpen;
      if (lClose > 0.08) this.drawEyelid(ctx, landmarks, cover, 36, lClose, this.leftLidRGB);
      if (rClose > 0.08) this.drawEyelid(ctx, landmarks, cover, 42, rClose, this.rightLidRGB);

      // Mouth: only when clearly open to avoid the resting-jaw false-trigger.
      if (params.mouthOpen > 0.15) {
        this.drawMouthCavity(ctx, landmarks, cover, params.mouthOpen, params.smile);
      }
    }

    // ── "Face not detected" badge ────────────────────────────────────────────
    if (!params.detected) {
      this.drawNotDetectedBadge(ctx, cW, cH);
    }
  }

  // ── Eyelid overlay ──────────────────────────────────────────────────────────
  // Gradient fill clipped to the eye-landmark polygon.
  // Lid colour from presampleLidColors so it matches the real face tone.
  // At closedness = 0 nothing is drawn; at 1 the whole eye is filled.

  private drawEyelid(
    ctx:        CanvasRenderingContext2D,
    lm:         Array<{ x: number; y: number }>,
    cover:      Cover,
    eyeStart:   number,   // 36 = left, 42 = right
    closedness: number,   // 0 = open, 1 = fully closed
    lidRGB:     [number, number, number],
  ): void {
    if (closedness < 0.08) return;

    const pts = [0, 1, 2, 3, 4, 5].map(i => c2c(lm[eyeStart + i].x, lm[eyeStart + i].y, cover));

    const topY = Math.min(...pts.map(p => p.y));
    const botY = Math.max(...pts.map(p => p.y));
    const minX = Math.min(...pts.map(p => p.x));
    const maxX = Math.max(...pts.map(p => p.x));
    const eyeH = Math.max(botY - topY, 4);
    const eyeW = maxX - minX;
    const lidH = closedness * (eyeH + 2);

    const [r, g, b] = lidRGB;

    ctx.save();

    // Clip to eye polygon to prevent bleed onto surrounding skin.
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.clip();

    // Gradient: opaque lid-skin at top → transparent at leading edge.
    const gradEnd = topY + lidH * 1.2;
    const grad = ctx.createLinearGradient(0, topY, 0, gradEnd);
    grad.addColorStop(0,    `rgba(${r},${g},${b},1)`);
    grad.addColorStop(0.72, `rgba(${r},${g},${b},0.95)`);
    grad.addColorStop(1,    `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(minX - 2, topY - 2, eyeW + 4, lidH + 4);

    // Thin dark lash shadow at the leading edge.
    if (closedness > 0.12 && lidH > 2) {
      const lashY = topY + lidH;
      const lashG = ctx.createLinearGradient(0, lashY - 3, 0, lashY + 1);
      lashG.addColorStop(0, `rgba(${Math.round(r*0.2)},${Math.round(g*0.2)},${Math.round(b*0.2)},0)`);
      lashG.addColorStop(1, `rgba(${Math.round(r*0.2)},${Math.round(g*0.2)},${Math.round(b*0.2)},0.45)`);
      ctx.fillStyle = lashG;
      ctx.fillRect(minX - 2, lashY - 3, eyeW + 4, 4);
    }

    ctx.restore();
  }

  // ── Mouth cavity overlay ────────────────────────────────────────────────────
  // Single dark ellipse at the inner-lip landmarks.
  // Height scales with mouthOpen; width nudged by smile.
  // No image region is copied or re-drawn.

  private drawMouthCavity(
    ctx:       CanvasRenderingContext2D,
    lm:        Array<{ x: number; y: number }>,
    cover:     Cover,
    mouthOpen: number,
    smile:     number,
  ): void {
    const pt = (i: number) => c2c(lm[i].x, lm[i].y, cover);

    // Outer corners (48, 54) define available width.
    const mLeft  = pt(48);
    const mRight = pt(54);
    // Inner lip landmarks (62 = upper inner centre, 66 = lower inner centre).
    const mTop   = pt(62);
    const mBot   = pt(66);

    const cx = (mLeft.x + mRight.x) / 2;
    const cy = (mTop.y  + mBot.y)   / 2;

    const halfSpan = Math.abs(mRight.x - mLeft.x) / 2;
    // Horizontal radius: ~78 % of half-span, widened slightly when smiling.
    const rx = halfSpan * 0.78 + smile * halfSpan * 0.10;
    // Vertical radius: grows from 0 (closed) to ~80 % of rx (wide open).
    const ry = mouthOpen * rx * 0.80;

    if (rx < 2 || ry < 1) return;

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    // Dark warm brown — more natural than pure black.
    ctx.fillStyle = '#0d0806';
    ctx.fill();
    ctx.restore();
  }

  // ── Status badge ─────────────────────────────────────────────────────────────

  private drawNotDetectedBadge(
    ctx: CanvasRenderingContext2D,
    cW:  number,
    cH:  number,
  ): void {
    ctx.save();
    ctx.font      = 'bold 14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    const text = 'Face not detected';
    const tw   = ctx.measureText(text).width;
    const bx   = cW / 2 - tw / 2 - 12;
    const by   = cH - 56;
    const bw   = tw + 24;
    const bh   = 32;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, 8);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,220,80,0.85)';
    ctx.fillText(text, cW / 2, by + 21);
    ctx.restore();
  }
}
