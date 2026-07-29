/**
 * AvatarRenderer v3 — single-image, overlay-based avatar animation.
 *
 * Core guarantee: the reference image is drawn EXACTLY ONCE per frame using a
 * single ctx.drawImage() call.  There is no patch-copying, no image slicing,
 * and no rect-based sub-image re-draw.  All facial expressions are rendered as
 * canvas overlay primitives (gradient fills, ellipses) anchored to landmark
 * positions — they never duplicate any part of the image.
 *
 * Rendering pipeline per frame
 * ────────────────────────────
 *  1. Fill canvas black.
 *  2. ctx.save() — apply head-pose transform (translate yaw/pitch, rotate roll).
 *     The image is drawn 10 % larger than cover-fit so the black canvas corners
 *     are never exposed during normal head-roll movements (±15°).
 *  3. ctx.drawImage() — the entire reference image, one call.
 *  4. Expression overlays drawn inside the same transform so they follow the
 *     face naturally:
 *       • Blink  — gradient-filled polygon clipped to the eye landmark shape.
 *                  Lid colour is pre-sampled from the image once at upload time.
 *       • Mouth  — dark ellipse at inner-lip landmarks, height driven by
 *                  mouthOpen, width nudged wider by smile.
 *  5. ctx.restore().
 *  6. "Face not detected" badge if needed (outside the transform).
 *
 * Landmark coordinate system
 * ──────────────────────────
 * Landmarks are in reference-image pixel space.  c2c() maps them to canvas
 * "user space" using coverOS (the 10 %-overscanned cover transform) so that
 * overlay positions align exactly with the pixel rendered on screen.
 */
import * as faceapi from '@vladmandic/face-api';
import type { FaceParams, RefFaceData } from './types';
import { DEFAULT_PARAMS } from './types';

const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model';

// ─── Geometry helpers ─────────────────────────────────────────────────────────

interface Cover {
  scale: number;
  dx: number;
  dy: number;
}

/** Scale + center a source rectangle into a canvas (cover-fit). */
function buildCover(imgW: number, imgH: number, cW: number, cH: number): Cover {
  const scale = Math.max(cW / imgW, cH / imgH);
  return { scale, dx: (cW - imgW * scale) / 2, dy: (cH - imgH * scale) / 2 };
}

/** Map a point from image-pixel space to canvas user-space via the cover transform. */
function c2c(x: number, y: number, t: Cover): { x: number; y: number } {
  return { x: x * t.scale + t.dx, y: y * t.scale + t.dy };
}

// ─── AvatarRenderer ───────────────────────────────────────────────────────────

export class AvatarRenderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ref: RefFaceData | null = null;
  // suppress unused-variable warning — kept so callers can inspect last params
  private lastParams: FaceParams = { ...DEFAULT_PARAMS };

  /** Pre-sampled eyelid skin colour for each eye (RGB). */
  private leftLidRGB:  [number, number, number] = [200, 160, 130];
  private rightLidRGB: [number, number, number] = [200, 160, 130];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  setRefFace(data: RefFaceData | null): void {
    this.ref = data;
    // Pre-sample lid colours so the blink overlay matches the real face tone.
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

  // ── Lid colour sampling ────────────────────────────────────────────────────
  // Sample one pixel per eye from the upper-eyelid region of the reference
  // image.  Called once on upload so the blink overlay always has the right
  // skin tone without any per-frame colour computation.

  private presampleLidColors(
    img: HTMLImageElement,
    lm: Array<{ x: number; y: number }>,
  ): void {
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    if (W < 1 || H < 1) return;

    try {
      const tmpCanvas = document.createElement('canvas');
      tmpCanvas.width  = W;
      tmpCanvas.height = H;
      const tmpCtx = tmpCanvas.getContext('2d')!;
      tmpCtx.drawImage(img, 0, 0);

      const samplePixel = (x: number, y: number): [number, number, number] => {
        const px = tmpCtx.getImageData(
          Math.round(Math.max(0, Math.min(W - 1, x))),
          Math.round(Math.max(0, Math.min(H - 1, y))),
          1, 1,
        ).data;
        return [px[0], px[1], px[2]];
      };

      // Left eye — midpoint between brow centre (lm 19-20) and upper lid (lm 37-38)
      const lBrowMidX = (lm[19].x + lm[20].x) / 2;
      const lBrowMidY = (lm[19].y + lm[20].y) / 2;
      const lLidMidX  = (lm[37].x + lm[38].x) / 2;
      const lLidMidY  = (lm[37].y + lm[38].y) / 2;
      this.leftLidRGB = samplePixel(
        (lBrowMidX + lLidMidX) / 2,
        (lBrowMidY + lLidMidY) / 2,
      );

      // Right eye — midpoint between brow centre (lm 23-24) and upper lid (lm 43-44)
      const rBrowMidX = (lm[23].x + lm[24].x) / 2;
      const rBrowMidY = (lm[23].y + lm[24].y) / 2;
      const rLidMidX  = (lm[43].x + lm[44].x) / 2;
      const rLidMidY  = (lm[43].y + lm[44].y) / 2;
      this.rightLidRGB = samplePixel(
        (rBrowMidX + rLidMidX) / 2,
        (rBrowMidY + rLidMidY) / 2,
      );
    } catch {
      /* sampling failed — warm-skin-tone fallback stays in place */
    }
  }

  // ── Core draw ─────────────────────────────────────────────────────────────

  private drawFrame(params: FaceParams): void {
    const canvas = this.canvas;
    const ctx    = this.ctx;

    // Keep physical pixel size in sync with CSS layout size.
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

    // ── Cover transforms ───────────────────────────────────────────────────
    // coverOS: 10 % overscan so the black canvas corners never peek through
    // during normal head-roll (±15°).  All landmark mapping uses coverOS so
    // overlay coordinates match the overscan-drawn image exactly.
    const OVERSCAN   = 1.10;
    const baseScale  = Math.max(cW / image.naturalWidth, cH / image.naturalHeight);
    const coverOS: Cover = {
      scale: baseScale * OVERSCAN,
      dx:    (cW - image.naturalWidth  * baseScale * OVERSCAN) / 2,
      dy:    (cH - image.naturalHeight * baseScale * OVERSCAN) / 2,
    };
    // Precomputed draw rect for the single drawImage call
    const iW = image.naturalWidth;
    const iH = image.naturalHeight;
    const ox = coverOS.dx;
    const oy = coverOS.dy;
    const ow = iW * coverOS.scale;
    const oh = iH * coverOS.scale;

    // ── Head-pose transform ────────────────────────────────────────────────
    // Pivot at the canvas centre (matches typical face position in cover-fit).
    // Translation (yaw/pitch) and rotation (roll) are applied as one ctx
    // transform so both the single drawImage call and the expression overlays
    // are affected identically — overlays always stay registered to the face.
    const pivotX = cW * 0.5;
    const pivotY = cH * 0.44;
    const txPx   = -params.yaw   * (cW  * 0.06);   // yaw  → horizontal shift
    const tyPx   =  params.pitch * (cH  * 0.045);  // pitch → vertical shift
    const roll   =  params.roll  * 0.65;            // roll  → rotation, attenuated

    ctx.save();
    ctx.translate(pivotX + txPx, pivotY + tyPx);
    ctx.rotate(roll);
    ctx.translate(-pivotX, -pivotY);

    // ── Draw reference image — ONE call, whole image, no patches ──────────
    ctx.drawImage(image, ox, oy, ow, oh);

    // ── Expression overlays ────────────────────────────────────────────────
    // Drawn inside the same save/restore so the head-pose CTM positions them
    // correctly on top of the rendered face pixels.
    if (landmarks && landmarks.length >= 68) {
      this.drawEyelid(ctx, landmarks, coverOS, 36, 1 - params.leftEyeOpen,  this.leftLidRGB);
      this.drawEyelid(ctx, landmarks, coverOS, 42, 1 - params.rightEyeOpen, this.rightLidRGB);

      if (params.mouthOpen > 0.04) {
        this.drawMouthCavity(ctx, landmarks, coverOS, params.mouthOpen, params.smile);
      }
    }

    ctx.restore();

    // ── "Face not detected" badge (outside transform, anchored to canvas) ─
    if (!params.detected) {
      this.drawNotDetectedBadge(ctx, cW, cH);
    }
  }

  // ── Eyelid overlay ────────────────────────────────────────────────────────
  // Draws a downward-descending gradient fill clipped to the eye landmark
  // polygon.  The clip prevents the overlay from bleeding outside the eye
  // shape.  Colour comes from the pre-sampled lid skin tone — no image copy.
  //
  // The gradient covers [topY … topY + lidH].  At closedness = 0 nothing is
  // drawn; at closedness = 1 the entire eye area is filled with the lid colour.

  private drawEyelid(
    ctx:        CanvasRenderingContext2D,
    lm:         Array<{ x: number; y: number }>,
    cover:      Cover,
    eyeStart:   number,   // 36 = left eye, 42 = right eye
    closedness: number,   // 0 = open, 1 = fully closed
    lidRGB:     [number, number, number],
  ): void {
    if (closedness < 0.04) return;

    // Six points of the eye: outer corner → upper arc → inner corner → lower arc
    const pts = [0, 1, 2, 3, 4, 5].map(i => c2c(lm[eyeStart + i].x, lm[eyeStart + i].y, cover));

    const topY = Math.min(...pts.map(p => p.y));
    const botY = Math.max(...pts.map(p => p.y));
    const minX = Math.min(...pts.map(p => p.x));
    const maxX = Math.max(...pts.map(p => p.x));
    const eyeH = Math.max(botY - topY, 4);
    const eyeW = maxX - minX;

    // How far the lid has descended from the top of the eye.
    const lidH = closedness * (eyeH + 2);

    const [r, g, b] = lidRGB;

    ctx.save();

    // Clip strictly to the eye-landmark polygon — no bleed onto surrounding skin.
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.clip();

    // Gradient: lid-skin opaque at top → transparent at the leading edge.
    // The soft fade avoids a hard cut-line at the eyelash border.
    const gradEnd = topY + lidH * 1.2;
    const grad = ctx.createLinearGradient(0, topY, 0, gradEnd);
    grad.addColorStop(0,    `rgba(${r},${g},${b},1)`);
    grad.addColorStop(0.72, `rgba(${r},${g},${b},0.95)`);
    grad.addColorStop(1,    `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = grad;

    // Fill a bounding rect; the polygon clip keeps paint inside the eye shape.
    ctx.fillRect(minX - 2, topY - 2, eyeW + 4, lidH + 4);

    // Thin dark lash-shadow at the leading edge for depth.
    if (closedness > 0.10 && lidH > 2) {
      const lashY = topY + lidH;
      const lashGrad = ctx.createLinearGradient(0, lashY - 3, 0, lashY + 1);
      lashGrad.addColorStop(0, `rgba(${Math.round(r*0.2)},${Math.round(g*0.2)},${Math.round(b*0.2)},0)`);
      lashGrad.addColorStop(1, `rgba(${Math.round(r*0.2)},${Math.round(g*0.2)},${Math.round(b*0.2)},0.45)`);
      ctx.fillStyle = lashGrad;
      ctx.fillRect(minX - 2, lashY - 3, eyeW + 4, 4);
    }

    ctx.restore();
  }

  // ── Mouth cavity overlay ──────────────────────────────────────────────────
  // A single dark ellipse at the inner-lip landmark position.  Height scales
  // with mouthOpen; width is nudged wider when smiling.
  // No image is drawn or moved — just a filled primitive.

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
    // Inner lip landmarks (62 = upper centre, 66 = lower centre).
    const mTop   = pt(62);
    const mBot   = pt(66);

    const cx = (mLeft.x + mRight.x) / 2;
    const cy = (mTop.y  + mBot.y)   / 2;

    // Horizontal radius: ~78 % of the half-span between outer corners,
    // widened slightly when smiling to suggest stretched lips.
    const halfSpan = Math.abs(mRight.x - mLeft.x) / 2;
    const rx = halfSpan * 0.78 + smile * halfSpan * 0.10;

    // Vertical radius: grows from near-zero (closed) to 80 % of rx (open).
    const ry = mouthOpen * rx * 0.80;

    if (rx < 2 || ry < 1) return;

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    // Very dark warm brown — looks more natural than pure black in all lighting.
    ctx.fillStyle = '#0d0806';
    ctx.fill();
    ctx.restore();
  }

  // ── Status badge ──────────────────────────────────────────────────────────

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
