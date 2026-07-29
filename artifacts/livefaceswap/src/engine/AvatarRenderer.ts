/**
 * AvatarRenderer v2 — draws one animated avatar frame to a canvas.
 *
 * Key design decisions:
 *  • The canvas is always full-screen (cover-fit reference image).
 *  • All face animations are LOCALISED to the face region — nothing outside
 *    the face shifts when the mouth opens or eyes blink.
 *  • Mouth open: face-column-constrained jaw drop; gap sized to face height
 *    (not raw landmark gap) so it's stable at any camera distance.
 *  • Eye blink: progressive upper-eyelid cover — the clip region grows
 *    downward as closedness increases, never using alpha blending, giving a
 *    sharp natural lid descent from full-opacity skin texture above the eye.
 *  • Eyebrow raise: whole-image translate clipped to brow strip.
 *  • Head pose: global canvas transform applied before drawing.
 *  • "Face not detected" subtle text indicator (no heavy overlay).
 */
import * as faceapi from '@vladmandic/face-api';
import type { FaceParams, RefFaceData } from './types';
import { DEFAULT_PARAMS } from './types';

const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model';

// ─── Utilities ────────────────────────────────────────────────────────────────

interface Cover {
  scale: number;
  dx: number;
  dy: number;
}

function buildCover(imgW: number, imgH: number, cW: number, cH: number): Cover {
  const scale = Math.max(cW / imgW, cH / imgH);
  return { scale, dx: (cW - imgW * scale) / 2, dy: (cH - imgH * scale) / 2 };
}

function c2c(x: number, y: number, t: Cover) {
  return { x: x * t.scale + t.dx, y: y * t.scale + t.dy };
}

function imgRect(cover: Cover, iW: number, iH: number) {
  return { x: cover.dx, y: cover.dy, w: iW * cover.scale, h: iH * cover.scale };
}

// Convert canvas coords back to image-source coords for ctx.drawImage sub-rect
function canvasToSrc(cx: number, cy: number, cw: number, ch: number, cover: Cover) {
  return {
    sx: (cx - cover.dx) / cover.scale,
    sy: (cy - cover.dy) / cover.scale,
    sw: cw / cover.scale,
    sh: ch / cover.scale,
  };
}

// ─── AvatarRenderer ───────────────────────────────────────────────────────────

export class AvatarRenderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ref: RefFaceData | null = null;
  private lastParams: FaceParams = { ...DEFAULT_PARAMS };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
  }

  setRefFace(data: RefFaceData | null): void { this.ref = data; }

  /** Detect landmarks in the reference image (call once per upload). */
  async detectRefLandmarks(img: HTMLImageElement): Promise<Array<{ x: number; y: number }> | null> {
    for (const t of [0.3, 0.2, 0.1, 0.05]) {
      try {
        const det = await faceapi
          .detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({ scoreThreshold: t }))
          .withFaceLandmarks(true);
        if (det) return det.landmarks.positions.map(p => ({ x: p.x, y: p.y }));
      } catch { /* lower threshold */ }
    }
    return null;
  }

  render(params: FaceParams): void {
    this.lastParams = params;
    this.drawFrame(params);
  }

  // ── Core draw ──────────────────────────────────────────────────────────────

  private drawFrame(params: FaceParams): void {
    const canvas = this.canvas;
    const ctx    = this.ctx;

    // Sync pixel dimensions to CSS size (window fallback for first mobile frame)
    const cW = canvas.clientWidth  || window.innerWidth;
    const cH = canvas.clientHeight || window.innerHeight;
    if (canvas.width !== cW || canvas.height !== cH) {
      canvas.width  = cW;
      canvas.height = cH;
    }

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cW, cH);

    const ref = this.ref;
    if (!ref || !ref.image.naturalWidth) {
      // No avatar yet — nothing to draw
      return;
    }

    const { image, landmarks } = ref;
    const cover  = buildCover(image.naturalWidth, image.naturalHeight, cW, cH);
    const ir     = imgRect(cover, image.naturalWidth, image.naturalHeight);

    // ── Head pose transform ────────────────────────────────────────────────
    const pivotX = cW * 0.5;
    const pivotY = cH * 0.44;
    const maxBob = cW * 0.06;
    const maxNod = cH * 0.045;
    const txPx   = -params.yaw   * maxBob;
    const tyPx   =  params.pitch * maxNod;

    ctx.save();
    ctx.translate(pivotX + txPx, pivotY + tyPx);
    ctx.rotate(params.roll);
    ctx.translate(-pivotX, -pivotY);

    if (landmarks && landmarks.length >= 68) {
      this.drawPuppet(ctx, image, ir, landmarks, cover, cW, cH, params);
    } else {
      ctx.drawImage(image, ir.x, ir.y, ir.w, ir.h);
    }

    ctx.restore();

    // ── "Face not detected" subtle indicator ───────────────────────────────
    if (!params.detected) {
      ctx.save();
      ctx.font = 'bold 14px system-ui, sans-serif';
      ctx.textAlign = 'center';
      // Badge
      const text  = 'Face not detected';
      const tw    = ctx.measureText(text).width;
      const bx    = cW / 2 - tw / 2 - 12;
      const by    = cH  - 56;
      const bw    = tw + 24;
      const bh    = 32;
      ctx.fillStyle   = 'rgba(0,0,0,0.55)';
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, bh, 8);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,220,80,0.85)';
      ctx.fillText(text, cW / 2, by + 21);
      ctx.restore();
    }
  }

  // ── Puppet (full expression animation) ───────────────────────────────────

  private drawPuppet(
    ctx: CanvasRenderingContext2D,
    image: HTMLImageElement,
    ir: { x: number; y: number; w: number; h: number },
    lm: Array<{ x: number; y: number }>,
    cover: Cover,
    cW: number,
    cH: number,
    params: FaceParams
  ): void {
    const lmC = (i: number) => c2c(lm[i].x, lm[i].y, cover);

    // ── Compute face column bounds from jaw landmarks (0-16) ──────────────
    const jawXs    = Array.from({ length: 17 }, (_, i) => lmC(i).x);
    const faceMinX = Math.min(...jawXs) - ir.w * 0.04;
    const faceMaxX = Math.max(...jawXs) + ir.w * 0.04;
    const faceColW = faceMaxX - faceMinX;

    // ── Key landmarks ──────────────────────────────────────────────────────
    const ulInner = lmC(62);  // inner upper lip centre
    const llInner = lmC(66);  // inner lower lip centre
    const mLeft   = lmC(48);
    const mRight  = lmC(54);
    const mCX     = (mLeft.x + mRight.x) / 2;
    const mWidth  = Math.abs(mRight.x - mLeft.x);
    const splitY  = (ulInner.y + llInner.y) / 2;

    // Max mouth gap — 10 % of face height (chin → nose bridge) for stability
    // at any camera distance.  This replaces the old natGap * 4.5 formula
    // which produced wildly different results depending on how close the user
    // sat to the camera.
    const chinY    = lmC(8).y;
    const noseBrY  = lmC(27).y;
    const faceH    = Math.abs(chinY - noseBrY);
    const maxGap   = faceH * 0.12;
    const gap      = params.mouthOpen * maxGap;

    // ── Step 1: draw the full reference image ──────────────────────────────
    ctx.drawImage(image, ir.x, ir.y, ir.w, ir.h);

    // ── Step 2: mouth-open jaw drop (face-column-constrained) ─────────────
    if (gap > 1) {
      // Re-draw only the jaw region (below splitY, within face column) shifted down
      ctx.save();
      ctx.beginPath();
      ctx.rect(faceMinX, splitY, faceColW, cH - splitY);
      ctx.clip();
      ctx.translate(0, gap);
      ctx.drawImage(image, ir.x, ir.y, ir.w, ir.h);
      ctx.restore();

      // Dark mouth-cavity ellipse filling the gap
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(
        mCX, splitY + gap / 2,
        mWidth / 2 + 3, gap / 2 + 3,
        0, 0, Math.PI * 2
      );
      // Very dark brown instead of pure black — more natural in most lighting
      ctx.fillStyle = '#0a0605';
      ctx.fill();
      ctx.restore();

      // Feathered seam: blend original lip texture back over the split line
      // Width 16 px (was 12) with a slightly higher alpha for a smoother join.
      const seam = canvasToSrc(faceMinX, splitY - 8, faceColW, 16, cover);
      if (seam.sw > 0 && seam.sh > 0) {
        ctx.save();
        ctx.globalAlpha = 0.45;
        ctx.drawImage(image, seam.sx, seam.sy, seam.sw, seam.sh,
                      faceMinX, splitY - 8, faceColW, 16);
        ctx.restore();
      }
    }

    // ── Step 3: eye blink overlays ─────────────────────────────────────────
    this.drawEyelid(ctx, image, lm, cover, ir, 36, 1 - params.leftEyeOpen);
    this.drawEyelid(ctx, image, lm, cover, ir, 42, 1 - params.rightEyeOpen);

    // ── Step 4: eyebrow raise ──────────────────────────────────────────────
    if (params.eyebrowRaise > 0.08) {
      this.drawBrowRaise(ctx, image, lm, cover, ir, params.eyebrowRaise);
    }

    // ── Step 5: smile cheek lift (subtle) ─────────────────────────────────
    if (params.smile > 0.25) {
      this.drawSmile(ctx, image, lm, cover, ir, params.smile);
    }
  }

  // ── Eyelid animation ──────────────────────────────────────────────────────
  //
  // Upper eyelid descends progressively from the top of the eye.
  // The clip region grows downward in lock-step with closedness, revealing
  // the image shifted down by lidH — which brings forehead/eyelid skin into
  // the eye area at full opacity.  No alpha blending: the skin texture itself
  // provides the correct colour.  A tiny dark gradient at the leading edge
  // softens the lid boundary without making it look translucent.

  private drawEyelid(
    ctx: CanvasRenderingContext2D,
    image: HTMLImageElement,
    lm: Array<{ x: number; y: number }>,
    cover: Cover,
    ir: { x: number; y: number; w: number; h: number },
    eyeStart: number,
    closedness: number
  ): void {
    if (closedness < 0.05) return;

    const lmC    = (i: number) => c2c(lm[i].x, lm[i].y, cover);
    const pts    = [0, 1, 2, 3, 4, 5].map(i => lmC(eyeStart + i));
    const leftX  = Math.min(pts[0].x, pts[3].x);
    const rightX = Math.max(pts[0].x, pts[3].x);
    const eyeW   = Math.abs(rightX - leftX);
    const topY   = Math.min(...pts.map(p => p.y));
    const botY   = Math.max(...pts.map(p => p.y));
    const eyeH   = Math.max(botY - topY, 4);

    const padX  = eyeW * 0.3;
    // How far the lid has descended (0 = eye fully open, eyeH+3 = fully closed)
    const lidH  = closedness * (eyeH + 3);
    // Clip only the area already covered by the descending lid
    const clipH = Math.min(lidH, eyeH + 3);

    // Draw skin-texture lid at full opacity, clipped to covered region
    ctx.save();
    ctx.beginPath();
    ctx.rect(leftX - padX, topY - 2, eyeW + padX * 2, clipH + 2);
    ctx.clip();
    // Shift image down so the skin just above the eye fills the eye area
    ctx.translate(0, lidH);
    ctx.drawImage(image, ir.x, ir.y, ir.w, ir.h);
    ctx.restore();

    // Soft shadow along the leading edge of the lid (not drawn when fully closed)
    if (closedness < 0.92 && clipH > 3) {
      const featherH = Math.min(5, eyeH * 0.25);
      const featherY = topY + clipH - featherH;
      ctx.save();
      ctx.beginPath();
      ctx.rect(leftX - padX, featherY, eyeW + padX * 2, featherH);
      ctx.clip();
      const grad = ctx.createLinearGradient(0, featherY, 0, featherY + featherH);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(1, 'rgba(0,0,0,0.30)');
      ctx.fillStyle = grad;
      ctx.fillRect(leftX - padX, featherY, eyeW + padX * 2, featherH);
      ctx.restore();
    }
  }

  // ── Eyebrow raise ─────────────────────────────────────────────────────────
  // Translate the image up by shiftPx within the brow strip clip region.
  // Clipping prevents the shift from bleeding outside the brow area.
  // The gap left below is automatically filled by the underlying full image.

  private drawBrowRaise(
    ctx: CanvasRenderingContext2D,
    image: HTMLImageElement,
    lm: Array<{ x: number; y: number }>,
    cover: Cover,
    ir: { x: number; y: number; w: number; h: number },
    raise: number
  ): void {
    const lmC     = (i: number) => c2c(lm[i].x, lm[i].y, cover);
    const lBrow   = [17, 18, 19, 20, 21].map(lmC);
    const rBrow   = [22, 23, 24, 25, 26].map(lmC);
    const all     = [...lBrow, ...rBrow];
    const minX    = Math.min(...all.map(p => p.x)) - ir.w * 0.02;
    const maxX    = Math.max(...all.map(p => p.x)) + ir.w * 0.02;
    const minY    = Math.min(...all.map(p => p.y)) - ir.h * 0.04;
    const maxY    = Math.max(...all.map(p => p.y)) + ir.h * 0.015;
    const stripW  = maxX - minX;
    const stripH  = maxY - minY;
    if (stripW < 2 || stripH < 2) return;

    const shiftUp = raise * stripH * 0.55;

    ctx.save();
    // Clip to brow strip + headroom above for the upward shift
    ctx.beginPath();
    ctx.rect(minX, minY - shiftUp - 2, stripW, stripH + shiftUp + 2);
    ctx.clip();
    // Translate the whole image up: brow moves up, gap below shows forehead texture
    ctx.translate(0, -shiftUp);
    ctx.drawImage(image, ir.x, ir.y, ir.w, ir.h);
    ctx.restore();
  }

  // ── Smile cheek lift (subtle upward push of cheek area) ──────────────────

  private drawSmile(
    ctx: CanvasRenderingContext2D,
    image: HTMLImageElement,
    lm: Array<{ x: number; y: number }>,
    cover: Cover,
    ir: { x: number; y: number; w: number; h: number },
    smile: number
  ): void {
    // Mouth corners lift very slightly — shift the corner regions upward
    const lmC = (i: number) => c2c(lm[i].x, lm[i].y, cover);
    const corners = [lmC(48), lmC(54)];
    const mTop    = lmC(51);
    const mBot    = lmC(57);
    const regionH = Math.abs(mBot.y - mTop.y) * 2.5;
    const liftPx  = smile * regionH * 0.18;
    if (liftPx < 0.5) return;

    for (const corner of corners) {
      const rx = corner.x - ir.w * 0.06;
      const ry = corner.y - regionH * 0.4;
      const rw = ir.w * 0.12;
      const rh = regionH;
      if (rw < 2 || rh < 2) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(rx, ry - liftPx, rw, rh + liftPx);
      ctx.clip();
      ctx.globalAlpha = 0.7;
      ctx.translate(0, -liftPx);
      ctx.drawImage(image, ir.x, ir.y, ir.w, ir.h);
      ctx.restore();
    }
  }
}
