import { useRef, useState, useCallback, useEffect } from 'react';
import * as faceapi from '@vladmandic/face-api';

const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model';

function avg(pts: faceapi.Point[]): { x: number; y: number } {
  return {
    x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
    y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
  };
}

// Mirror a detection result from VIDEO (unmirrored) coords → canvas (mirrored) coords.
// face-api runs on the raw video element which is not flipped; the canvas is flipped.
function mirrorDetection(
  det: faceapi.WithFaceLandmarks<{ detection: faceapi.FaceDetection }>,
  W: number
): faceapi.WithFaceLandmarks<{ detection: faceapi.FaceDetection }> {
  const bb = det.detection.box;
  const mirroredBB = new faceapi.Rect(W - bb.x - bb.width, bb.y, bb.width, bb.height);
  const mirroredDetection = new faceapi.FaceDetection(
    det.detection.score,
    mirroredBB,
    { width: W, height: (det.detection as any).imageSize?.height ?? 0 }
  );
  const mirroredPoints = det.landmarks.positions.map(
    pt => new faceapi.Point(W - pt.x, pt.y)
  );
  // @ts-ignore
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
  const [intensity, setIntensityState] = useState(0.95);
  const [refFaceStatus, setRefFaceStatus] = useState<RefFaceStatus>('idle');

  const intensityRef    = useRef(0.95);
  const rafRef          = useRef<number | null>(null);
  const detTickerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refImageRef     = useRef<HTMLImageElement | null>(null);
  const refLandmarksRef = useRef<faceapi.FaceLandmarks68 | null>(null);
  const lastDetRef      = useRef<faceapi.WithFaceLandmarks<{ detection: faceapi.FaceDetection }> | null>(null);
  const detBusyRef      = useRef(false);

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
      setLoadError('AI models failed to load. Try Chrome or Safari on a real device.');
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
      } catch { /* try lower threshold */ }
    }
    setRefFaceStatus('not_found');
  }, []);

  const startLoop = useCallback((
    videoEl: HTMLVideoElement,
    outputCanvas: HTMLCanvasElement,
    onFaceDetected: (v: boolean) => void
  ) => {
    const ctx = outputCanvas.getContext('2d')!;
    let stopped = false;

    // ── Async detection ticker ───────────────────────────────────────────────
    // Runs on the raw video element so there are no canvas-sync issues.
    // Fires every 150 ms and only when a reference image is loaded.
    async function detTick() {
      if (stopped) return;

      if (!detBusyRef.current && refImageRef.current &&
          videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
        detBusyRef.current = true;
        try {
          // Use inputSize 416 for better accuracy on mobile (slower but worth it)
          const det = await faceapi
            .detectSingleFace(
              videoEl,
              new faceapi.TinyFaceDetectorOptions({ scoreThreshold: 0.1, inputSize: 416 })
            )
            .withFaceLandmarks(true);

          if (det) {
            lastDetRef.current = mirrorDetection(det, videoEl.videoWidth);
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
        detBusyRef.current = false;
      }

      if (!stopped) detTickerRef.current = setTimeout(detTick, 150);
    }

    detTick();

    // ── Render loop (runs every animation frame — never blocks) ─────────────
    function renderLoop() {
      if (stopped) return;

      const W = videoEl.videoWidth  || 640;
      const H = videoEl.videoHeight || 480;

      if (outputCanvas.width  !== W) outputCanvas.width  = W;
      if (outputCanvas.height !== H) outputCanvas.height = H;

      // 1. Always draw the full mirrored camera frame
      try {
        ctx.save();
        ctx.scale(-1, 1);
        ctx.drawImage(videoEl, -W, 0, W, H);
        ctx.restore();
      } catch {
        rafRef.current = requestAnimationFrame(renderLoop);
        return;
      }

      // 2. Only apply the face swap when detection has a result.
      //    When there's no detection, the user sees their raw camera feed —
      //    clear, full-screen, no confusing static oval.
      const det = lastDetRef.current;
      const img = refImageRef.current;
      if (det && img) {
        swapFace(ctx, det, img, refLandmarksRef.current, intensityRef.current);
      }

      rafRef.current = requestAnimationFrame(renderLoop);
    }

    rafRef.current = requestAnimationFrame(renderLoop);
    setIsRunning(true);
  }, []);

  const stopLoop = useCallback(() => {
    if (rafRef.current)    cancelAnimationFrame(rafRef.current);
    if (detTickerRef.current) clearTimeout(detTickerRef.current);
    rafRef.current     = null;
    detTickerRef.current = null;
    lastDetRef.current  = null;
    detBusyRef.current  = false;
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

// ─── Face-swap renderer ──────────────────────────────────────────────────────
//
// The canvas is mirrored (left/right flipped). Detection results are pre-mirrored.
// The reference image is drawn mirrored (ctx.scale(-1,1)) to match.
//
// The swap area covers the full head — much larger than the raw face bbox —
// so the result looks like a complete head replacement, not a small patch.
//
// Modes:
//   Landmark  — similarity transform aligns the eye-lines of ref and live
//   Bbox only — ref image scaled/mirrored into the (expanded) bbox

function swapFace(
  ctx: CanvasRenderingContext2D,
  liveDet: faceapi.WithFaceLandmarks<{ detection: faceapi.FaceDetection }>,
  refImg: HTMLImageElement,
  refLandmarks: faceapi.FaceLandmarks68 | null,
  intensity: number
) {
  const lp    = liveDet.landmarks.positions;
  const bb    = liveDet.detection.box;
  const W_ref = refImg.naturalWidth;
  const H_ref = refImg.naturalHeight;
  if (W_ref < 1 || H_ref < 1) return;

  // Expand the clip region to cover the whole head (hair, ears, chin, neck)
  const cx = bb.x + bb.width  / 2;
  const cy = bb.y + bb.height / 2;
  const rx  = (bb.width  / 2) * 1.55;  // ~55 % wider than face bbox
  const ry  = (bb.height / 2) * 1.80;  // ~80 % taller (includes hair & chin)

  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.clip();
  ctx.globalAlpha = intensity;

  if (refLandmarks) {
    // ── Landmark-based similarity transform ──────────────────────────────────
    // Eye-line of mirrored ref: direction (-refDx, refDy).
    const rp    = refLandmarks.positions;
    const liveLE = avg(lp.slice(36, 42));
    const liveRE = avg(lp.slice(42, 48));
    const refLE  = avg(rp.slice(36, 42));
    const refRE  = avg(rp.slice(42, 48));

    const liveDx = liveRE.x - liveLE.x, liveDy = liveRE.y - liveLE.y;
    const refDx  = refRE.x  - refLE.x,  refDy  = refRE.y  - refLE.y;

    const liveED = Math.hypot(liveDx, liveDy);
    const refED  = Math.hypot(refDx,  refDy);
    if (refED < 1 || liveED < 1) { ctx.restore(); return; }

    const scale    = liveED / refED;
    const rot      = Math.atan2(liveDy, liveDx) - Math.atan2(refDy, -refDx);
    const liveCx   = (liveLE.x + liveRE.x) / 2;
    const liveCy   = (liveLE.y + liveRE.y) / 2;
    const refCx    = (refLE.x  + refRE.x)  / 2;
    const refCy    = (refLE.y  + refRE.y)  / 2;
    const refCx_m  = W_ref - refCx;   // eye-center x in mirrored ref coords

    ctx.translate(liveCx, liveCy);
    ctx.rotate(rot);
    ctx.scale(scale, scale);
    ctx.translate(-refCx_m, -refCy);
    ctx.scale(-1, 1);                  // mirror the ref image
    ctx.drawImage(refImg, -W_ref, 0);

  } else {
    // ── Bbox fallback: fill the expanded oval ────────────────────────────────
    const dw = rx * 2, dh = ry * 2;
    ctx.translate(cx + rx, cy - ry);  // top-right corner of draw rect
    ctx.scale(-1, 1);
    ctx.drawImage(refImg, 0, 0, dw, dh);
  }

  ctx.restore();
}
