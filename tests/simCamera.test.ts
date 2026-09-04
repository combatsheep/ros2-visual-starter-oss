import { describe, expect, it } from 'vitest';
import { clampSimTopCameraZoom, SIM_TOP_CAMERA_DEFAULT_HEIGHT, SIM_TOP_CAMERA_MAX_ZOOM, SIM_TOP_CAMERA_MIN_ZOOM, SIM_TOP_CAMERA_ZOOM_STEP, simTopCameraHeight } from '../src/simCamera';

describe('SIM top camera zoom', () => {
  it('uses the same fixed zoom ratio as the map controls', () => {
    expect(SIM_TOP_CAMERA_ZOOM_STEP).toBe(1.25);
    expect(simTopCameraHeight(SIM_TOP_CAMERA_ZOOM_STEP)).toBeCloseTo(SIM_TOP_CAMERA_DEFAULT_HEIGHT / 1.25);
  });

  it('clamps zoom and resets to the default height at Fit', () => {
    expect(clampSimTopCameraZoom(0.1)).toBe(SIM_TOP_CAMERA_MIN_ZOOM);
    expect(clampSimTopCameraZoom(10)).toBe(SIM_TOP_CAMERA_MAX_ZOOM);
    expect(simTopCameraHeight(1)).toBe(SIM_TOP_CAMERA_DEFAULT_HEIGHT);
  });
});
