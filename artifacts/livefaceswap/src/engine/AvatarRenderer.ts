/**
 * AvatarRenderer v5 — 2D Delaunay mesh warp.
 *
 * The reference photo is no longer a static texture with overlays painted
 * on top.  It is a deformable mesh:
 *
 *   At upload:
 *     68 face landmarks + 8 image-boundary points → Delaunay triangulation
 *     (~160 triangles covering the entire image).
 *
 *   Per frame:
 *     expression params → deform landmark positions (lower lip drops on
 *     mouth-open, upper eyelids compress on blink) → render each triangle
 *     as an affine-texture-mapped piece of the original photo.
 *
 * The photo's own lip and eyelid pixels move.  There are no ellipses,
 * gradients, rectangular patches, or any other primitive drawn on top.
 *
 * When face landmarks are not detected in the reference image (e.g. very
 * dark photo, extreme angle) the image is displayed static rather than
 * crash — the user sees a clear "no face detected" badge.
 */
import * as faceapi from '@vladmandic/face-api';
import type { FaceParams, RefFaceData } from './types';
import { DEFAULT_PARAMS } from './types';
import { FaceWarper } from './FaceWarper';

const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model';

export class AvatarRenderer {
  readonly canvas: HTMLCanvasElement;
  private ctx:    CanvasRenderingContext2D;
  private ref:    RefFaceData | null = null;
  // suppress unused-var lint — kept for caller introspection
  private lastParams: FaceParams = { ...DEFAULT_PARAMS };
  private warper = new FaceWarper();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d', { alpha: false })!;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  setRefFace(data: RefFaceData | null): void {
    this.ref = data;
    if (data?.image) {
      this.warper.init(data.image, data.landmarks ?? []);
    }
  }

  /**
   * Detect 68-point landmarks in the reference image.
   * Tries progressively lower score thresholds so even low-contrast photos
   * have a good chance of returning useful landmarks.
   */
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

  // ── Core draw ───────────────────────────────────────────────────────────────

  private drawFrame(params: FaceParams): void {
    const canvas = this.canvas;
    const ctx    = this.ctx;

    // Keep physical pixel dimensions in sync with CSS layout dimensions.
    const cW = canvas.clientWidth  || window.innerWidth;
    const cH = canvas.clientHeight || window.innerHeight;
    if (canvas.width !== cW || canvas.height !== cH) {
      canvas.width  = cW;
      canvas.height = cH;
    }

    if (!this.ref?.image.naturalWidth) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, cW, cH);
      return;
    }

    // Delegate all rendering to FaceWarper (mesh warp or static fallback).
    this.warper.render(ctx, cW, cH, params);

    // Ensure the canvas CTM is back to identity before the badge draw.
    // (warper.render restores after each triangle, but belt-and-suspenders)
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    if (!params.detected) {
      this.drawNotDetectedBadge(ctx, cW, cH);
    }
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

// Re-export MODEL_URL so other modules don't need to duplicate the CDN path.
export { MODEL_URL };
