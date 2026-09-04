export const SIM_LIDAR_RAY_COUNT = 1080;
export const SIM_LIDAR_VISIBLE_RAY_COUNT = 180;
export const SIM_LIDAR_VISIBLE_DEFAULT = false;
export const SIM_LIDAR_RANGE_MIN = 0.05;
export const SIM_LIDAR_RANGE_MAX = 8;
export const SLAM_MAP_RESOLUTION = 0.05;

const NO_RETURN_MARGIN_METERS = 0.01;

export function lidarAngleIncrement(rayCount = SIM_LIDAR_RAY_COUNT): number {
  return Math.PI * 2 / rayCount;
}

export function lidarAngleAt(index: number, rayCount = SIM_LIDAR_RAY_COUNT): number {
  return -Math.PI + index * lidarAngleIncrement(rayCount);
}

export function lidarAngleMax(rayCount = SIM_LIDAR_RAY_COUNT): number {
  return lidarAngleAt(rayCount - 1, rayCount);
}

export function lidarEndpointSpacing(rangeMeters: number, rayCount = SIM_LIDAR_RAY_COUNT): number {
  return 2 * rangeMeters * Math.sin(Math.PI / rayCount);
}

export function lidarVisibleScanIndex(
  visibleIndex: number,
  scanRayCount = SIM_LIDAR_RAY_COUNT,
  visibleRayCount = SIM_LIDAR_VISIBLE_RAY_COUNT,
): number {
  if (!Number.isInteger(scanRayCount) || scanRayCount < 1
    || !Number.isInteger(visibleRayCount) || visibleRayCount < 1 || visibleRayCount > scanRayCount) {
    throw new RangeError('LiDAR scan and visible ray counts must be positive integers, with visible rays no greater than scan rays.');
  }
  if (!Number.isInteger(visibleIndex) || visibleIndex < 0 || visibleIndex >= visibleRayCount) {
    throw new RangeError('LiDAR visible ray index is outside the visible range.');
  }
  return Math.floor(visibleIndex * scanRayCount / visibleRayCount);
}

export function nearestVisibleLidarRayIndex(
  scanIndex: number,
  scanRayCount = SIM_LIDAR_RAY_COUNT,
  visibleRayCount = SIM_LIDAR_VISIBLE_RAY_COUNT,
): number {
  if (!Number.isInteger(scanIndex) || scanIndex < 0 || scanIndex >= scanRayCount) {
    throw new RangeError('LiDAR scan index is outside the scan range.');
  }
  return Math.min(visibleRayCount - 1, Math.round(scanIndex * visibleRayCount / scanRayCount));
}

export function lidarScanRange(hitDistance: number | null, rangeMin = SIM_LIDAR_RANGE_MIN, rangeMax = SIM_LIDAR_RANGE_MAX): number {
  if (hitDistance === null || !Number.isFinite(hitDistance)) return rangeMax + NO_RETURN_MARGIN_METERS;
  return Math.max(rangeMin, Math.min(rangeMax, hitDistance));
}
