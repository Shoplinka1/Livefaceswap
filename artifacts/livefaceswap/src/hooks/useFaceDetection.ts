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
      setLoadError('AI models could not initialize. Try Chrome or Safari on a real device.');
      setLoadingProgress(100);
      setModelsLoaded(true);
    }
  }, []);

  useEffect(() => { loadModels(); }, [loadModels]);

  const setReferenceImage = useCallback(async (img: HTMLImageElement) => {
    refImageRef.current = img;
    refLandmarksRef.current = null;
    setRefFaceStatus('detecting');

    for (const threshold of [0.3, 0.2, 0.1, 0.05]) {
      try {
        const det = await faceapi
          .detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({ scoreThreshold: threshold }))
          .withFaceLandmarks(true);
        if (det) {
          refLandmarksRef.current = det.landmarks;
          setRefFaceStatus('ready');
          return;
        }
      } catch (e) {
        console.warn('[FaceSwap] Detection at threshold', threshold, 'failed:', e);
      }
    }
    setRefFaceStatus('not_found');
    console.warn('[FaceSwap] No face in reference — bounding box fallback active');
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
      const W = videoEl.videoWidth || 640;
      const H = videoEl.videoHeight || 480;

      // Resize canvas only when needed (resizing clears the canvas)
      if (outputCanvas.width !== W) outputCanvas.width = W;
      if (outputCanvas.height !== H) outputCanvas.height = H;

      // Always draw the mirrored camera frame — even if readyState is low,
      // drawImage on a video that has no data is a no-op, not an error.
      // This ensures the canvas is NEVER fully black due to our code.
      try {
        ctx.save();
        ctx.scale(-1, 1);
        ctx.drawImage(videoEl, -W, 0, W, H);
        ctx.restore();
      } catch {
        // drawImage failed — skip this frame but keep looping
        rafRef.current = requestAnimationFrame(loop);
        return;
      }

      // Only attempt face detection when the video is actually delivering frames
      if (videoEl.readyState >= 2 && videoEl.videoWidth > 0 && refImageRef.current) {
        try {
          const det = await faceapi
            .detectSingleFace(
              outputCanvas,
              new faceapi.TinyFaceDetectorOptions({ scoreThreshold: 0.2, inputSize: 224 })
            )
            .withFaceLandmarks(true);

          updateFD(!!det);

          if (det) {
            swapFace(ctx, det, refImageRef.current, refLandmarksRef.current, intensityRef.current);
          }
        } catch {
          updateFD(false);
        }
      } else if (!refImageRef.current) {
        updateFD(false);
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
// MIRRORING CONTRACT:
//   The canvas always shows a MIRRORED camera feed (left/right flipped).
//   Live landmarks are therefore in mirrored canvas space.
//   The reference image is a normal (non-mirrored) photo.
//
//   Fix: draw the ref image mirrored horizontally so it matches the canvas
//   orientation, and adjust the similarity transform accordingly:
//     • Eye-line direction of mirrored ref = (-refDx, refDy)
//     • Rotation = atan2(liveDy, liveDx) − atan2(refDy, −refDx)
//     • Anchor point = mirrored ref eye center = (W_ref − refCx, refCy)

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
  if (W_ref < 1 || H_ref < 1) return;

  ctx.save();

  // Clip to a face-shaped oval
  ctx.beginPath();
  ctx.ellipse(
    bb.x + bb.width  / 2,
    bb.y + bb.height / 2,
    (bb.width  / 2) * 1.10,
    (bb.height / 2) * 1.15,
    0, 0, Math.PI * 2
  );
  ctx.clip();
  ctx.globalAlpha = intensity;

  if (refLandmarks) {
    const rp = refLandmarks.positions;

    const liveLE = avg(lp.slice(36, 42));
    const liveRE = avg(lp.slice(42, 48));
    const refLE  = avg(rp.slice(36, 42));
    const refRE  = avg(rp.slice(42, 48));

    const liveDx = liveRE.x - liveLE.x;
    const liveDy = liveRE.y - liveLE.y;
    const refDx  = refRE.x  - refLE.x;
    const refDy  = refRE.y  - refLE.y;

    const liveED = Math.hypot(liveDx, liveDy);
    const refED  = Math.hypot(refDx,  refDy);
    if (refED < 1 || liveED < 1) { ctx.restore(); return; }

    const scale    = liveED / refED;
    // Mirrored ref eye-line direction is (-refDx, refDy)
    const rot      = Math.atan2(liveDy, liveDx) - Math.atan2(refDy, -refDx);
    const liveCx   = (liveLE.x + liveRE.x) / 2;
    const liveCy   = (liveLE.y + liveRE.y) / 2;
    const refCx    = (refLE.x  + refRE.x)  / 2;
    const refCy    = (refLE.y  + refRE.y)  / 2;
    const refCx_m  = W_ref - refCx; // mirrored eye-center x

    // Map mirrored ref eye-center → live eye-center
    ctx.translate(liveCx, liveCy);
    ctx.rotate(rot);
    ctx.scale(scale, scale);
    ctx.translate(-refCx_m, -refCy);
    // Flip ref image horizontally to match mirrored canvas
    ctx.scale(-1, 1);
    ctx.drawImage(refImg, -W_ref, 0);

  } else {
    // Fallback: stretch ref image to bounding box, mirrored
    ctx.translate(bb.x + bb.width, bb.y);
    ctx.scale(-1, 1);
    ctx.drawImage(refImg, 0, 0, bb.width, bb.height);
  }

  ctx.restore();
}
