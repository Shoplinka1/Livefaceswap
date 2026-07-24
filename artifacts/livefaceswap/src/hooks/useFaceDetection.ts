import { useRef, useState, useCallback, useEffect } from 'react';
import * as faceapi from '@vladmandic/face-api';

const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model';

function avg(pts: faceapi.Point[]): { x: number; y: number } {
  return {
    x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
    y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
  };
}

export type RefFaceStatus = 'idle' | 'detecting' | 'ready' | 'not_found';

export function useFaceDetection() {
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [faceDetected, setFaceDetected] = useState(false);
  const [intensity, setIntensityState] = useState(0.92);
  const [refFaceStatus, setRefFaceStatus] = useState<RefFaceStatus>('idle');

  const intensityRef = useRef(0.92);
  const rafRef = useRef<number | null>(null);
  const refImageRef = useRef<HTMLImageElement | null>(null);
  const refLandmarksRef = useRef<faceapi.FaceLandmarks68 | null>(null);
  const lastFaceUpdateRef = useRef<number>(0);

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
      setLoadError('AI models could not initialize. Try on a real phone browser.');
      setLoadingProgress(100);
      setModelsLoaded(true);
    }
  }, []);

  useEffect(() => { loadModels(); }, [loadModels]);

  const setReferenceImage = useCallback(async (img: HTMLImageElement) => {
    refImageRef.current = img;
    refLandmarksRef.current = null;
    setRefFaceStatus('detecting');

    // Try progressively lower thresholds
    for (const threshold of [0.3, 0.2, 0.1, 0.05]) {
      try {
        const det = await faceapi
          .detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({ scoreThreshold: threshold }))
          .withFaceLandmarks(true);
        if (det) {
          refLandmarksRef.current = det.landmarks;
          setRefFaceStatus('ready');
          console.log('[FaceSwap] Reference face landmarks loaded ✓ (threshold:', threshold, ')');
          return;
        }
      } catch (e) {
        console.warn('[FaceSwap] Detection at threshold', threshold, 'failed:', e);
      }
    }
    // No landmarks found — bounding-box fallback still works
    setRefFaceStatus('not_found');
    console.warn('[FaceSwap] No face detected in reference — using bounding box fallback');
  }, []);

  const startLoop = useCallback((
    videoEl: HTMLVideoElement,
    outputCanvas: HTMLCanvasElement,
    onFaceDetected: (v: boolean) => void
  ) => {
    const ctx = outputCanvas.getContext('2d')!;

    const updateFD = (v: boolean) => {
      const now = Date.now();
      if (now - lastFaceUpdateRef.current > 400) {
        onFaceDetected(v);
        setFaceDetected(v);
        lastFaceUpdateRef.current = now;
      }
    };

    async function loop() {
      // Always draw the mirrored video frame first — this keeps the screen alive
      if (videoEl && videoEl.readyState >= 2) {
        const W = videoEl.videoWidth || 640;
        const H = videoEl.videoHeight || 480;

        if (outputCanvas.width !== W) outputCanvas.width = W;
        if (outputCanvas.height !== H) outputCanvas.height = H;

        // Draw mirrored camera feed
        ctx.save();
        ctx.scale(-1, 1);
        ctx.drawImage(videoEl, -W, 0, W, H);
        ctx.restore();

        // Face swap overlay
        if (refImageRef.current) {
          try {
            const det = await faceapi
              .detectSingleFace(
                outputCanvas,
                new faceapi.TinyFaceDetectorOptions({ scoreThreshold: 0.2, inputSize: 224 })
              )
              .withFaceLandmarks(true);

            updateFD(!!det);

            if (det) {
              swapFace(
                ctx,
                det,
                refImageRef.current,
                refLandmarksRef.current,
                intensityRef.current
              );
            }
          } catch {
            updateFD(false);
          }
        } else {
          updateFD(false);
        }
      }

      rafRef.current = requestAnimationFrame(loop);
    }

    rafRef.current = requestAnimationFrame(loop);
    setIsRunning(true);
  }, []);

  const stopLoop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    setIsRunning(false);
    setFaceDetected(false);
  }, []);

  return {
    modelsLoaded, loadingProgress, loadError,
    isRunning, faceDetected,
    intensity, setIntensity,
    refFaceStatus,
    setReferenceImage, startLoop, stopLoop,
  };
}

// ─── Core face-swap renderer ────────────────────────────────────────────────
//
// The live canvas is MIRRORED (scale(-1,1) applied when drawing video).
// All live landmark coordinates are in mirrored canvas space.
//
// The reference image is a normal (non-mirrored) photo.
// We must draw it mirrored to match the canvas orientation, and adjust the
// similarity transform accordingly (eye-line direction flips on x-axis).
//
// Two modes:
//   • Landmark mode — ref image had a detectable face → align eye centers with
//                     correct mirrored similarity transform
//   • Fallback mode — no ref landmarks → bounding-box stretch, mirrored

function swapFace(
  ctx: CanvasRenderingContext2D,
  liveDet: faceapi.WithFaceLandmarks<{ detection: faceapi.FaceDetection }>,
  refImg: HTMLImageElement,
  refLandmarks: faceapi.FaceLandmarks68 | null,
  intensity: number
) {
  const lp = liveDet.landmarks.positions;
  const bb = liveDet.detection.box;
  const W_ref = refImg.naturalWidth;
  const H_ref = refImg.naturalHeight;

  ctx.save();

  // ── Face oval clip ─────────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.ellipse(
    bb.x + bb.width / 2,
    bb.y + bb.height / 2,
    (bb.width  / 2) * 1.1,
    (bb.height / 2) * 1.15,
    0, 0, Math.PI * 2
  );
  ctx.clip();
  ctx.globalAlpha = intensity;

  if (refLandmarks && W_ref > 0 && H_ref > 0) {
    // ── LANDMARK MODE ─────────────────────────────────────────────────────────
    //
    // Live eye landmarks are in MIRRORED canvas space:
    //   liveLE (eye indices 36-41) → appears on RIGHT side of screen
    //   liveRE (eye indices 42-47) → appears on LEFT side of screen
    //
    // Ref image landmarks are in NORMAL (unmirrored) photo space.
    // When we mirror the ref image (flip x), the eye centers mirror too:
    //   mirrored refLE.x = W_ref - refLE.x  (now on the right)
    //   mirrored refRE.x = W_ref - refRE.x  (now on the left)
    //
    // Eye-line direction in mirrored ref space:
    //   dx_m = (W_ref - refRE.x) - (W_ref - refLE.x) = refLE.x - refRE.x = -refDx
    //   dy_m = refDy  (unchanged)
    //
    // This matches the live eye-line direction (liveDx is also negative for a
    // frontal face in mirrored camera), so rotation ≈ 0 for a straight face.

    const rp = refLandmarks.positions;

    const liveLE = avg(lp.slice(36, 42));
    const liveRE = avg(lp.slice(42, 48));
    const refLE  = avg(rp.slice(36, 42));
    const refRE  = avg(rp.slice(42, 48));

    const liveDx = liveRE.x - liveLE.x;
    const liveDy = liveRE.y - liveLE.y;
    const refDx  = refRE.x  - refLE.x;
    const refDy  = refRE.y  - refLE.y;

    const liveED = Math.sqrt(liveDx * liveDx + liveDy * liveDy);
    const refED  = Math.sqrt(refDx  * refDx  + refDy  * refDy);

    if (refED < 1 || liveED < 1) { ctx.restore(); return; }

    const scale = liveED / refED;

    // Rotation: angle of live eye-line minus angle of MIRRORED ref eye-line
    // Mirrored ref eye-line direction: (-refDx, refDy)
    const rot = Math.atan2(liveDy, liveDx) - Math.atan2(refDy, -refDx);

    const liveCx = (liveLE.x + liveRE.x) / 2;
    const liveCy = (liveLE.y + liveRE.y) / 2;
    const refCx  = (refLE.x  + refRE.x)  / 2;
    const refCy  = (refLE.y  + refRE.y)  / 2;

    // Mirrored ref eye center x
    const refCx_m = W_ref - refCx;

    // Build transform: map mirrored ref eye-center → live eye-center
    ctx.translate(liveCx, liveCy);
    ctx.rotate(rot);
    ctx.scale(scale, scale);
    ctx.translate(-refCx_m, -refCy);

    // Draw the ref image mirrored horizontally:
    // ctx.scale(-1, 1) flips x; drawImage at (-W_ref, 0) places it at [0, W_ref]
    ctx.scale(-1, 1);
    ctx.drawImage(refImg, -W_ref, 0);

  } else {
    // ── FALLBACK MODE: bounding-box stretch, mirrored ─────────────────────────
    // Translate to right edge of bounding box, flip x, draw stretched to box size
    ctx.translate(bb.x + bb.width, bb.y);
    ctx.scale(-1, 1);
    ctx.drawImage(refImg, 0, 0, bb.width, bb.height);
  }

  ctx.restore();
}
