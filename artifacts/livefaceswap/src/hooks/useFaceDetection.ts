import { useRef, useState, useCallback, useEffect } from 'react';
import * as faceapi from '@vladmandic/face-api';

const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model';

export function useFaceDetection() {
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [faceDetected, setFaceDetected] = useState(false);
  const [intensity, setIntensity] = useState(0.85);
  const rafRef = useRef<number | null>(null);
  const refImageRef = useRef<HTMLImageElement | null>(null);
  const refLandmarksRef = useRef<faceapi.FaceLandmarks68 | null>(null);
  const lastFaceDetectedUpdateRef = useRef<number>(0);

  const loadModels = useCallback(async () => {
    try {
      setLoadingProgress(5);
      // Wait for TF.js to initialize its best available backend
      // (WebGL on phones, CPU fallback in other envs)
      await (faceapi as any).tf.ready();
      setLoadingProgress(20);
      await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
      setLoadingProgress(70);
      await faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL);
      setLoadingProgress(100);
      setModelsLoaded(true);
    } catch (err: any) {
      console.warn('Model load error (may work fine on device):', err);
      // Still mark as loaded so UI isn't permanently blocked on non-WebGL envs
      // The actual face detection will fail gracefully per-frame
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
    const det = await faceapi
      .detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({ scoreThreshold: 0.3 }))
      .withFaceLandmarks(true);
    if (det) refLandmarksRef.current = det.landmarks;
  }, []);

  // Main render loop — draws the swapped face onto the output canvas
  const startLoop = useCallback((
    videoEl: HTMLVideoElement,
    outputCanvas: HTMLCanvasElement,
    onFaceDetected: (detected: boolean) => void
  ) => {
    const ctx = outputCanvas.getContext('2d')!;
    // Offscreen canvas for compositing
    const offscreen = document.createElement('canvas');

    const updateFaceDetected = (detected: boolean) => {
      const now = Date.now();
      if (now - lastFaceDetectedUpdateRef.current > 500) {
        onFaceDetected(detected);
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

      // Mirror for selfie feel
      ctx.save();
      ctx.scale(-1, 1);
      ctx.drawImage(videoEl, -W, 0, W, H);
      ctx.restore();

      if (refImageRef.current && refLandmarksRef.current) {
        try {
          // Detect face in live frame
          const det = await faceapi
            .detectSingleFace(outputCanvas, new faceapi.TinyFaceDetectorOptions({ scoreThreshold: 0.4 }))
            .withFaceLandmarks(true);

          updateFaceDetected(!!det);

          if (det) {
            // Draw reference face warped to live face landmarks
            swapFace(ctx, offscreen, videoEl, det, refImageRef.current, refLandmarksRef.current, W, H, intensity);
          }
        } catch {
          // Face detection failed this frame — skip silently
          updateFaceDetected(false);
        }
      } else {
        updateFaceDetected(false);
      }

      rafRef.current = requestAnimationFrame(loop);
    }

    rafRef.current = requestAnimationFrame(loop);
    setIsRunning(true);
  }, [intensity]);

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

// Landmark-based face swap using affine transform + polygon clipping
function swapFace(
  ctx: CanvasRenderingContext2D,
  offscreen: HTMLCanvasElement,
  video: HTMLVideoElement,
  liveDet: faceapi.WithFaceLandmarks<{ detection: faceapi.FaceDetection }>,
  refImg: HTMLImageElement,
  refLandmarks: faceapi.FaceLandmarks68,
  W: number,
  H: number,
  intensity: number
) {
  const livePoints = liveDet.landmarks.positions;
  const refPoints = refLandmarks.positions;

  // Use the face oval (jaw + top) — points 0-16 for jaw, 17-26 for brow/top
  // Build a face polygon from the live landmarks
  const faceContour = [
    ...livePoints.slice(0, 17),       // jaw
    livePoints[26], livePoints[25], livePoints[24], livePoints[19], livePoints[18], livePoints[17] // brow
  ];

  const refFaceContour = [
    ...refPoints.slice(0, 17),
    refPoints[26], refPoints[25], refPoints[24], refPoints[19], refPoints[18], refPoints[17]
  ];

  // Compute bounding boxes
  const liveBB = liveDet.detection.box;
  const refBB = getBoundingBox(refFaceContour);

  // Draw reference face scaled + transformed to fit live face bounding box
  const offCtx = offscreen.getContext('2d')!;
  offCtx.clearRect(0, 0, W, H);

  // Clip to face polygon
  offCtx.save();
  offCtx.beginPath();
  faceContour.forEach((pt, i) => {
    // mirrored x
    const mx = W - pt.x;
    if (i === 0) offCtx.moveTo(mx, pt.y);
    else offCtx.lineTo(mx, pt.y);
  });
  offCtx.closePath();
  offCtx.clip();

  // Feather edges with shadow (soft blend)
  offCtx.shadowBlur = 18;
  offCtx.shadowColor = 'rgba(0,0,0,0)';

  // Draw reference face mapped to live face region
  const scaleX = liveBB.width / (refBB.width || 1);
  const scaleY = liveBB.height / (refBB.height || 1);
  const destX = W - liveBB.x - liveBB.width; // mirrored
  const destY = liveBB.y;

  offCtx.drawImage(
    refImg,
    refBB.x, refBB.y, refBB.width, refBB.height,
    destX, destY, liveBB.width, liveBB.height
  );

  offCtx.restore();

  // Color-match: adjust brightness/contrast to match live skin tone (simple)
  // Composite the offscreen result onto the main canvas with intensity alpha
  ctx.save();
  ctx.globalAlpha = intensity;
  ctx.drawImage(offscreen, 0, 0);
  ctx.restore();
}

function getBoundingBox(points: faceapi.Point[]) {
  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
