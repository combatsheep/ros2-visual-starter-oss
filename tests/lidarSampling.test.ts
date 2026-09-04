import { describe, expect, it } from 'vitest';
import {
  lidarAngleAt,
  lidarAngleIncrement,
  lidarAngleMax,
  lidarEndpointSpacing,
  lidarScanRange,
  lidarVisibleScanIndex,
  nearestVisibleLidarRayIndex,
  SIM_LIDAR_VISIBLE_DEFAULT,
  SIM_LIDAR_RANGE_MAX,
  SIM_LIDAR_RAY_COUNT,
  SIM_LIDAR_VISIBLE_RAY_COUNT,
  SLAM_MAP_RESOLUTION,
} from '../src/lidarSampling';

describe('SIM LiDAR sampling', () => {
  it('keeps the 3D LiDAR visualization off by default while scan data remains available', () => {
    expect(SIM_LIDAR_VISIBLE_DEFAULT).toBe(false);
  });

  it('keeps adjacent endpoints within one SLAM cell at maximum range', () => {
    expect(SIM_LIDAR_RAY_COUNT).toBe(1080);
    expect(lidarEndpointSpacing(SIM_LIDAR_RANGE_MAX)).toBeLessThanOrEqual(SLAM_MAP_RESOLUTION);
  });

  it('describes one full revolution without duplicating the first ray', () => {
    expect(lidarAngleAt(0)).toBe(-Math.PI);
    expect(lidarAngleMax()).toBeCloseTo(Math.PI - lidarAngleIncrement(), 12);
  });

  it('uses a finite out-of-range value for no return', () => {
    const noReturn = lidarScanRange(null);
    expect(Number.isFinite(noReturn)).toBe(true);
    expect(noReturn).toBeGreaterThan(SIM_LIDAR_RANGE_MAX);
    expect(lidarScanRange(0.01)).toBe(0.05);
    expect(lidarScanRange(2.5)).toBe(2.5);
  });

  it('keeps the 1080-ray scan while rendering a deterministic 180-ray sample', () => {
    expect(SIM_LIDAR_VISIBLE_RAY_COUNT).toBe(180);
    expect(lidarVisibleScanIndex(0)).toBe(0);
    expect(lidarVisibleScanIndex(1)).toBe(6);
    expect(lidarVisibleScanIndex(179)).toBe(1074);
    expect(nearestVisibleLidarRayIndex(0)).toBe(0);
    expect(nearestVisibleLidarRayIndex(1079)).toBe(179);
  });

  it('rejects invalid visualization sampling ranges', () => {
    expect(() => lidarVisibleScanIndex(180)).toThrow(RangeError);
    expect(() => lidarVisibleScanIndex(0, 10, 11)).toThrow(RangeError);
    expect(() => nearestVisibleLidarRayIndex(-1)).toThrow(RangeError);
  });
});
