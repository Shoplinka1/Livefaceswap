import { useRef, useState, useCallback } from 'react';

export function useCamera() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isActive, setIsActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const startCamera = useCallback(async () => {
    try {
      setError(null);

      // Start with minimal constraints to maximise mobile compatibility,
      // then let the browser choose resolution.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
        audio: false,
      });

      streamRef.current = stream;
      const vid = videoRef.current;
      if (!vid) return;

      vid.srcObject = stream;

      // Wait for metadata so videoWidth/videoHeight are valid before we return
      await new Promise<void>((resolve) => {
        if (vid.readyState >= 1) { resolve(); return; }
        const onMeta = () => { vid.removeEventListener('loadedmetadata', onMeta); resolve(); };
        vid.addEventListener('loadedmetadata', onMeta);
        setTimeout(resolve, 3000); // safety valve
      });

      // play() can throw on some browsers if called before metadata
      try { await vid.play(); } catch { /* autoPlay attr handles it */ }

      setIsActive(true);
    } catch (err: any) {
      const name = err?.name ?? '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setError('Camera permission denied — please allow camera access in your browser settings.');
      } else if (name === 'NotFoundError') {
        setError('No camera found on this device.');
      } else {
        setError('Could not start camera: ' + (err?.message ?? String(err)));
      }
    }
  }, []);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setIsActive(false);
  }, []);

  return { videoRef, isActive, error, startCamera, stopCamera };
}
