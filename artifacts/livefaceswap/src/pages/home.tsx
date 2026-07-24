import { useRef, useState, useEffect, useCallback } from 'react';
import { ScanFace, CameraOff, Square, Upload, Video, StopCircle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useCamera } from '@/hooks/useCamera';
import { useFaceDetection } from '@/hooks/useFaceDetection';
import { useRecorder } from '@/hooks/useRecorder';
import { FaceCanvas } from '@/components/FaceCanvas';
import { ControlPanel } from '@/components/ControlPanel';
import { OnboardingTips } from '@/components/OnboardingTips';

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [refImageURL, setRefImageURL] = useState<string | null>(null);
  const [showControls, setShowControls] = useState(true);
  const hideTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { toast } = useToast();

  const { videoRef, isActive, error: cameraError, startCamera, stopCamera } = useCamera();
  const {
    modelsLoaded,
    loadingProgress,
    loadError,
    isRunning,
    faceDetected,
    intensity,
    setIntensity,
    refFaceStatus,
    setReferenceImage,
    startLoop,
    stopLoop
  } = useFaceDetection();

  const { isRecording, startRecording, stopRecording } = useRecorder(canvasRef.current);

  // Auto-hide floating controls after 3 s of no interaction
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

  const handleRefUpload = useCallback(async (file: File) => {
    const url = URL.createObjectURL(file);
    setRefImageURL(url);
    const img = new Image();
    img.src = url;
    img.onload = () => setReferenceImage(img);
  }, [setReferenceImage]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      handleRefUpload(e.target.files[0]);
      e.target.value = '';
    }
  };

  const handleStart = async () => {
    await startCamera();
    setTimeout(() => {
      if (videoRef.current && canvasRef.current) {
        startLoop(videoRef.current, canvasRef.current, () => {});
      }
    }, 500);
  };

  const handleStop = () => {
    stopLoop();
    stopCamera();
    if (isRecording) stopRecording();
  };

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout>;
    if (isRunning && !faceDetected) {
      timeoutId = setTimeout(() => {
        toast({
          title: 'No face detected',
          description: 'Make sure your face is in frame and well-lit.',
          variant: 'destructive',
          duration: 3000,
        });
      }, 4000);
    }
    return () => clearTimeout(timeoutId);
  }, [isRunning, faceDetected, toast]);

  useEffect(() => {
    if (!navigator.mediaDevices) {
      toast({
        title: 'Camera not supported',
        description: 'Your browser does not support camera access. Try Chrome or Safari.',
        variant: 'destructive',
        duration: 10000,
      });
    }
  }, [toast]);

  useEffect(() => {
    if (loadError) {
      toast({
        title: 'Preview limitation',
        description: loadError,
        duration: 8000,
      });
    }
  }, [loadError, toast]);

  // ── ACTIVE SWAP: fullscreen canvas + floating controls ────────────────────
  if (isRunning) {
    return (
      <div
        className="fixed inset-0 bg-black overflow-hidden"
        onPointerDown={resetHideTimer}
        onPointerMove={resetHideTimer}
      >
        {/* Full-screen canvas */}
        <FaceCanvas
          ref={canvasRef}
          videoRef={videoRef}
          isActive={isActive}
          className="w-full h-full object-cover"
        />

        {/* Hidden file input for "Upload New" */}
        <input
          type="file"
          accept="image/*"
          className="hidden"
          ref={fileInputRef}
          onChange={handleFileChange}
        />

        {/* Floating top-right: face-detected indicator */}
        <div
          className={`absolute top-4 right-4 transition-opacity duration-500 ${showControls ? 'opacity-100' : 'opacity-0'}`}
        >
          <div className={`px-3 py-1.5 rounded-full backdrop-blur-md border text-xs font-bold tracking-wider shadow-lg ${
            faceDetected
              ? 'bg-green-500/10 border-green-500/40 text-green-400'
              : 'bg-amber-500/10 border-amber-500/40 text-amber-400'
          }`}>
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${faceDetected ? 'bg-green-400' : 'bg-amber-400 animate-pulse'}`} />
              {faceDetected ? 'LIVE' : 'NO FACE'}
            </div>
          </div>
        </div>

        {/* Floating bottom bar */}
        <div
          className={`absolute bottom-0 left-0 right-0 pb-8 px-6 flex flex-col items-center gap-4 transition-all duration-500 ${
            showControls ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8 pointer-events-none'
          }`}
        >
          {/* Intensity slider */}
          <div className="w-full max-w-xs bg-black/50 backdrop-blur-xl border border-white/10 rounded-2xl px-5 py-3 flex flex-col gap-2">
            <div className="flex justify-between items-center">
              <span className="text-xs font-semibold text-white/60 uppercase tracking-wider">Blend</span>
              <span className="text-xs font-bold text-white/90 font-mono">{Math.round(intensity * 100)}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={intensity}
              onChange={e => setIntensity(parseFloat(e.target.value))}
              className="w-full accent-violet-500 h-1.5 rounded-full"
            />
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-3">
            {/* Stop */}
            <button
              onClick={handleStop}
              className="flex items-center gap-2 px-5 py-3 bg-red-500/20 hover:bg-red-500 border border-red-500/50 text-red-400 hover:text-white rounded-2xl backdrop-blur-xl font-bold text-sm transition-all"
            >
              <Square className="w-4 h-4 fill-current" />
              STOP
            </button>

            {/* Upload new face */}
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 px-5 py-3 bg-white/10 hover:bg-white/20 border border-white/20 text-white/80 hover:text-white rounded-2xl backdrop-blur-xl font-bold text-sm transition-all"
            >
              <Upload className="w-4 h-4" />
              NEW FACE
            </button>

            {/* Record */}
            <button
              onClick={isRecording ? stopRecording : startRecording}
              className={`flex items-center gap-2 px-5 py-3 border rounded-2xl backdrop-blur-xl font-bold text-sm transition-all ${
                isRecording
                  ? 'bg-red-500/20 border-red-500/50 text-red-400 animate-pulse'
                  : 'bg-white/10 hover:bg-white/20 border-white/20 text-white/80 hover:text-white'
              }`}
            >
              {isRecording
                ? <><StopCircle className="w-4 h-4" />REC</>
                : <><Video className="w-4 h-4" />RECORD</>
              }
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── IDLE: standard layout with control panel ──────────────────────────────
  return (
    <div className="min-h-[100dvh] w-full flex flex-col bg-background overflow-hidden relative font-sans text-foreground">
      <OnboardingTips />

      {/* Top Bar */}
      <header className="absolute top-0 left-0 right-0 z-20 p-4 md:p-6 flex justify-between items-center bg-gradient-to-b from-black/80 to-transparent pointer-events-none">
        <div className="flex items-center gap-2 pointer-events-auto">
          <div className="w-8 h-8 rounded-lg bg-primary/20 border border-primary/30 flex items-center justify-center backdrop-blur-md shadow-[0_0_15px_rgba(124,58,237,0.3)]">
            <ScanFace className="w-5 h-5 text-primary" />
          </div>
          <h1 className="text-xl font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white to-white/70">
            LiveFaceSwap
          </h1>
        </div>
      </header>

      {/* Main Viewport */}
      <main className="flex-1 relative flex items-center justify-center p-4 pt-20 pb-[200px] md:pb-32 h-full w-full">
        <div className="relative w-full max-w-2xl aspect-[3/4] md:aspect-video rounded-3xl overflow-hidden bg-black shadow-2xl border border-white/5">
          {/* No canvas needed while idle — just the placeholder */}
          <FaceCanvas
            ref={canvasRef}
            videoRef={videoRef}
            isActive={isActive}
            className="w-full h-full object-cover transition-opacity duration-500"
          />

          {!isActive && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 backdrop-blur-sm gap-4 p-6 text-center animate-in fade-in duration-700">
              <div className="w-20 h-20 rounded-full bg-white/5 border border-white/10 flex items-center justify-center mb-2">
                <CameraOff className="w-8 h-8 text-white/50" />
              </div>
              <h2 className="text-2xl font-bold tracking-tight text-white/90">Camera Inactive</h2>
              <p className="text-muted-foreground max-w-xs text-sm">
                Upload a reference face image and tap Start to begin.
              </p>
            </div>
          )}
        </div>
      </main>

      {/* Control Panel Footer */}
      <div className="absolute bottom-0 left-0 right-0 z-20">
        <div className="max-w-2xl mx-auto md:mb-6">
          <ControlPanel
            modelsLoaded={modelsLoaded}
            loadingProgress={loadingProgress}
            isRunning={isRunning}
            isRecording={isRecording}
            intensity={intensity}
            referenceImageURL={refImageURL}
            refFaceStatus={refFaceStatus}
            onUploadRef={handleRefUpload}
            onStart={handleStart}
            onStop={handleStop}
            onSetIntensity={setIntensity}
            onStartRecording={startRecording}
            onStopRecording={stopRecording}
            cameraError={cameraError}
          />
        </div>
      </div>
    </div>
  );
}
