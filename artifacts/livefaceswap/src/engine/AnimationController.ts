/**
 * AnimationController — owns the RAF render loop and wires together
 * CameraTracker → FaceTracker → AvatarRenderer.
 *
 * The render loop is completely independent of React — it never re-creates
 * closures or re-subscribes handlers per frame.
 */
import { CameraTracker } from './CameraTracker';
import { FaceTracker, type TrackerStatus } from './FaceTracker';
import { AvatarRenderer } from './AvatarRenderer';
import type { FaceParams, RefFaceData } from './types';
import { DEFAULT_PARAMS } from './types';

export type ControllerStatus = 'idle' | 'loading' | 'starting' | 'running' | 'stopped' | 'error';

export class AnimationController {
  private camera:   CameraTracker;
  private tracker:  FaceTracker;
  private renderer: AvatarRenderer;
  private rafId:    number | null = null;
  private _status:  ControllerStatus = 'idle';
  private _params:  FaceParams = { ...DEFAULT_PARAMS };

  // Callbacks for React to subscribe to state changes
  onStatus:   ((s: ControllerStatus) => void) | null = null;
  onParams:   ((p: FaceParams)       => void) | null = null;
  onProgress: ((pct: number)         => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.camera   = new CameraTracker();
    this.tracker  = new FaceTracker();
    this.renderer = new AvatarRenderer(canvas);

    // Wire tracker callbacks
    this.tracker.onParams   = (p) => { this._params = p; this.onParams?.(p); };
    this.tracker.onStatus   = (s: TrackerStatus) => {
      if (s === 'error') this.setStatus('error');
    };
    this.tracker.onProgress = (pct) => this.onProgress?.(pct);
  }

  get status()       { return this._status; }
  get currentParams(){ return this._params; }
  get canvas()       { return this.renderer.canvas; }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Load AI models (call once on app mount). */
  async loadModels(): Promise<void> {
    this.setStatus('loading');
    await this.tracker.loadModels();
    if (this._status !== 'error') this.setStatus('idle');
  }

  /** Start camera, tracking, and render loop. */
  async start(): Promise<void> {
    if (this._status === 'running') return;
    this.setStatus('starting');

    try {
      await this.camera.start();
    } catch (err: any) {
      console.error('[AnimationController] camera start failed:', err);
      this.setStatus('error');
      throw err;
    }

    // Short delay to let the first frames arrive
    await new Promise(r => setTimeout(r, 250));

    this.tracker.startTracking(this.camera.videoEl);
    this.startRenderLoop();
    this.setStatus('running');
  }

  /** Stop everything. */
  stop(): void {
    this.stopRenderLoop();
    this.tracker.stopTracking();
    this.camera.stop();
    this._params = { ...DEFAULT_PARAMS };
    this.setStatus('stopped');
  }

  /** Destroy: cleans up the hidden video element from DOM. */
  destroy(): void {
    this.stop();
    this.camera.destroy();
  }

  // ── Reference image ───────────────────────────────────────────────────────

  setRefFace(data: RefFaceData | null): void {
    this.renderer.setRefFace(data);
  }

  async detectRefLandmarks(img: HTMLImageElement) {
    return this.renderer.detectRefLandmarks(img);
  }

  // ── Recording ─────────────────────────────────────────────────────────────

  /** Returns a capturable stream of the output canvas at 30 fps. */
  captureStream(): MediaStream {
    return (this.renderer.canvas as any).captureStream(30) as MediaStream;
  }

  // ── RAF loop ──────────────────────────────────────────────────────────────

  private startRenderLoop(): void {
    const loop = () => {
      this.renderer.render(this._params);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private stopRenderLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private setStatus(s: ControllerStatus): void {
    this._status = s;
    this.onStatus?.(s);
  }
}
