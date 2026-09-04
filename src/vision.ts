import type { CameraInfoMessage, Detection2DMessage, RosTime } from './types';

export const VISION_CAMERA = {
  width: 320,
  height: 240,
  depthTopicWidth: 64,
  depthTopicHeight: 48,
  verticalFieldOfViewDegrees: 64,
  nearMeters: .1,
  farMeters: 8,
  frameRate: 5,
  depthTopicRate: 2,
  frameId: 'camera_rgb_optical_frame',
} as const;

export interface VisionFrame {
  width: number;
  height: number;
  rgb: Uint8ClampedArray;
  depthMeters: Float32Array;
  stamp: RosTime;
  capturedAtMs: number;
}

export interface DetectionWithDistance {
  detection: Detection2DMessage;
  classId: string;
  confidence: number;
  distanceMeters: number | null;
}

export function rosTimeToMilliseconds(stamp: RosTime): number {
  return stamp.sec * 1000 + stamp.nanosec / 1_000_000;
}

export function perspectiveDepthToMeters(depth: number, near: number, far: number): number {
  if (!Number.isFinite(depth) || depth <= 0 || depth >= 1) return Number.NaN;
  const viewZ = (near * far) / ((far - near) * depth - far);
  const meters = -viewZ;
  return meters >= near && meters <= far ? meters : Number.NaN;
}

/** Mirrors Three.js RGBADepthPacking / unpackRGBAToDepth. */
export function packedDepthBytesToMeters(r: number, g: number, b: number, a: number, near: number, far: number): number {
  // Three r178 PackFactors are RGBA = high byte -> low byte.
  const depth = r / 256 + g / 256 ** 2 + b / 256 ** 3 + a / (255 * 256 ** 3);
  return perspectiveDepthToMeters(depth, near, far);
}

export function makeCameraInfo(stamp: RosTime): CameraInfoMessage {
  const width = VISION_CAMERA.width;
  const height = VISION_CAMERA.height;
  const fovRadians = VISION_CAMERA.verticalFieldOfViewDegrees * Math.PI / 180;
  const fy = height / (2 * Math.tan(fovRadians / 2));
  const fx = fy;
  const cx = width / 2;
  const cy = height / 2;
  return {
    header: { frame_id: VISION_CAMERA.frameId, stamp },
    height,
    width,
    distortion_model: 'plumb_bob',
    d: [0, 0, 0, 0, 0],
    k: [fx, 0, cx, 0, fy, cy, 0, 0, 1],
    r: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    p: [fx, 0, cx, 0, 0, fy, cy, 0, 0, 0, 1, 0],
    binning_x: 0,
    binning_y: 0,
    roi: { x_offset: 0, y_offset: 0, height: 0, width: 0, do_rectify: false },
  };
}

export function downsampleDepthToBytes(depth: Float32Array, sourceWidth: number, sourceHeight: number, targetWidth: number, targetHeight: number): number[] {
  const buffer = new ArrayBuffer(targetWidth * targetHeight * 4);
  const output = new Float32Array(buffer);
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.min(sourceHeight - 1, Math.floor((y + .5) * sourceHeight / targetHeight));
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(sourceWidth - 1, Math.floor((x + .5) * sourceWidth / targetWidth));
      output[y * targetWidth + x] = depth[sourceY * sourceWidth + sourceX];
    }
  }
  return Array.from(new Uint8Array(buffer));
}

export function sampleDetectionDepth(detection: Detection2DMessage, depth: Float32Array, width: number, height: number): number | null {
  const centerX = detection.bbox.center.position.x;
  const centerY = detection.bbox.center.position.y;
  const halfWidth = Math.max(1, detection.bbox.size_x * .15);
  const halfHeight = Math.max(1, detection.bbox.size_y * .15);
  const minimumX = Math.max(0, Math.floor(centerX - halfWidth));
  const maximumX = Math.min(width - 1, Math.ceil(centerX + halfWidth));
  const minimumY = Math.max(0, Math.floor(centerY - halfHeight));
  const maximumY = Math.min(height - 1, Math.ceil(centerY + halfHeight));
  const samples: number[] = [];
  const stride = Math.max(1, Math.floor(Math.min(maximumX - minimumX + 1, maximumY - minimumY + 1) / 12));
  for (let y = minimumY; y <= maximumY; y += stride) {
    for (let x = minimumX; x <= maximumX; x += stride) {
      const value = depth[y * width + x];
      if (Number.isFinite(value) && value >= VISION_CAMERA.nearMeters && value <= VISION_CAMERA.farMeters) samples.push(value);
    }
  }
  if (samples.length < 3) return null;
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const filtered = samples.filter((sample) => Math.abs(sample - median) <= Math.max(.25, median * .2));
  if (filtered.length < 3) return null;
  return filtered[Math.floor(filtered.length / 2)];
}

export function combineDetectionsWithDepth(detections: Detection2DMessage[], frame: VisionFrame, maximumAgeMs = 500): DetectionWithDistance[] {
  return detections.flatMap((detection) => {
    const result = detection.results[0];
    if (!result) return [];
    const detectionAt = rosTimeToMilliseconds(detection.header.stamp);
    if (Math.abs(frame.capturedAtMs - detectionAt) > maximumAgeMs) return [];
    return [{
      detection,
      classId: result.hypothesis.class_id,
      confidence: result.hypothesis.score,
      distanceMeters: sampleDetectionDepth(detection, frame.depthMeters, frame.width, frame.height),
    }];
  });
}

export function depthToPseudoColor(distance: number, near = VISION_CAMERA.nearMeters, far = VISION_CAMERA.farMeters): [number, number, number] {
  if (!Number.isFinite(distance) || distance < near || distance > far) return [20, 30, 38];
  const normalized = Math.max(0, Math.min(1, (distance - near) / (far - near)));
  const hue = (1 - normalized) * 240;
  const chroma = 1;
  const segment = hue / 60;
  const x = chroma * (1 - Math.abs(segment % 2 - 1));
  const [r1, g1, b1] = segment < 1 ? [chroma, x, 0] : segment < 2 ? [x, chroma, 0] : segment < 3 ? [0, chroma, x] : segment < 4 ? [0, x, chroma] : segment < 5 ? [x, 0, chroma] : [chroma, 0, x];
  return [Math.round(r1 * 255), Math.round(g1 * 255), Math.round(b1 * 255)];
}
