import { useRef, useState, useEffect, useCallback } from 'react';
import {
  ScanFace, CameraOff, Square, Upload, Video,
  StopCircle, Loader2, CheckCircle2, AlertCircle, Sparkles
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useCamera } from '@/hooks/useCamera';
import { useFaceDetection } from '@/hooks/useFaceDetection';
import { useRecorder } from '@/hooks/useRecorder';
import { FaceCanvas } from '@/components/FaceCanvas';

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const runningFileInputRef = useRef<HTMLInputElement>(null);
  const [refImageURL, setRefImageURL] = useState<string | null>(null);
  const [showControls, setShowControls] = useState(true);
  const hideTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { toast } = useToast();

  const { videoRef, isActive, error: cameraError, startCamera, stopCamera } = useCamera();
  const {
    modelsLoaded,
    loadingProgress,
    isRunning,
    faceDetected,
    intensity,
    setIntensity,
    refFaceStatus,
    setReferenceImage,
    startLoop,
    stopLoop,
  } = useFaceDetection();

  const { isRecording, startRecording, stopRecording } = useRecorder(canvasRef.current);

  // Auto-hide controls after 3.5 s of inactivity while swap is running
  const resetHideTimer = useCallback(() => {
    setShowControls(true);
    if (hideTimeout.current) clearTimeout(hideTimeout.current);
    hideTimeout.current = setTimeout(() => setShowControls(false), 3500);
  }, []);

  useEffect(() => {
    if (isRunning) {
      resetHideTimer();
    } else {
      if (hideTimeout.current) clearTimeout(hideTimeout.current);
      setShowControls(true);
    }
    return () => { if (hideTimeout.current) clearTimeout(hideTimeout.current); };
  }, [isRunning, resetHideTimer]);

  // Launch camera + render loop
  const launchSwap = useCallback(async () => {
    if (isRunning) return;
    await startCamera();
    // Give the video element a brief moment to start delivering frames
    // after startCamera resolves (loadedmetadata is already awaited inside)
    await new Promise(r => setTimeout(r, 200));
    if (videoRef.current && canvasRef.current) {
      startLoop(videoRef.current, canvasRef.current, () => {});
    }
  }, [isRunning, startCamera, startLoop, videoRef]);

  // Process an uploaded reference image, then auto-launch if not yet running
  const handleRefUpload = useCallback(async (file: File) => {
    const url = URL.createObjectURL(file);
    setRefImageURL(url);

    const img = new Image();
    img.src = url;
    await new Promise<void>(resolve => { img.onload = () => resolve(); });
    setReferenceImage(img);

    if (modelsLoaded && !isRunning) {
      await launchSwap();
    }
  }, [setReferenceImage, modelsLoaded, isRunning, launchSwap]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) {
      handleRefUpload(e.target.files[0]);
      e.target.value = '';
    }
  };

  const handleStop = () => {
    stopLoop();
    stopCamera();
    if (isRecording) stopRecording();
  };

  // Toast: no face after 5 s
  useEffect(() => {
    if (!isRunning || faceDetected) return;
    const id = setTimeout(() => {
      toast({
        title: 'No face detected',
        description: 'Make sure your face is well-lit and centred in frame.',
        variant: 'destructive',
        duration: 3000,
      });
    }, 5000);
    return () => clearTimeout(id);
  }, [isRunning, faceDetected, toast]);

  // Toast: camera error
  useEffect(() => {
    if (cameraError) {
      toast({ title: 'Camera error', description: cameraError, variant: 'destructive', duration: 8000 });
    }
  }, [cameraError, toast]);

  // ── ACTIVE SWAP ────────────────────────────────────────────────────────────
  if (isRunning) {
    return (
      <div
        className="fixed inset-0 bg-black overflow-hidden"
        onPointerDown={resetHideTimer}
        onPointerMove={resetHideTimer}
      >
        {/* Full-screen output canvas */}
        <FaceCanvas
          ref={canvasRef}
          videoRef={videoRef}
          isActive={isActive}
          className="absolute inset-0 w-full h-full object-cover"
        />

        {/* File input for swapping the reference mid-session */}
        <input
          type="file"
          accept="image/*"
          className="hidden"
          ref={runningFileInputRef}
          onChange={handleFileChange}
        />

        {/* Status indicator — top right */}
        <div className={`absolute top-4 right-4 transition-opacity duration-500 ${showControls ? 'opacity-100' : 'opacity-0'}`}>
          <div className={`px-3 py-1.5 rounded-full backdrop-blur-md border text-xs font-bold tracking-wider shadow-lg ${
            faceDetected
              ? 'bg-green-500/10 border-green-500/40 text-green-400'
              : 'bg-amber-500/10 border-amber-500/40 text-amber-400'
          }`}>
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${faceDetected ? 'bg-green-400' : 'bg-amber-400 animate-pulse'}`} />
              {faceDetected ? 'LIVE' : 'SEARCHING…'}
            </div>
          </div>
        </div>

        {/* Blend slider — top left */}
        <div className={`absolute top-4 left-4 transition-opacity duration-500 ${showControls ? 'opacity-100' : 'opacity-0'}`}>
          <div className="bg-black/50 backdrop-blur-xl border border-white/10 rounded-2xl px-4 py-2 flex items-center gap-3 w-44">
            <span className="text-xs text-white/50 shrink-0">Blend</span>
            <input
              type="range" min={0} max={1} step={0.01} value={intensity}
              onChange={e => setIntensity(parseFloat(e.target.value))}
              className="flex-1 accent-violet-500 h-1 rounded-full"
            />
            <span className="text-xs text-white/70 font-mono w-7 text-right">{Math.round(intensity * 100)}%</span>
          </div>
        </div>

        {/* Floating bottom buttons */}
        <div className={`absolute bottom-0 left-0 right-0 pb-10 px-6 flex justify-center gap-3 transition-all duration-500 ${
          showControls ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8 pointer-events-none'
        }`}>
          <button
            onClick={handleStop}
            className="flex items-center gap-2 px-5 py-3 bg-red-500/20 hover:bg-red-500 border border-red-500/50 text-red-400 hover:text-white rounded-2xl backdrop-blur-xl font-bold text-sm transition-all shadow-lg"
          >
            <Square className="w-4 h-4 fill-current" /> STOP
          </button>

          <button
            onClick={() => runningFileInputRef.current?.click()}
            className="flex items-center gap-2 px-5 py-3 bg-white/10 hover:bg-white/20 border border-white/20 text-white/80 hover:text-white rounded-2xl backdrop-blur-xl font-bold text-sm transition-all shadow-lg"
          >
            <Upload className="w-4 h-4" /> NEW FACE
          </button>

          <button
            onClick={isRecording ? stopRecording : startRecording}
            className={`flex items-center gap-2 px-5 py-3 border rounded-2xl backdrop-blur-xl font-bold text-sm transition-all shadow-lg ${
              isRecording
                ? 'bg-red-500/20 border-red-500/50 text-red-400 animate-pulse'
                : 'bg-white/10 hover:bg-white/20 border-white/20 text-white/80 hover:text-white'
            }`}
          >
            {isRecording
              ? <><StopCircle className="w-4 h-4" /> REC</>
              : <><Video className="w-4 h-4" /> RECORD</>}
          </button>
        </div>
      </div>
    );
  }

  // ── IDLE / UPLOAD SCREEN ──────────────────────────────────────────────────
  return (
    <div className="min-h-[100dvh] w-full flex flex-col items-center justify-center bg-background p-6 gap-8 font-sans text-foreground">

      {/* FaceCanvas is kept in DOM so videoRef is always valid */}
      <FaceCanvas
        ref={canvasRef}
        videoRef={videoRef}
        isActive={isActive}
        className="hidden"
      />

      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-primary/20 border border-primary/30 flex items-center justify-center shadow-[0_0_20px_rgba(124,58,237,0.3)]">
          <ScanFace className="w-6 h-6 text-primary" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white to-white/60">
          LiveFaceSwap
        </h1>
      </div>

      <div className="w-full max-w-sm flex flex-col gap-4">

        {/* AI model loading bar */}
        {!modelsLoaded && (
          <div className="bg-black/30 border border-white/10 rounded-2xl p-5 flex flex-col gap-3">
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin text-primary" />
                Loading AI models…
              </span>
              <span className="font-mono">{loadingProgress}%</span>
            </div>
            <div className="w-full h-1.5 bg-white/5 rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-300"
                style={{ width: `${loadingProgress}%` }}
              />
            </div>
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
          className="w-full h-52 border-2 border-dashed border-white/20 rounded-3xl flex items-center justify-center bg-black/20 hover:bg-black/40 hover:border-primary/50 transition-all group overflow-hidden relative"
        >
          {refImageURL ? (
            <>
              <img src={refImageURL} alt="Reference" className="absolute inset-0 w-full h-full object-cover" />
              <div className="absolute inset-0 bg-black/50" />
              <div className="relative z-10 flex flex-col items-center gap-2">
                {refFaceStatus === 'detecting' && (
                  <><Loader2 className="w-7 h-7 animate-spin text-white" /><span className="text-sm font-semibold text-white drop-shadow">Scanning face…</span></>
                )}
                {refFaceStatus === 'ready' && (
                  <><CheckCircle2 className="w-8 h-8 text-green-400" /><span className="text-sm font-semibold text-green-300">Face ready — tap to change</span></>
                )}
                {refFaceStatus === 'not_found' && (
                  <><AlertCircle className="w-8 h-8 text-amber-400" /><span className="text-sm font-semibold text-amber-300 text-center px-4">No face found — try a clearer photo</span></>
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center gap-3">
              <div className="w-16 h-16 rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center group-hover:bg-primary/20 transition-colors">
                <Upload className="w-7 h-7 text-primary" />
              </div>
              <div className="text-center">
                <p className="text-base font-semibold text-white/80 group-hover:text-white">Upload a face photo</p>
                <p className="text-sm text-white/40 mt-1">Clear front-facing photo works best</p>
              </div>
            </div>
          )}
        </button>

        {/* Manual start fallback (auto-launch handles it on upload, but show if needed) */}
        {refImageURL && refFaceStatus !== 'detecting' && modelsLoaded && !isRunning && (
          <button
            onClick={launchSwap}
            className="w-full h-14 rounded-2xl flex items-center justify-center gap-2 bg-primary/20 text-primary border border-primary/30 hover:bg-primary hover:text-primary-foreground transition-all font-bold text-base shadow-[0_0_15px_rgba(124,58,237,0.15)] hover:shadow-[0_0_30px_rgba(124,58,237,0.4)]"
          >
            <Sparkles className="w-5 h-5" />
            START SWAP
          </button>
        )}

        {!refImageURL && (
          <div className="flex items-center justify-center gap-2 text-white/30 text-sm">
            <CameraOff className="w-4 h-4" />
            Camera starts automatically on upload
          </div>
        )}
      </div>
    </div>
  );
}
