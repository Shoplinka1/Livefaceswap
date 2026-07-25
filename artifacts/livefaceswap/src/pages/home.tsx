/**
 * home.tsx — React shell for LiveFaceSwap.
 *
 * Architecture note: the canvas must ALWAYS be mounted so the
 * AnimationController (created once on mount) always has a valid canvas ref.
 * The upload screen overlays the canvas; once running it slides away.
 */
import { useRef, useState, useEffect, useCallback } from 'react';
import { Upload, Square, Video, StopCircle, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { AnimationController, type ControllerStatus } from '@/engine/AnimationController';
import { RecordingController } from '@/engine/RecordingController';
import type { FaceParams } from '@/engine/types';

type RefStatus = 'idle' | 'detecting' | 'ready' | 'not_found';

export default function Home() {
  // ── Engine refs (never trigger re-renders) ────────────────────────────────
  const canvasRef     = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<AnimationController | null>(null);
  const recorderRef   = useRef<RecordingController>(new RecordingController());
  const fileInputRef  = useRef<HTMLInputElement>(null);

  // ── UI state ──────────────────────────────────────────────────────────────
  const [ctrlStatus,   setCtrlStatus]   = useState<ControllerStatus>('idle');
  const [loadPct,      setLoadPct]      = useState(0);
  const [refStatus,    setRefStatus]    = useState<RefStatus>('idle');
  const [refImageURL,  setRefImageURL]  = useState<string | null>(null);
  const [detected,     setDetected]     = useState(false);
  const [recording,    setRecording]    = useState(false);
  const [cameraError,  setCameraError]  = useState<string | null>(null);
  const [showControls, setShowControls] = useState(true);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Mount: create controller once and load models ─────────────────────────
  useEffect(() => {
    if (!canvasRef.current) return;

    const ctrl = new AnimationController(canvasRef.current);
    controllerRef.current = ctrl;

    ctrl.onStatus   = (s) => setCtrlStatus(s);
    ctrl.onProgress = (pct) => setLoadPct(pct);
    ctrl.onParams   = (p: FaceParams) => setDetected(p.detected);

    ctrl.loadModels().catch(console.error);

    return () => {
      ctrl.destroy();
      controllerRef.current = null;
    };
  }, []);

  // ── Auto-hide controls ────────────────────────────────────────────────────
  const resetHideTimer = useCallback(() => {
    setShowControls(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setShowControls(false), 3500);
  }, []);

  const isRunning = ctrlStatus === 'running';
  const isLoading = ctrlStatus === 'loading' || ctrlStatus === 'starting';

  useEffect(() => {
    if (isRunning) {
      resetHideTimer();
    } else {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      setShowControls(true);
    }
  }, [isRunning, resetHideTimer]);

  // ── File upload ───────────────────────────────────────────────────────────
  const handleUpload = useCallback(async (file: File) => {
    const ctrl = controllerRef.current;
    if (!ctrl) return;

    const url = URL.createObjectURL(file);
    setRefImageURL(url);
    setRefStatus('detecting');
    setCameraError(null);

    const img = new Image();
    img.src = url;
    await new Promise<void>(res => { img.onload = () => res(); });

    // Detect reference face landmarks (once per upload)
    const landmarks = await ctrl.detectRefLandmarks(img);
    ctrl.setRefFace({ image: img, landmarks });
    setRefStatus(landmarks ? 'ready' : 'not_found');

    // Start or restart the engine
    if (ctrlStatus === 'running') return; // already running, just swapped ref
    try {
      await ctrl.start();
    } catch (err: any) {
      const name = err?.name ?? '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setCameraError('Camera permission denied — please allow camera access.');
      } else if (name === 'NotFoundError') {
        setCameraError('No camera found on this device.');
      } else {
        setCameraError('Could not start camera: ' + (err?.message ?? String(err)));
      }
    }
  }, [ctrlStatus]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) {
      handleUpload(e.target.files[0]);
      e.target.value = '';
    }
  };

  // ── Stop ──────────────────────────────────────────────────────────────────
  const handleStop = useCallback(() => {
    if (recorderRef.current.isRecording) {
      recorderRef.current.stop();
      setRecording(false);
    }
    controllerRef.current?.stop();
    setDetected(false);
    setRefImageURL(null);
    setRefStatus('idle');
  }, []);

  // ── Record ────────────────────────────────────────────────────────────────
  const handleRecord = useCallback(() => {
    const ctrl = controllerRef.current;
    if (!ctrl) return;
    const rec = recorderRef.current;
    if (rec.isRecording) {
      rec.stop();
      setRecording(false);
    } else {
      rec.start(ctrl.captureStream());
      setRecording(true);
    }
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  // SINGLE RENDER TREE — canvas always in DOM, upload overlay on top when idle
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div
      className="fixed inset-0 bg-black overflow-hidden"
      onPointerDown={isRunning ? resetHideTimer : undefined}
      onPointerMove={isRunning ? resetHideTimer : undefined}
    >
      {/* ── Avatar canvas (always mounted, full-screen) ─────────────────── */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ display: 'block' }}
      />

      {/* ── Upload overlay (shown when not running) ─────────────────────── */}
      {!isRunning && (
        <div className="absolute inset-0 flex flex-col items-center justify-center p-6 gap-6 bg-black">
          {/* Title */}
          <h1 className="text-3xl font-black tracking-tight text-white">
            Live<span className="text-violet-400">Face</span>Swap
          </h1>

          <div className="w-full max-w-sm flex flex-col gap-4">

            {/* Model loading bar */}
            {(ctrlStatus === 'loading' || (ctrlStatus === 'idle' && loadPct < 100)) && (
              <div className="bg-white/5 border border-white/10 rounded-2xl p-5 flex flex-col gap-3">
                <div className="flex items-center justify-between text-sm text-white/50">
                  <span className="flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin text-violet-400" />
                    Loading AI models…
                  </span>
                  <span className="font-mono text-white/70">{loadPct}%</span>
                </div>
                <div className="w-full h-1 bg-white/5 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-violet-500 rounded-full transition-all duration-300"
                    style={{ width: `${loadPct}%` }}
                  />
                </div>
              </div>
            )}

            {/* Camera error */}
            {cameraError && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-2xl p-4 text-sm text-red-400 text-center">
                {cameraError}
              </div>
            )}

            {/* Upload zone */}
            <input
              type="file"
              accept="image/*"
              className="hidden"
              ref={fileInputRef}
              onChange={handleFileChange}
            />

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isLoading}
              className="w-full h-64 border-2 border-dashed border-white/20 rounded-3xl flex items-center justify-center bg-white/5 hover:bg-white/10 hover:border-violet-500/60 transition-all group overflow-hidden relative disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {refImageURL ? (
                <>
                  <img
                    src={refImageURL}
                    alt="Reference"
                    className="absolute inset-0 w-full h-full object-cover"
                  />
                  <div className="absolute inset-0 bg-black/55" />
                  <div className="relative z-10 flex flex-col items-center gap-2">
                    {refStatus === 'detecting' && (
                      <>
                        <Loader2 className="w-8 h-8 animate-spin text-white" />
                        <span className="text-sm font-semibold text-white drop-shadow">Scanning face…</span>
                      </>
                    )}
                    {refStatus === 'ready' && (
                      <>
                        <CheckCircle2 className="w-9 h-9 text-green-400" />
                        <span className="text-sm font-semibold text-green-300">Face ready — tap to change</span>
                      </>
                    )}
                    {refStatus === 'not_found' && (
                      <>
                        <AlertCircle className="w-9 h-9 text-amber-400" />
                        <span className="text-sm font-semibold text-amber-300 text-center px-4">
                          No face detected — try a clearer photo
                        </span>
                      </>
                    )}
                  </div>
                </>
              ) : (
                <div className="flex flex-col items-center gap-4">
                  <div className="w-20 h-20 rounded-full bg-violet-500/15 border border-violet-500/30 flex items-center justify-center group-hover:bg-violet-500/25 transition-colors">
                    <Upload className="w-8 h-8 text-violet-400" />
                  </div>
                  <div className="text-center px-4">
                    <p className="text-base font-bold text-white/90 group-hover:text-white">
                      Upload a face photo
                    </p>
                    <p className="text-sm text-white/40 mt-1">
                      The photo becomes your live avatar
                    </p>
                  </div>
                </div>
              )}
            </button>

            {/* Starting indicator */}
            {isLoading && ctrlStatus === 'starting' && (
              <div className="flex items-center justify-center gap-2 text-white/50 text-sm">
                <Loader2 className="w-4 h-4 animate-spin text-violet-400" />
                Starting camera…
              </div>
            )}

            {/* Description */}
            {!refImageURL && !isLoading && (
              <p className="text-center text-white/30 text-sm">
                Upload a photo → it appears full-screen and<br />
                mimics your face movements in real time
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── Running: status pill (top-right) ────────────────────────────── */}
      {isRunning && (
        <div className={`absolute top-5 right-5 transition-opacity duration-500 ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold tracking-wider backdrop-blur-md border shadow-lg ${
            detected
              ? 'bg-green-500/10 border-green-500/40 text-green-400'
              : 'bg-amber-500/10 border-amber-500/40 text-amber-400'
          }`}>
            <span className={`w-2 h-2 rounded-full ${detected ? 'bg-green-400' : 'bg-amber-400 animate-pulse'}`} />
            {detected ? 'LIVE' : 'SEARCHING…'}
          </div>
        </div>
      )}

      {/* ── Running: recording badge (top-left) ─────────────────────────── */}
      {isRunning && recording && (
        <div className="absolute top-5 left-5 flex items-center gap-2 px-3 py-1.5 rounded-full bg-red-500/20 border border-red-500/40 text-red-400 text-xs font-bold tracking-wider backdrop-blur-md shadow-lg animate-pulse">
          <span className="w-2 h-2 rounded-full bg-red-400" />
          REC
        </div>
      )}

      {/* ── Running: 3 floating bottom buttons ──────────────────────────── */}
      {isRunning && (
        <>
          {/* Hidden file input for "New Image" mid-session */}
          <input
            type="file"
            accept="image/*"
            className="hidden"
            ref={fileInputRef}
            onChange={handleFileChange}
          />

          <div className={`absolute bottom-0 left-0 right-0 pb-10 px-6 flex justify-center gap-3 transition-all duration-500 ${
            showControls ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8 pointer-events-none'
          }`}>
            {/* Stop */}
            <button
              onClick={handleStop}
              className="flex items-center gap-2 px-5 py-3 bg-red-500/20 hover:bg-red-500 border border-red-500/50 text-red-400 hover:text-white rounded-2xl backdrop-blur-xl font-bold text-sm transition-all shadow-xl"
            >
              <Square className="w-4 h-4 fill-current" /> STOP
            </button>

            {/* Upload new image */}
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 px-5 py-3 bg-white/10 hover:bg-white/20 border border-white/20 text-white/80 hover:text-white rounded-2xl backdrop-blur-xl font-bold text-sm transition-all shadow-xl"
            >
              <Upload className="w-4 h-4" /> NEW IMAGE
            </button>

            {/* Record */}
            <button
              onClick={handleRecord}
              className={`flex items-center gap-2 px-5 py-3 border rounded-2xl backdrop-blur-xl font-bold text-sm transition-all shadow-xl ${
                recording
                  ? 'bg-red-500/20 border-red-500/50 text-red-400 animate-pulse'
                  : 'bg-white/10 hover:bg-white/20 border-white/20 text-white/80 hover:text-white'
              }`}
            >
              {recording
                ? <><StopCircle className="w-4 h-4" /> STOP REC</>
                : <><Video className="w-4 h-4" /> RECORD</>}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
