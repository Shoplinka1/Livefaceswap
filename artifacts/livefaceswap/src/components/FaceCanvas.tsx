import { forwardRef, useImperativeHandle, useRef } from 'react';

interface FaceCanvasProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  isActive: boolean;
  className?: string;
}

// The video element MUST be rendered at a real size (not 1×1) so that mobile
// browsers (especially Safari/iOS) actually decode the camera frames.
// We position it fixed off-screen so it never appears in the UI.

export const FaceCanvas = forwardRef<HTMLCanvasElement, FaceCanvasProps>(
  ({ videoRef, className }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    useImperativeHandle(ref, () => canvasRef.current!);

    return (
      <>
        {/* Off-screen video — real dimensions so mobile decodes frames */}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          style={{
            position: 'fixed',
            top: '-9999px',
            left: '-9999px',
            width: '640px',
            height: '480px',
            pointerEvents: 'none',
          }}
        />
        <canvas
          ref={canvasRef}
          className={className}
        />
      </>
    );
  }
);
FaceCanvas.displayName = 'FaceCanvas';
