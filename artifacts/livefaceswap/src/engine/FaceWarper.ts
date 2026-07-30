/**
 * FaceWarper — 2D Delaunay mesh warp for live face photo animation.
 *
 * Architecture
 * ────────────
 * At upload time:
 *   1. Receive 68 face landmarks in reference-image pixel space.
 *   2. Add 8 boundary points at the image edges to cover the full frame.
 *   3. Run Delaunay triangulation → ~160 triangles covering the image.
 *   4. Measure expression ranges (eye height, jaw range) from the ref image.
 *
 * Per frame:
 *   1. Receive FaceParams (mouthOpen, leftEyeOpen, rightEyeOpen, …).
 *   2. Deform the neutral landmark positions in image space:
 *        • mouthOpen → lower lip and inner-lip landmarks drop downward.
 *        • blink     → upper eyelid landmarks compress toward lower lid.
 *   3. Map deformed landmarks to canvas space via cover-fit transform.
 *   4. Render each triangle as an affine-texture-mapped piece of the photo:
 *        – clip to destination triangle
 *        – setTransform to map source image coords → canvas coords
 *        – drawImage(img, 0, 0)
 *
 * Result: the photo's own lip/eyelid pixels physically move — no overlays,
 * no ellipses, no gradients painted on top of a static image.
 */

import { triangulate, type Pt2, type Tri } from './Delaunay';
import type { FaceParams } from './types';

// ─── Internal geometry helpers ─────────────────────────────────────────────────

interface Cover { scale: number; dx: number; dy: number; }

function buildCover(iW: number, iH: number, cW: number, cH: number): Cover {
  const s = Math.max(cW / iW, cH / iH);
  return { scale: s, dx: (cW - iW * s) / 2, dy: (cH - iH * s) / 2 };
}

function toCvs(p: Pt2, cv: Cover): Pt2 {
  return { x: p.x * cv.scale + cv.dx, y: p.y * cv.scale + cv.dy };
}

// ─── Per-triangle affine texture mapping ───────────────────────────────────────
//
// Given source triangle (s0,s1,s2) in image-pixel space and destination
// triangle (d0,d1,d2) in canvas space, compute the 2×3 affine matrix T such
// that T(si) = di, clip to the destination triangle, apply T via setTransform,
// and draw the full image.  Only the clipped region is visible.
//
// Canvas setTransform convention: x' = a·x + c·y + e, y' = b·x + d·y + f
// We want T(image_px) = canvas_px, so we solve for [a,c,e] and [b,d,f]
// using Cramer's rule on the 3×3 source matrix.

function drawMappedTriangle(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  s0: Pt2, s1: Pt2, s2: Pt2,   // source vertices — image pixel space
  d0: Pt2, d1: Pt2, d2: Pt2,   // destination vertices — canvas space
): void {
  const det = s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
  if (Math.abs(det) < 0.5) return; // degenerate — skip

  const inv = 1 / det;

  const a = (d0.x * (s1.y - s2.y) + d1.x * (s2.y - s0.y) + d2.x * (s0.y - s1.y)) * inv;
  const c = (d0.x * (s2.x - s1.x) + d1.x * (s0.x - s2.x) + d2.x * (s1.x - s0.x)) * inv;
  const e = (d0.x * (s1.x * s2.y - s2.x * s1.y) +
             d1.x * (s2.x * s0.y - s0.x * s2.y) +
             d2.x * (s0.x * s1.y - s1.x * s0.y)) * inv;

  const b = (d0.y * (s1.y - s2.y) + d1.y * (s2.y - s0.y) + d2.y * (s0.y - s1.y)) * inv;
  const d = (d0.y * (s2.x - s1.x) + d1.y * (s0.x - s2.x) + d2.y * (s1.x - s0.x)) * inv;
  const f = (d0.y * (s1.x * s2.y - s2.x * s1.y) +
             d1.y * (s2.x * s0.y - s0.x * s2.y) +
             d2.y * (s0.x * s1.y - s1.x * s0.y)) * inv;

  ctx.save();

  // Clip to destination triangle (in canvas space, before the transform change)
  ctx.beginPath();
  ctx.moveTo(d0.x, d0.y);
  ctx.lineTo(d1.x, d1.y);
  ctx.lineTo(d2.x, d2.y);
  ctx.closePath();
  ctx.clip();

  // Apply affine transform: maps image pixel coords → canvas coords
  ctx.setTransform(a, b, c, d, e, f);
  ctx.drawImage(img, 0, 0);

  ctx.restore();
}

// ─── FaceWarper ────────────────────────────────────────────────────────────────

export class FaceWarper {
  private img!:     HTMLImageElement;
  private neutral!: Pt2[];                    // 68 landmarks + 8 boundary (image space)
  private triIdx!:  Tri[];                    // triangle index triples
  private jawRange  = 0;                      // max jaw-drop in image pixels
  private lEyeH     = 0;                      // left-eye full-open height (image px)
  private rEyeH     = 0;
  ready = false;

  /**
   * Initialise the mesh from the uploaded reference image and its 68-point
   * face landmarks.  Must be called once per uploaded image.
   */
  init(img: HTMLImageElement, lm: Pt2[]): void {
    this.ready = false;
    this.img   = img;
    if (!lm || lm.length < 68) return;

    const W = img.naturalWidth, H = img.naturalHeight;

    // 8 boundary points — fixes the image corners/edges so the background
    // stays in place while only the face region deforms.
    const boundary: Pt2[] = [
      { x: 0,     y: 0 },     { x: W / 2, y: 0 },     { x: W,     y: 0 },
      { x: W,     y: H / 2 }, { x: W,     y: H },
      { x: W / 2, y: H },     { x: 0,     y: H },      { x: 0,     y: H / 2 },
    ];

    this.neutral = [...lm.slice(0, 68), ...boundary];
    this.triIdx  = triangulate(this.neutral);

    // ── Expression range measurements (from reference image) ────────────────
    // Inter-ocular distance: outer eye corners lm[36] and lm[45]
    const iod = Math.hypot(lm[45].x - lm[36].x, lm[45].y - lm[36].y) || 80;

    // Jaw range: nose tip (lm[30]) to chin (lm[8]) — mouth opens to ~22% of this
    const noseToChin = Math.hypot(lm[8].x - lm[30].x, lm[8].y - lm[30].y);
    this.jawRange = Math.max(noseToChin * 0.22, iod * 0.20);

    // Eye open heights — vertical distance from upper-lid centre to lower-lid centre
    // Left eye (image-left = person's right): upper lm 37,38,39 / lower lm 40,41
    const lUpperY = (lm[37].y + lm[38].y + lm[39].y) / 3;
    const lLowerY = (lm[40].y + lm[41].y) / 2;
    this.lEyeH = Math.max(Math.abs(lLowerY - lUpperY), iod * 0.05);

    // Right eye (image-right = person's left): upper lm 43,44,45 / lower lm 46,47
    const rUpperY = (lm[43].y + lm[44].y + lm[45].y) / 3;
    const rLowerY = (lm[46].y + lm[47].y) / 2;
    this.rEyeH = Math.max(Math.abs(rLowerY - rUpperY), iod * 0.05);

    this.ready = true;
  }

  /**
   * Render one frame to the canvas.
   * Draws the full triangulated, expression-deformed face mesh.
   */
  render(
    ctx:    CanvasRenderingContext2D,
    cW:     number,
    cH:     number,
    params: FaceParams,
  ): void {
    const img = this.img;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cW, cH);

    if (!this.ready) {
      // No landmarks detected — fall back to static cover-fit display
      const cv = buildCover(img.naturalWidth, img.naturalHeight, cW, cH);
      ctx.drawImage(img, cv.dx, cv.dy, img.naturalWidth * cv.scale, img.naturalHeight * cv.scale);
      return;
    }

    // Deform landmark positions in image space
    const deformed = this.deform(params);

    // Map both neutral (source) and deformed (destination) to canvas space
    const cv  = buildCover(img.naturalWidth, img.naturalHeight, cW, cH);
    const dst = deformed.map(p => toCvs(p, cv));
    const src = this.neutral;  // image-space source stays unchanged

    // Render each triangle as a texture-mapped piece of the reference photo
    for (const [i0, i1, i2] of this.triIdx) {
      drawMappedTriangle(
        ctx, img,
        src[i0], src[i1], src[i2],
        dst[i0], dst[i1], dst[i2],
      );
    }
  }

  // ── Expression deformation ─────────────────────────────────────────────────
  //
  // Only landmark points in the expression-relevant regions are moved.
  // All other points (including the 8 boundary points) stay fixed, so the
  // background and non-face regions do not distort.

  private deform(p: FaceParams): Pt2[] {
    // Start from a fresh copy of the neutral positions
    const pts = this.neutral.map(pt => ({ ...pt }));

    // ── Mouth open (jaw drop) ─────────────────────────────────────────────────
    // Move lower-lip landmarks downward.  The jawline itself is NOT moved so
    // the chin stays anchored — only the mouth opening deforms.
    if (p.mouthOpen > 0.05) {
      const t   = (p.mouthOpen - 0.05) / 0.95;   // [0,1] deadzone-normalised
      const drop = t * this.jawRange;

      // Lower outer lip: lm 54 (right corner) … 59 (arcing back to left corner)
      // Bell-curve weights: corners move less, middle moves most
      const loIdx = [54, 55, 56, 57, 58, 59];
      const loW   = [0.25, 0.60, 0.90, 0.90, 0.60, 0.25];
      for (let i = 0; i < loIdx.length; i++) pts[loIdx[i]].y += drop * loW[i];

      // Inner lower lip: lm 64, 65, 66, 67
      const ilIdx = [64, 65, 66, 67];
      const ilW   = [0.50, 0.80, 0.80, 0.50];
      for (let i = 0; i < ilIdx.length; i++) pts[ilIdx[i]].y += drop * ilW[i] * 0.85;

      // Inner upper lip: very slight upward motion adds depth to the opening
      pts[61].y -= drop * 0.08;
      pts[62].y -= drop * 0.12;
      pts[63].y -= drop * 0.08;
    }

    // ── Left eye blink (image-left eye = person's right, lm 36-41) ────────────
    const lc = 1 - p.leftEyeOpen;
    if (lc > 0.05) {
      const t = (lc - 0.05) / 0.95;
      const d = t * this.lEyeH;
      // Upper lid: lm 37 (upper-right), 38 (upper-centre), 39 (upper-left)
      pts[37].y += d * 0.70;
      pts[38].y += d * 1.00;
      pts[39].y += d * 0.70;
      // Lower lid: lm 40 (lower-left), 41 (lower-right) — slight upward counter
      pts[40].y -= d * 0.15;
      pts[41].y -= d * 0.15;
    }

    // ── Right eye blink (image-right eye = person's left, lm 42-47) ───────────
    const rc = 1 - p.rightEyeOpen;
    if (rc > 0.05) {
      const t = (rc - 0.05) / 0.95;
      const d = t * this.rEyeH;
      // Upper lid: lm 43, 44, 45
      pts[43].y += d * 0.70;
      pts[44].y += d * 1.00;
      pts[45].y += d * 0.70;
      // Lower lid: lm 46, 47
      pts[46].y -= d * 0.15;
      pts[47].y -= d * 0.15;
    }

    return pts;
  }
}
