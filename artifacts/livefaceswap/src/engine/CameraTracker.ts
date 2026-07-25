/**
 * CameraTracker — manages the hidden camera video element.
 * The video element is appended to document.body off-screen so that
 * mobile Safari actually decodes frames (sub-pixel elements are skipped).
 */
export class CameraTracker {
  readonly videoEl: HTMLVideoElement;
  private stream: MediaStream | null = null;

  constructor() {
    const vid = document.createElement('video');
    vid.autoplay = true;
    vid.playsInline = true;
    vid.muted = true;
    Object.assign(vid.style, {
      position: 'fixed',
      top: '-9999px',
      left: '-9999px',
      width: '640px',
      height: '480px',
      pointerEvents: 'none',
      opacity: '0',
    });
    document.body.appendChild(vid);
    this.videoEl = vid;
  }

  async start(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user' },
      audio: false,
    });
    this.stream = stream;
    this.videoEl.srcObject = stream;

    await new Promise<void>((resolve) => {
      if (this.videoEl.readyState >= 1) { resolve(); return; }
      const onMeta = () => {
        this.videoEl.removeEventListener('loadedmetadata', onMeta);
        resolve();
      };
      this.videoEl.addEventListener('loadedmetadata', onMeta);
      setTimeout(resolve, 3000); // safety valve
    });

    try { await this.videoEl.play(); } catch { /* autoplay attr handles it */ }
  }

  stop(): void {
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.videoEl.srcObject = null;
  }

  get isActive(): boolean {
    return this.stream !== null;
  }

  destroy(): void {
    this.stop();
    this.videoEl.remove();
  }
}
