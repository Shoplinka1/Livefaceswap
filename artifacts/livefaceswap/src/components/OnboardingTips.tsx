import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Sparkles, Camera, Upload, SlidersHorizontal } from 'lucide-react';

export function OnboardingTips() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onboarded = localStorage.getItem('lfs_onboarded');
    if (!onboarded) {
      setOpen(true);
    }
  }, []);

  const handleDismiss = () => {
    localStorage.setItem('lfs_onboarded', 'true');
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md bg-card/95 backdrop-blur-xl border-white/10 shadow-2xl rounded-3xl p-6 [&>button]:hidden">
        <DialogHeader className="text-left mb-4">
          <div className="w-12 h-12 rounded-2xl bg-primary/20 flex items-center justify-center mb-4">
            <Sparkles className="w-6 h-6 text-primary" />
          </div>
          <DialogTitle className="text-2xl font-bold tracking-tight">Welcome to LiveFaceSwap</DialogTitle>
          <DialogDescription className="text-muted-foreground text-base">
            Real-time face magic right in your browser. Here's how it works:
          </DialogDescription>
        </DialogHeader>
        
        <div className="space-y-6 py-2">
          <div className="flex gap-4">
            <div className="w-10 h-10 rounded-full bg-black/40 flex items-center justify-center shrink-0 border border-white/5">
              <Upload className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h4 className="font-semibold text-foreground">Upload a reference</h4>
              <p className="text-sm text-muted-foreground">Pick a clear, front-facing photo of someone's face.</p>
            </div>
          </div>
          
          <div className="flex gap-4">
            <div className="w-10 h-10 rounded-full bg-black/40 flex items-center justify-center shrink-0 border border-white/5">
              <Camera className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h4 className="font-semibold text-foreground">Allow camera</h4>
              <p className="text-sm text-muted-foreground">We need access to your front camera for real-time tracking.</p>
            </div>
          </div>
          
          <div className="flex gap-4">
            <div className="w-10 h-10 rounded-full bg-black/40 flex items-center justify-center shrink-0 border border-white/5">
              <SlidersHorizontal className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h4 className="font-semibold text-foreground">Tune & Record</h4>
              <p className="text-sm text-muted-foreground">Adjust the expression strength and record videos instantly.</p>
            </div>
          </div>
        </div>

        <DialogFooter className="mt-6 sm:justify-start">
          <Button onClick={handleDismiss} size="lg" className="w-full h-14 text-base font-bold rounded-xl shadow-[0_0_20px_rgba(124,58,237,0.3)] hover:shadow-[0_0_40px_rgba(124,58,237,0.5)] transition-all">
            GOT IT, LET'S GO!
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
