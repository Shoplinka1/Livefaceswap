import { useRef, useState, useEffect } from 'react';
import { ScanFace, CameraOff } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useCamera } from '@/hooks/useCamera';
import { useFaceDetection } from '@/hooks/useFaceDetection';
import { useRecorder } from '@/hooks/useRecorder';
import { FaceCanvas } from '@/components/FaceCanvas';
import { ControlPanel } from '@/components/ControlPanel';
import { OnboardingTips } from '@/components/OnboardingTips';

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [refImageURL, setRefImageURL] = useState<string | null>(null);
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
    setReferenceImage,
    startLoop,
    stopLoop
  } = useFaceDetection();

  const { isRecording, startRecording, stopRecording } = useRecorder(canvasRef.current);

  const handleRefUpload = async (file: File) => {
    const url = URL.createObjectURL(file);
    setRefImageURL(url);
    const img = new Image();
    img.src = url;
    img.onload = () => setReferenceImage(img);
  };

  const handleStart = async () => {
    await startCamera();
    setTimeout(() => {
      if (videoRef.current && canvasRef.current) {
        startLoop(videoRef.current, canvasRef.current, (detected) => {
          // The faceDetected state is updated within startLoop callback
        });
      }
    }, 500);
  };

  const handleStop = () => {
    stopLoop();
    stopCamera();
    if (isRecording) stopRecording();
  };

  // Toast for no face detected when running
  useEffect(() => {
    let timeoutId: NodeJS.Timeout;
    if (isRunning && !faceDetected) {
      timeoutId = setTimeout(() => {
        toast({
          title: "No face detected",
          description: "Make sure your face is in frame and well-lit.",
          variant: "destructive",
          duration: 3000,
        });
      }, 3000);
    }
    return () => clearTimeout(timeoutId);
  }, [isRunning, faceDetected, toast]);

  // Initial check for navigator.mediaDevices
  useEffect(() => {
    if (!navigator.mediaDevices) {
      toast({
        title: "Camera not supported",
        description: "Your browser does not support camera access. Try Chrome or Safari.",
        variant: "destructive",
        duration: 10000,
      });
    }
  }, [toast]);

  // Show load error as a toast once
  useEffect(() => {
    if (loadError) {
      toast({
        title: "Preview limitation",
        description: loadError,
        duration: 8000,
      });
    }
  }, [loadError, toast]);

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
        
        {isRunning && (
          <div className={`px-3 py-1.5 rounded-full backdrop-blur-md border text-xs font-bold tracking-wider transition-all duration-300 pointer-events-auto shadow-lg ${
            faceDetected 
              ? 'bg-green-500/10 border-green-500/30 text-green-400 shadow-[0_0_15px_rgba(34,197,94,0.2)]' 
              : 'bg-amber-500/10 border-amber-500/30 text-amber-400 shadow-[0_0_15px_rgba(245,158,11,0.2)]'
          }`}>
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${faceDetected ? 'bg-green-400' : 'bg-amber-400 animate-pulse'}`} />
              {faceDetected ? 'FACE DETECTED' : 'NO FACE'}
            </div>
          </div>
        )}
      </header>

      {/* Main Viewport */}
      <main className="flex-1 relative flex items-center justify-center p-4 pt-20 pb-[200px] md:pb-32 h-full w-full">
        <div className={`relative w-full max-w-2xl aspect-[3/4] md:aspect-video rounded-3xl overflow-hidden bg-black shadow-2xl transition-all duration-700 ease-out border ${
          isRunning 
            ? faceDetected 
              ? 'border-primary/50 shadow-[0_0_50px_rgba(124,58,237,0.15)]' 
              : 'border-amber-500/30 shadow-[0_0_30px_rgba(245,158,11,0.1)]'
            : 'border-white/5'
        }`}>
          {/* Scanning line animation when starting/running without face */}
          {isRunning && !faceDetected && (
            <div className="absolute inset-0 pointer-events-none z-10 overflow-hidden">
              <div className="w-full h-1 bg-primary/50 shadow-[0_0_20px_rgba(124,58,237,1)] absolute animate-[scan_2s_ease-in-out_infinite]" />
            </div>
          )}
          
          <FaceCanvas
            ref={canvasRef}
            videoRef={videoRef}
            isActive={isActive}
            className="w-full h-full object-cover transition-opacity duration-500"
          />

          {!isRunning && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 backdrop-blur-sm gap-4 p-6 text-center animate-in fade-in duration-700">
              <div className="w-20 h-20 rounded-full bg-white/5 border border-white/10 flex items-center justify-center mb-2 relative group">
                <div className="absolute inset-0 rounded-full bg-primary/20 blur-xl opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
                <CameraOff className="w-8 h-8 text-white/50" />
              </div>
              <h2 className="text-2xl font-bold tracking-tight text-white/90">Camera Inactive</h2>
              <p className="text-muted-foreground max-w-xs text-sm">
                Upload a reference image and hit Start to see the magic mirror in action.
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
