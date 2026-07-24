import { useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Progress } from '@/components/ui/progress';
import { Upload, Play, Square, Video, ShieldAlert, Sparkles, Loader2 } from 'lucide-react';

interface ControlPanelProps {
  modelsLoaded: boolean;
  loadingProgress: number;
  isRunning: boolean;
  isRecording: boolean;
  intensity: number;
  referenceImageURL: string | null;
  onUploadRef: (file: File) => void;
  onStart: () => void;
  onStop: () => void;
  onSetIntensity: (v: number) => void;
  onStartRecording: () => void;
  onStopRecording: () => void;
  cameraError: string | null;
}

export function ControlPanel({
  modelsLoaded,
  loadingProgress,
  isRunning,
  isRecording,
  intensity,
  referenceImageURL,
  onUploadRef,
  onStart,
  onStop,
  onSetIntensity,
  onStartRecording,
  onStopRecording,
  cameraError
}: ControlPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onUploadRef(e.target.files[0]);
    }
  };

  return (
    <div className="w-full bg-card/50 backdrop-blur-xl border-t border-white/10 p-4 pb-6 md:pb-4 flex flex-col gap-4 shadow-2xl rounded-t-3xl">
      {cameraError && (
        <div className="bg-destructive/10 border border-destructive/30 text-destructive-foreground p-3 rounded-xl flex items-start gap-3 text-sm">
          <ShieldAlert className="w-5 h-5 shrink-0 mt-0.5 text-destructive" />
          <p>{cameraError}</p>
        </div>
      )}

      {!modelsLoaded ? (
        <div className="space-y-3 py-2">
          <div className="flex justify-between items-center text-sm font-medium text-muted-foreground">
            <span className="flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin text-primary" />
              Loading AI Models...
            </span>
            <span>{loadingProgress}%</span>
          </div>
          <Progress value={loadingProgress} className="h-2 bg-black/40" />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {!isRunning && (
            <div className="grid grid-cols-2 gap-3 items-center">
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
                className="col-span-1 h-24 border-2 border-dashed border-white/20 rounded-2xl flex flex-col items-center justify-center gap-2 bg-black/20 hover:bg-black/40 hover:border-primary/50 transition-all group overflow-hidden relative"
              >
                {referenceImageURL ? (
                  <>
                    <img src={referenceImageURL} alt="Reference" className="absolute inset-0 w-full h-full object-cover opacity-60 mix-blend-luminosity group-hover:scale-105 transition-transform duration-500" />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
                    <span className="relative z-10 text-xs font-semibold text-white/90 drop-shadow-md">Change Face</span>
                  </>
                ) : (
                  <>
                    <Upload className="w-6 h-6 text-muted-foreground group-hover:text-primary transition-colors" />
                    <span className="text-xs font-medium text-muted-foreground group-hover:text-primary-foreground">Upload Face</span>
                  </>
                )}
              </button>
              
              <Button
                size="lg"
                className="col-span-1 h-24 rounded-2xl flex flex-col items-center justify-center gap-2 bg-primary/20 text-primary border border-primary/30 hover:bg-primary hover:text-primary-foreground disabled:opacity-50 transition-all shadow-[0_0_15px_rgba(124,58,237,0.15)] hover:shadow-[0_0_30px_rgba(124,58,237,0.4)]"
                disabled={!referenceImageURL}
                onClick={onStart}
              >
                <Sparkles className="w-6 h-6" />
                <span className="font-semibold tracking-wide">START MAGIC</span>
              </Button>
            </div>
          )}

          {isRunning && (
            <div className="flex flex-col gap-5 animate-in fade-in slide-in-from-bottom-4 duration-300">
              <div className="space-y-4 bg-black/20 p-4 rounded-2xl border border-white/5">
                <div className="flex justify-between items-center">
                  <label className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Expression Strength</label>
                  <span className="text-sm font-bold text-primary font-mono">{Math.round(intensity * 100)}%</span>
                </div>
                <Slider
                  value={[intensity]}
                  min={0}
                  max={1}
                  step={0.01}
                  onValueChange={(val) => onSetIntensity(val[0])}
                  className="w-full"
                />
              </div>

              <div className="flex items-center gap-3">
                <Button
                  variant="destructive"
                  size="lg"
                  className="flex-1 h-14 rounded-xl font-bold tracking-wide"
                  onClick={onStop}
                >
                  <Square className="w-5 h-5 mr-2 fill-current" />
                  STOP
                </Button>
                <Button
                  variant={isRecording ? "destructive" : "secondary"}
                  size="lg"
                  className={`flex-1 h-14 rounded-xl font-bold tracking-wide transition-all ${
                    isRecording 
                      ? 'bg-red-500/20 text-red-500 border border-red-500/50 hover:bg-red-500 hover:text-white animate-pulse'
                      : 'bg-white/10 hover:bg-white/20'
                  }`}
                  onClick={isRecording ? onStopRecording : onStartRecording}
                >
                  <Video className={`w-5 h-5 mr-2 ${isRecording ? 'fill-current' : ''}`} />
                  {isRecording ? 'RECORDING...' : 'RECORD'}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
