export interface FaceParams {
  detected: boolean;
  // Head pose
  roll: number;   // tilt radians, + = right lean
  yaw: number;    // turn, -1 = left, +1 = right
  pitch: number;  // nod, -1 = up, +1 = down
  // Position offset in frame (normalized -1 to 1)
  tx: number;
  ty: number;
  // Facial features 0–1
  mouthOpen: number;
  smile: number;
  leftEyeOpen: number;
  rightEyeOpen: number;
  eyebrowRaise: number;
}

export interface RefFaceData {
  image: HTMLImageElement;
  /** 68-point landmarks in ref image pixel coords, or null if not found */
  landmarks: Array<{ x: number; y: number }> | null;
}

export const DEFAULT_PARAMS: FaceParams = {
  detected: false,
  roll: 0, yaw: 0, pitch: 0,
  tx: 0, ty: 0,
  mouthOpen: 0, smile: 0,
  leftEyeOpen: 1, rightEyeOpen: 1,
  eyebrowRaise: 0,
};
