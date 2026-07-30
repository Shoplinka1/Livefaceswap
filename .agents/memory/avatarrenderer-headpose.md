---
name: AvatarRenderer architecture lessons
description: Why overlays fail and what the correct mesh-warp architecture is for LiveFaceSwap
---

## Rule 1 — Never use paint-over overlays for expression animation
Painting an ellipse or gradient ON TOP of a static photo always looks broken because the original face pixels remain visible underneath. A closed-mouth photo with an ellipse drawn over the lips still shows the closed lips beneath the ellipse. No amount of tuning fixes this — the photo pixels must physically move.

**Why:** Discovered through multiple regression cycles. Users correctly identified the black blob / gradient smear artefact as fundamentally wrong, not cosmetically wrong.

## Rule 2 — Never apply roll/yaw/pitch as a canvas transform
`params.roll` from FaceTracker is `Math.atan2(...)` in raw radians (range ±π). When the user holds their phone while lying on their side, roll ≈ ±1.57 rad (90°). `ctx.rotate(roll × 0.65)` rotates the reference photo nearly upside-down. The reference image must always be drawn upright.

## Correct architecture: 2D Delaunay mesh warp (AvatarRenderer v5)

**At upload:**
1. Detect 68 face landmarks in the reference image (face-api.js TinyFaceDetector)
2. Add 8 image-boundary points at corners/edges
3. Run Delaunay triangulation (Bowyer-Watson) → ~160 triangles covering full image
4. Measure expression ranges: eye open height, nose-to-chin distance

**Per frame:**
1. Deform landmark positions in IMAGE space based on expression params:
   - mouthOpen → lower outer lip (lm 54-59) + inner lower lip (lm 64-67) drop downward; jawline STAYS FIXED so chin doesn't distort
   - leftEyeOpen → upper lid landmarks (lm 37,38,39) compress toward lower lid (lm 40,41)
   - rightEyeOpen → upper lid landmarks (lm 43,44,45) compress toward lower lid (lm 46,47)
2. Map deformed positions to canvas space via cover-fit transform
3. For each triangle: compute affine transform source→dest, clip, setTransform, drawImage

**Per-triangle affine math:**
`det = s0.x*(s1.y-s2.y) + s1.x*(s2.y-s0.y) + s2.x*(s0.y-s1.y)`
Solve via Cramer's rule for [a,c,e] and [b,d,f] (canvas setTransform convention: x'=ax+cy+e, y'=bx+dy+f)

**Files:**
- `src/engine/Delaunay.ts` — Bowyer-Watson incremental Delaunay
- `src/engine/FaceWarper.ts` — mesh init, deform, per-triangle render
- `src/engine/AvatarRenderer.ts` — thin wrapper, no overlay code

**How to apply:** Any new expression feature must deform landmark positions, not draw new primitives over the static image.
