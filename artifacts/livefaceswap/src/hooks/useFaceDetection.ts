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
  const [intensity, setIntensityState] = useState(0.9);
  const [refFaceStatus, setRefFaceStatus] = useState<RefFaceStatus>('idle');

  const intensityRef = useRef(0.9);
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

    // Try progressively lower thresholds until we find a face
    for (const threshold of [0.3, 0.2, 0.1]) {
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
    // No landmarks found — bounding-box fallback will still work
    setRefFaceStatus('not_found');
    console.warn('[FaceSwap] No face found in reference image — will use bounding box fallback');
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
      if (!videoEl || videoEl.readyState < 2) {
        rafRef.current = requestAnimationFrame(loop);
        return;
      }

      const W = videoEl.videoWidth || 640;
      const H = videoEl.videoHeight || 480;
      outputCanvas.width = W;
      outputCanvas.height = H;

      // Draw mirrored camera feed
      ctx.save();
      ctx.scale(-1, 1);
      ctx.drawImage(videoEl, -W, 0, W, H);
      ctx.restore();

      if (refImageRef.current) {
        try {
          const det = await faceapi
            .detectSingleFace(outputCanvas, new faceapi.TinyFaceDetectorOptions({ scoreThreshold: 0.3 }))
            .withFaceLandmarks(true);

          updateFD(!!det);

          if (det) {
            swapFace(
              ctx,
              det,
              refImageRef.current,
              refLandmarksRef.current,
              W, H,
              intensityRef.current
            );
          }
        } catch {
          updateFD(false);
        }
      } else {
        updateFD(false);
      }

      rafRef.current = requestAnimationFrame(loop);
    }

    rafRef.current = requestAnimationFrame(loop);
    setIsRunning(true);
  }, []); // intentionally no intensity dep — reads from ref

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

// ─── Core face-swap renderer ───────────────────────────────────────────────────
//
// ALL live landmark coordinates are already in the MIRRORED canvas coordinate
// system (detection ran on the mirrored canvas). Never re-flip them.
//
// Two modes:
//   • Landmark mode  — ref image had a detectable face → similarity transform
//                       aligns eye-lines → expression tracking works
//   • Fallback mode  — ref image face not detected → bounding-box stretch,
//                       no expression tracking but face still replaces

function swapFace(
  ctx: CanvasRenderingContext2D,
  liveDet: faceapi.WithFaceLandmarks<{ detection: faceapi.FaceDetection }>,
  refImg: HTMLImageElement,
  refLandmarks: faceapi.FaceLandmarks68 | null,
  _W: number,
  _H: number,
  intensity: number
) {
  const lp = liveDet.landmarks.positions;
  const bb = liveDet.detection.box;

  ctx.save();

  // ── Face oval clip — ellipse matching the detection bounding box ───────────
  // This is reliable across all browsers and avoids complex polygon maths.
  ctx.beginPath();
  ctx.ellipse(
    bb.x + bb.width / 2,       // center x
    bb.y + bb.height / 2,      // center y
    (bb.width  / 2) * 1.08,    // x radius — slightly wider than box
    (bb.height / 2) * 1.12,    // y radius — slightly taller (forehead room)
    0, 0, Math.PI * 2
  );
  ctx.clip();
  ctx.globalAlpha = intensity;

  if (refLandmarks) {
    // ── LANDMARK MODE: similarity transform (scale + rotate + translate) ──────
    const rp = refLandmarks.positions;

    const liveLE = avg(lp.slice(36, 42));
    const liveRE = avg(lp.slice(42, 48));
    const refLE  = avg(rp.slice(36, 42));
    const refRE  = avg(rp.slice(42, 48));

    const liveDx = liveRE.x - liveLE.x, liveDy = liveRE.y - liveLE.y;
    const refDx  = refRE.x  - refLE.x,  refDy  = refRE.y  - refLE.y;

    const liveED = Math.sqrt(liveDx * liveDx + liveDy * liveDy);
    const refED  = Math.sqrt(refDx  * refDx  + refDy  * refDy);

    if (refED < 1 || liveED < 1) { ctx.restore(); return; }

    const scale  = liveED / refED;
    const rot    = Math.atan2(liveDy, liveDx) - Math.atan2(refDy, refDx);
    const liveCx = (liveLE.x + liveRE.x) / 2;
    const liveCy = (liveLE.y + liveRE.y) / 2;
    const refCx  = (refLE.x  + refRE.x)  / 2;
    const refCy  = (refLE.y  + refRE.y)  / 2;

    // Map: ref eye-center → live eye-center, with matching scale + rotation
    ctx.translate(liveCx, liveCy);
    ctx.rotate(rot);
    ctx.scale(scale, scale);
    ctx.translate(-refCx, -refCy);
    ctx.drawImage(refImg, 0, 0);
  } else {
    // ── FALLBACK MODE: stretch ref image to fit live face bounding box ────────
    ctx.drawImage(
      refImg,
      0, 0, refImg.naturalWidth, refImg.naturalHeight,
      bb.x, bb.y, bb.width, bb.height
    );
  }

  ctx.restore();
}
