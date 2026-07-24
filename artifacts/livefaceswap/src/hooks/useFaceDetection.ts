import { useRef, useState, useCallback, useEffect } from 'react';
import * as faceapi from '@vladmandic/face-api';

const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model';

function avg(pts: faceapi.Point[]): { x: number; y: number } {
  const x = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const y = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  return { x, y };
}

export function useFaceDetection() {
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [faceDetected, setFaceDetected] = useState(false);
  const [intensity, setIntensityState] = useState(0.9);
  const intensityRef = useRef(0.9);
  const rafRef = useRef<number | null>(null);
  const refImageRef = useRef<HTMLImageElement | null>(null);
  const refLandmarksRef = useRef<faceapi.FaceLandmarks68 | null>(null);
  const lastFaceDetectedUpdateRef = useRef<number>(0);

  const setIntensity = useCallback((v: number) => {
    intensityRef.current = v;
    setIntensityState(v);
  }, []);

  const loadModels = useCallback(async () => {
    try {
      setLoadingProgress(5);
      await (faceapi as any).tf.ready();
      setLoadingProgress(20);
      await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
      setLoadingProgress(70);
      await faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL);
      setLoadingProgress(100);
      setModelsLoaded(true);
    } catch (err: any) {
      console.warn('Model load error:', err);
      setLoadError('AI models could not initialize in this environment. Try opening on a phone.');
      setLoadingProgress(100);
      setModelsLoaded(true);
    }
  }, []);

  useEffect(() => {
    loadModels();
  }, [loadModels]);

  const setReferenceImage = useCallback(async (img: HTMLImageElement) => {
    refImageRef.current = img;
    refLandmarksRef.current = null;
    try {
      const det = await faceapi
        .detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({ scoreThreshold: 0.2 }))
        .withFaceLandmarks(true);
      if (det) {
        refLandmarksRef.current = det.landmarks;
        console.log('[FaceSwap] Reference face landmarks loaded ✓');
      } else {
        console.warn('[FaceSwap] No face found in reference image — try a clearer photo');
      }
    } catch (e) {
      console.warn('[FaceSwap] Reference detection error:', e);
    }
  }, []);

  // Main render loop
  const startLoop = useCallback((
    videoEl: HTMLVideoElement,
    outputCanvas: HTMLCanvasElement,
    onFaceDetected: (detected: boolean) => void
  ) => {
    const ctx = outputCanvas.getContext('2d', { willReadFrequently: true })!;
    // Three offscreen canvases: one for the warped ref face, one for the soft mask
    const offscreen = document.createElement('canvas');
    const maskCanvas = document.createElement('canvas');

    const updateFaceDetected = (detected: boolean) => {
      const now = Date.now();
      if (now - lastFaceDetectedUpdateRef.current > 400) {
        onFaceDetected(detected);
        setFaceDetected(detected);
        lastFaceDetectedUpdateRef.current = now;
      }
    };

    async function loop() {
      if (!videoEl || videoEl.readyState < 2) {
        rafRef.current = requestAnimationFrame(loop);
        return;
      }

      const W = videoEl.videoWidth || 640;
      const H = videoEl.videoHeight || 480;
      outputCanvas.width = W;
      outputCanvas.height = H;
      offscreen.width = W;
      offscreen.height = H;
      maskCanvas.width = W;
      maskCanvas.height = H;

      // Draw mirrored camera feed
      ctx.save();
      ctx.scale(-1, 1);
      ctx.drawImage(videoEl, -W, 0, W, H);
      ctx.restore();

      if (refImageRef.current && refLandmarksRef.current) {
        try {
          // Detect face in the already-mirrored canvas frame
          const det = await faceapi
            .detectSingleFace(outputCanvas, new faceapi.TinyFaceDetectorOptions({ scoreThreshold: 0.35 }))
            .withFaceLandmarks(true);

          updateFaceDetected(!!det);

          if (det) {
            swapFace(
              ctx,
              offscreen,
              maskCanvas,
              det,
              refImageRef.current,
              refLandmarksRef.current,
              W,
              H,
              intensityRef.current
            );
          }
        } catch {
          updateFaceDetected(false);
        }
      } else {
        updateFaceDetected(false);
      }

      rafRef.current = requestAnimationFrame(loop);
    }

    rafRef.current = requestAnimationFrame(loop);
    setIsRunning(true);
  }, []); // no intensity dep — reads from ref

  const stopLoop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    setIsRunning(false);
    setFaceDetected(false);
  }, []);

  return {
    modelsLoaded,
    loadingProgress,
    loadError,
    isRunning,
    faceDetected,
    intensity,
    setIntensity,
    setReferenceImage,
    startLoop,
    stopLoop
  };
}

// ─── Core face-swap function ───────────────────────────────────────────────────
//
// Strategy:
//   1. Compute a similarity transform (scale + rotation + translation) that maps
//      the reference face eye-line onto the live face eye-line.
//   2. Draw the reference image onto an offscreen canvas under that transform.
//   3. Build a soft face-oval mask from the live landmarks and apply it, so only
//      the face region shows through with feathered edges.
//   4. Alpha-composite the result onto the main canvas at the user-chosen intensity.
//
// Key invariant: ALL live landmark coordinates are already in the MIRRORED canvas
// coordinate system (detection ran on the mirrored canvas). We must NOT flip them
// again.

function swapFace(
  ctx: CanvasRenderingContext2D,
  offscreen: HTMLCanvasElement,
  maskCanvas: HTMLCanvasElement,
  liveDet: faceapi.WithFaceLandmarks<{ detection: faceapi.FaceDetection }>,
  refImg: HTMLImageElement,
  refLandmarks: faceapi.FaceLandmarks68,
  W: number,
  H: number,
  intensity: number
) {
  const livePoints = liveDet.landmarks.positions;
  const refPoints = refLandmarks.positions;

  // ── 1. Compute similarity transform from ref-face to live-face ──────────────
  // Anchor: midpoint between the two eye centers
  const liveLeftEye  = avg(livePoints.slice(36, 42));
  const liveRightEye = avg(livePoints.slice(42, 48));
  const refLeftEye   = avg(refPoints.slice(36, 42));
  const refRightEye  = avg(refPoints.slice(42, 48));

  const liveDx = liveRightEye.x - liveLeftEye.x;
  const liveDy = liveRightEye.y - liveLeftEye.y;
  const refDx  = refRightEye.x  - refLeftEye.x;
  const refDy  = refRightEye.y  - refLeftEye.y;

  const liveEyeDist = Math.sqrt(liveDx * liveDx + liveDy * liveDy);
  const refEyeDist  = Math.sqrt(refDx  * refDx  + refDy  * refDy);
  if (refEyeDist < 1) return; // guard

  const scale    = liveEyeDist / refEyeDist;
  const rotation = Math.atan2(liveDy, liveDx) - Math.atan2(refDy, refDx);

  // Centers (midpoints between eye centers)
  const liveCx = (liveLeftEye.x + liveRightEye.x) / 2;
  const liveCy = (liveLeftEye.y + liveRightEye.y) / 2;
  const refCx  = (refLeftEye.x  + refRightEye.x)  / 2;
  const refCy  = (refLeftEye.y  + refRightEye.y)  / 2;

  // ── 2. Render reference image onto offscreen under the similarity transform ─
  const offCtx = offscreen.getContext('2d', { willReadFrequently: true })!;
  offCtx.clearRect(0, 0, W, H);
  offCtx.save();
  // Move origin to the live face center, scale, rotate, then back from ref center
  offCtx.translate(liveCx, liveCy);
  offCtx.rotate(rotation);
  offCtx.scale(scale, scale);
  offCtx.translate(-refCx, -refCy);
  offCtx.drawImage(refImg, 0, 0);
  offCtx.restore();

  // ── 3. Build soft face-oval mask from live landmarks ───────────────────────
  const maskCtx = maskCanvas.getContext('2d')!;
  maskCtx.clearRect(0, 0, W, H);

  // Compute forehead expansion:  push the brow line up by (eye_y - brow_y) * 1.8
  const eyeY  = (liveLeftEye.y + liveRightEye.y) / 2;
  const browY = (avg(livePoints.slice(17, 22)).y + avg(livePoints.slice(22, 27)).y) / 2;
  const foreheadLift = Math.max((eyeY - browY) * 1.8, 8); // always lift at least 8px

  // Jaw line points (indices 0–16)
  const jaw = livePoints.slice(0, 17);
  // Right brow outer → inner (indices 26 → 22)
  const rightBrow = [26, 25, 24, 23, 22].map(i => livePoints[i]);
  // Left brow inner → outer (indices 21 → 17)
  const leftBrow  = [21, 20, 19, 18, 17].map(i => livePoints[i]);

  maskCtx.save();
  // Enable feathered (blurred) mask edges
  maskCtx.filter = 'blur(8px)';
  maskCtx.beginPath();

  jaw.forEach((pt, i) => {
    if (i === 0) maskCtx.moveTo(pt.x, pt.y);
    else         maskCtx.lineTo(pt.x, pt.y);
  });
  rightBrow.forEach(pt => maskCtx.lineTo(pt.x, pt.y - foreheadLift));
  // Forehead arc across the top
  const midBrowX = (livePoints[22].x + livePoints[21].x) / 2;
  const midBrowY = (livePoints[22].y + livePoints[21].y) / 2 - foreheadLift * 1.2;
  maskCtx.quadraticCurveTo(midBrowX, midBrowY, leftBrow[0].x, leftBrow[0].y - foreheadLift);
  leftBrow.forEach(pt => maskCtx.lineTo(pt.x, pt.y - foreheadLift));
  maskCtx.closePath();

  maskCtx.fillStyle = 'white';
  maskCtx.fill();
  maskCtx.restore();

  // Apply mask: keep only pixels inside the face oval
  offCtx.globalCompositeOperation = 'destination-in';
  offCtx.drawImage(maskCanvas, 0, 0);
  offCtx.globalCompositeOperation = 'source-over';

  // ── 4. Composite swapped face onto live frame at chosen intensity ───────────
  ctx.save();
  ctx.globalAlpha = intensity;
  ctx.drawImage(offscreen, 0, 0);
  ctx.restore();
}
