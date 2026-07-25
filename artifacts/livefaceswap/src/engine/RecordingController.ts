/**
 * RecordingController — records the output canvas stream and auto-downloads
 * the result as a .webm file when stopped.
 */
export class RecordingController {
  private recorder: MediaRecorder | null = null;
  private chunks:   BlobPart[] = [];
  private _recording = false;

  get isRecording() { return this._recording; }

  start(stream: MediaStream): void {
    if (this._recording) return;
    this.chunks = [];

    const opts = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? { mimeType: 'video/webm;codecs=vp9' }
      : MediaRecorder.isTypeSupported('video/webm')
      ? { mimeType: 'video/webm' }
      : {};

    const rec = new MediaRecorder(stream, opts);
    rec.ondataavailable = (e) => { if (e.data.size > 0) this.chunks.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(this.chunks, { type: rec.mimeType || 'video/webm' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `livefaceswap-${Date.now()}.webm`;
      a.click();
      URL.revokeObjectURL(url);
    };

    rec.start(100);
    this.recorder  = rec;
    this._recording = true;
  }

  stop(): void {
    this.recorder?.stop();
    this.recorder   = null;
    this._recording = false;
  }
}
