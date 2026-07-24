import { useRef, useState, useCallback, useEffect } from 'react';
import * as faceapi from '@vladmandic/face-api';

const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model';

function avg(pts: faceapi.Point[]): { x: number; y: number } {
  return {
    x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
    y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
  };
}

// Mirror a detection result from VIDEO (unmirrored) coords → canvas (mirrored) coords
function mirrorDetection(
  det: faceapi.WithFaceLandmarks<{ detection: faceapi.FaceDetection }>,
  W: number
): faceapi.WithFaceLandmarks<{ detection: faceapi.FaceDetection }> {
  const bb = det.detection.box;

  // Mirror the bounding box
  const mirroredBB = new faceapi.Rect(W - bb.x - bb.width, bb.y, bb.width, bb.height);
  const mirroredDetection = new faceapi.FaceDetection(
    det.detection.score,
    mirroredBB,
    { width: W, height: (det.detection as any).imageSize?.height ?? 0 }
  );

  // Mirror all landmark points
  const mirroredPoints = det.landmarks.positions.map(
    pt => new faceapi.Point(W - pt.x, pt.y)
  );
  // @ts-ignore — reconstruct landmarks from mirrored positions
  const mirroredLandmarks = new faceapi.FaceLandmarks68(mirroredPoints, { width: W, height: 0 });

  return {
    detection: mirroredDetection,
    landmarks: mirroredLandmarks,
    unshiftedLandmarks: mirroredLandmarks,
    alignedRect: det.alignedRect,
  } as unknown as faceapi.WithFaceLandmarks<{ detection: faceapi.FaceDetection }>;
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
  const detTickerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refImageRef = useRef<HTMLImageElement | null>(null);
  const refLandmarksRef = useRef<faceapi.FaceLandmarks68 | null>(null);
  // Last mirrored detection result, updated by the async ticker
  const lastDetRef = useRef<faceapi.WithFaceLandmarks<{ detection: faceapi.FaceDetection }> | null>(null);
  const detRunningRef = useRef(false);

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
        console.warn('[FaceSwap] ref detection at', threshold, 'failed:', e);
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
    let stopped = false;

    // ── Detection ticker ────────────────────────────────────────────────────
    // Runs face detection on the RAW video element (no canvas sync issues).
    // Results are mirrored to match the canvas orientation.
    // Runs every ~200ms so it doesn't block the render loop.
    async function detectionTick() {
      if (stopped) return;
      if (!detRunningRef.current && refImageRef.current && videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
        detRunningRef.current = true;
        try {
          const W = videoEl.videoWidth;
          const det = await faceapi
            .detectSingleFace(
              videoEl,
              new faceapi.TinyFaceDetectorOptions({ scoreThreshold: 0.1, inputSize: 224 })
            )
            .withFaceLandmarks(true);

          if (det) {
            lastDetRef.current = mirrorDetection(det, W);
            setFaceDetected(true);
            onFaceDetected(true);
          } else {
            lastDetRef.current = null;
            setFaceDetected(false);
            onFaceDetected(false);
          }
        } catch {
          lastDetRef.current = null;
        }
        detRunningRef.current = false;
      }
      if (!stopped) {
        detTickerRef.current = setTimeout(detectionTick, 200);
      }
    }

    detectionTick();

    // ── Render loop ─────────────────────────────────────────────────────────
    // Runs every animation frame — draws video + applies swap using the last
    // stored detection result. Never blocks on async work.
    function renderLoop() {
      if (stopped) return;

      const W = videoEl.videoWidth  || 640;
      const H = videoEl.videoHeight || 480;

      if (outputCanvas.width !== W)  outputCanvas.width  = W;
      if (outputCanvas.height !== H) outputCanvas.height = H;

      // Always draw mirrored camera feed first
      try {
        ctx.save();
        ctx.scale(-1, 1);
        ctx.drawImage(videoEl, -W, 0, W, H);
        ctx.restore();
      } catch {
        rafRef.current = requestAnimationFrame(renderLoop);
        return;
      }

      const img = refImageRef.current;
      if (img) {
        const det = lastDetRef.current;
        if (det) {
          // Precise landmark/bbox swap
          swapFace(ctx, det, img, refLandmarksRef.current, intensityRef.current);
        } else {
          // ── Fallback: draw ref image in estimated face zone ──────────────
          // Center-top 40% of frame, so it roughly covers where a selfie face sits.
          // This guarantees the user sees the overlay immediately even before
          // face detection locks on, and whenever detection temporarily fails.
          drawFallbackOverlay(ctx, img, W, H, intensityRef.current);
        }
      }

      rafRef.current = requestAnimationFrame(renderLoop);
    }

    rafRef.current = requestAnimationFrame(renderLoop);
    setIsRunning(true);

    return () => { stopped = true; };
  }, []);

  const stopLoop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (detTickerRef.current) clearTimeout(detTickerRef.current);
    detTickerRef.current = null;
    lastDetRef.current = null;
    detRunningRef.current = false;
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

// ─── Fallback overlay ────────────────────────────────────────────────────────
// Draws the ref image clipped to an oval in the upper-center of the frame.
// Used when face detection hasn't locked on yet.

function drawFallbackOverlay(
  ctx: CanvasRenderingContext2D,
  refImg: HTMLImageElement,
  W: number,
  H: number,
  intensity: number
) {
  // Estimated face zone: horizontally centered, top 20%–60% of frame
  const cx = W * 0.5;
  const cy = H * 0.36;
  const rx = W * 0.22;
  const ry = H * 0.28;

  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.clip();
  ctx.globalAlpha = intensity;

  // Draw ref image (mirrored) centred in the oval
  const iw = refImg.naturalWidth  || 1;
  const ih = refImg.naturalHeight || 1;
  const scale = Math.max(rx * 2 / iw, ry * 2 / ih);
  const dw = iw * scale;
  const dh = ih * scale;

  ctx.translate(cx, cy);
  ctx.scale(-1, 1);               // mirror to match camera
  ctx.drawImage(refImg, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

// ─── Precise face-swap renderer ──────────────────────────────────────────────
//
// MIRRORING CONTRACT:
//   detection results are pre-mirrored to canvas coords before arriving here.
//   The ref image is drawn mirrored (ctx.scale(-1,1)) to match the canvas.
//
// Two modes:
//   Landmark — similarity transform aligns eye-lines
//   Fallback — bounding-box stretch

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

    const liveDx = liveRE.x - liveLE.x, liveDy = liveRE.y - liveLE.y;
    const refDx  = refRE.x  - refLE.x,  refDy  = refRE.y  - refLE.y;

    const liveED = Math.hypot(liveDx, liveDy);
    const refED  = Math.hypot(refDx, refDy);
    if (refED < 1 || liveED < 1) { ctx.restore(); return; }

    const scale   = liveED / refED;
    const rot     = Math.atan2(liveDy, liveDx) - Math.atan2(refDy, -refDx);
    const liveCx  = (liveLE.x + liveRE.x) / 2;
    const liveCy  = (liveLE.y + liveRE.y) / 2;
    const refCx   = (refLE.x  + refRE.x)  / 2;
    const refCy   = (refLE.y  + refRE.y)  / 2;
    const refCx_m = W_ref - refCx;

    ctx.translate(liveCx, liveCy);
    ctx.rotate(rot);
    ctx.scale(scale, scale);
    ctx.translate(-refCx_m, -refCy);
    ctx.scale(-1, 1);
    ctx.drawImage(refImg, -W_ref, 0);

  } else {
    ctx.translate(bb.x + bb.width, bb.y);
    ctx.scale(-1, 1);
    ctx.drawImage(refImg, 0, 0, bb.width, bb.height);
  }

  ctx.restore();
}
