---
name: AvatarRenderer head-pose lesson
description: Why roll/yaw/pitch must not be applied to the canvas transform in a face-swap app
---

## Rule
Never apply `params.roll`, `params.yaw`, or `params.pitch` as a canvas `ctx.rotate()` or `ctx.translate()` transform in AvatarRenderer. The reference image must always be drawn upright and cover-fit — no rotation, no translation.

**Why:** `FaceTracker.extract()` computes `roll = Math.atan2(...)` in raw radians (range ±π). When a user holds their phone while lying on their side, roll ≈ ±1.57 rad (90°). Multiplying by an attenuation factor (e.g. 0.65) still gives ~58° canvas rotation — the entire reference photo appears nearly upside-down. This caused the v3 regression that produced the "spinning photo" bug seen in user screenshots.

**Why (conceptual):** A face-swap app shows a static reference photo as an avatar. The photo should always appear upright regardless of how the user's head is physically oriented. Head pose values from the webcam tracker are for expression interpretation only, not for rotating the output canvas.

**How to apply:** In `drawFrame()`, use only `buildCover()` + `ctx.drawImage()` for the image. Expression overlays (blink, mouth) are drawn directly in canvas space, coordinates mapped via the same cover transform. No `ctx.save/rotate/restore` block wrapping the draw call.

**Also:** Mouth-open threshold must be ≥ 0.15. A threshold of 0.04 fires at resting-jaw position and draws a large black ellipse over the face at all times.
