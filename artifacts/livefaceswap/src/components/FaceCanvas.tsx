import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react';

interface FaceCanvasProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  isActive: boolean;
  className?: string;
}

export const FaceCanvas = forwardRef<HTMLCanvasElement, FaceCanvasProps>(
  ({ videoRef, isActive, className }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    useImperativeHandle(ref, () => canvasRef.current!);

    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas || !isActive) return;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        canvas.width = 640;
        canvas.height = 480;
      }
    }, [isActive]);

    return (
      <>
        {/* Hidden video element */}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          style={{ position: 'absolute', opacity: 0, pointerEvents: 'none', width: 1, height: 1 }}
        />
        <canvas
          ref={canvasRef}
          className={className}
          style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 'inherit' }}
        />
      </>
    );
  }
);
FaceCanvas.displayName = 'FaceCanvas';
