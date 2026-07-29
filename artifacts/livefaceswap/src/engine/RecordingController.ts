/**
 * RecordingController — records the output canvas stream and auto-downloads
 * the result when stopped.
 *
 * Format priority (first supported wins):
 *   1. video/mp4;codecs=avc1  — Safari 14.1+ / iOS 14.5+ / macOS
 *   2. video/mp4              — Safari / older Apple platforms
 *   3. video/webm;codecs=vp9  — Chrome / Firefox (best quality)
 *   4. video/webm             — Chrome / Firefox fallback
 *   5. ''                     — browser default
 *
 * The download filename extension always matches the actual container format
 * (.mp4 for Apple devices, .webm everywhere else).
 */
export class RecordingController {
  private recorder:   MediaRecorder | null = null;
  private chunks:     BlobPart[] = [];
  private _recording = false;

  get isRecording() { return this._recording; }

  // ── Format selection ───────────────────────────────────────────────────────

  private static chooseMime(): string {
    const candidates = [
      'video/mp4;codecs=avc1',
      'video/mp4',
      'video/webm;codecs=vp9',
      'video/webm',
    ];
    for (const m of candidates) {
      try {
        if (MediaRecorder.isTypeSupported(m)) return m;
      } catch { /* ignore */ }
    }
    return '';
  }

  private static ext(mime: string): string {
    return mime.startsWith('video/mp4') ? 'mp4' : 'webm';
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  start(stream: MediaStream): void {
    if (this._recording) return;
    this.chunks = [];

    const mime = RecordingController.chooseMime();
    const opts = mime ? { mimeType: mime } : {};
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, opts);
    } catch {
      // Some browsers reject the mime even after isTypeSupported returns true
      rec = new MediaRecorder(stream);
    }

    const activeMime = rec.mimeType || mime || 'video/webm';

    rec.ondataavailable = (e) => { if (e.data.size > 0) this.chunks.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(this.chunks, { type: activeMime });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `livefaceswap-${Date.now()}.${RecordingController.ext(activeMime)}`;
      a.click();
      URL.revokeObjectURL(url);
    };

    rec.start(100);
    this.recorder   = rec;
    this._recording = true;
  }

  stop(): void {
    if (this.recorder?.state === 'recording') this.recorder.stop();
    this.recorder   = null;
    this._recording = false;
  }
}
