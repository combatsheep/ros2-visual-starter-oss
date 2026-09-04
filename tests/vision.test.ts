import { describe, expect, it } from 'vitest';
import { combineDetectionsWithDepth, makeCameraInfo, packedDepthBytesToMeters, perspectiveDepthToMeters, sampleDetectionDepth, VISION_CAMERA } from '../src/vision';
import type { Detection2DMessage } from '../src/types';

const detection = (sec = 1): Detection2DMessage => ({
  header: { frame_id: VISION_CAMERA.frameId, stamp: { sec, nanosec: 0 } },
  results: [{
    hypothesis: { class_id: 'dog', score: .82 },
    pose: {
      pose: { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
      covariance: Array(36).fill(0),
    },
  }],
  bbox: { center: { position: { x: 5, y: 5 }, theta: 0 }, size_x: 6, size_y: 6 },
  id: '0',
});

describe('virtual camera depth', () => {
  it('linearizes perspective depth at known distances', () => {
    const { nearMeters: near, farMeters: far } = VISION_CAMERA;
    const depthAtTwoMeters = (far - near * far / 2) / (far - near);
    expect(perspectiveDepthToMeters(depthAtTwoMeters, near, far)).toBeCloseTo(2, 5);
    const packed = Math.floor(depthAtTwoMeters * 256 ** 3);
    const r = Math.floor(packed / 256 ** 2);
    const g = Math.floor(packed / 256) % 256;
    const b = packed % 256;
    expect(packedDepthBytesToMeters(r, g, b, 0, near, far)).toBeCloseTo(2, 3);
  });

  it('uses the robust center region and rejects invalid depth', () => {
    const depth = new Float32Array(100).fill(2);
    depth[55] = 7;
    expect(sampleDetectionDepth(detection(), depth, 10, 10)).toBeCloseTo(2);
    expect(sampleDetectionDepth(detection(), new Float32Array(100).fill(Number.NaN), 10, 10)).toBeNull();
  });

  it('does not overlay stale detections', () => {
    const frame = { width: 10, height: 10, rgb: new Uint8ClampedArray(400), depthMeters: new Float32Array(100).fill(2), stamp: { sec: 2, nanosec: 0 }, capturedAtMs: 2000 };
    expect(combineDetectionsWithDepth([detection(1)], frame, 200)).toEqual([]);
    expect(combineDetectionsWithDepth([detection(2)], frame, 200)[0].classId).toBe('dog');
  });

  it('creates pinhole CameraInfo for the optical frame', () => {
    const info = makeCameraInfo({ sec: 1, nanosec: 2 });
    expect(info.header.frame_id).toBe('camera_rgb_optical_frame');
    expect(info.k[0]).toBeGreaterThan(0);
    expect(info.width).toBe(320);
  });
});
