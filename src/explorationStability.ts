import type { OccupancyGridMessage } from './types';

export const EXPLORATION_STABLE_MAP_SAMPLE_COUNT = 3;
export const EXPLORATION_MAP_ORIGIN_TOLERANCE_METERS = 0.08;
export const EXPLORATION_MAP_YAW_TOLERANCE_RADIANS = 0.08;
export const EXPLORATION_MAP_MAX_OCCUPANCY_CHANGE_RATIO = 0.35;

export type ExplorationMapStabilityStatus =
  | 'stable'
  | 'insufficient-samples'
  | 'geometry-changing'
  | 'occupancy-changing';

export interface ExplorationMapStability {
  stable: boolean;
  status: ExplorationMapStabilityStatus;
  sampleCount: number;
}

function yawFromQuaternion(quaternion: OccupancyGridMessage['info']['origin']['orientation']): number {
  return Math.atan2(
    2 * (quaternion.w * quaternion.z + quaternion.x * quaternion.y),
    1 - 2 * (quaternion.y ** 2 + quaternion.z ** 2),
  );
}

function wrappedAngleDifference(first: number, second: number): number {
  return Math.atan2(Math.sin(first - second), Math.cos(first - second));
}

function finiteMapGeometry(map: OccupancyGridMessage): boolean {
  return Number.isInteger(map.info.width)
    && map.info.width > 0
    && Number.isInteger(map.info.height)
    && map.info.height > 0
    && Number.isFinite(map.info.resolution)
    && map.info.resolution > 0
    && map.data.length === map.info.width * map.info.height
    && Number.isFinite(map.info.origin.position.x)
    && Number.isFinite(map.info.origin.position.y)
    && Number.isFinite(yawFromQuaternion(map.info.origin.orientation));
}

function occupancyChangeRatio(previous: OccupancyGridMessage, current: OccupancyGridMessage): number {
  if (previous.data.length !== current.data.length || previous.data.length === 0) return 1;
  let changed = 0;
  for (let index = 0; index < current.data.length; index += 1) {
    if (previous.data[index] !== current.data[index]) changed += 1;
  }
  return changed / current.data.length;
}

/**
 * Detects the short-lived SLAM map changes that make a navigation goal stale.
 * Map growth is expected during exploration, so the result is intentionally
 * conservative: three consecutive samples with the same geometry and only a
 * bounded occupancy change are required before Object Search sends a goal.
 */
export function assessExplorationMapStability(
  snapshots: readonly OccupancyGridMessage[],
  requiredSamples = EXPLORATION_STABLE_MAP_SAMPLE_COUNT,
): ExplorationMapStability {
  if (!Number.isInteger(requiredSamples) || requiredSamples < 2) {
    throw new RangeError('Exploration map stability requires at least two samples.');
  }
  const recent = snapshots.slice(-requiredSamples);
  if (recent.length < requiredSamples) {
    return { stable: false, status: 'insufficient-samples', sampleCount: recent.length };
  }
  if (recent.some((map) => !finiteMapGeometry(map))) {
    return { stable: false, status: 'geometry-changing', sampleCount: recent.length };
  }

  const reference = recent[0];
  const referenceYaw = yawFromQuaternion(reference.info.origin.orientation);
  for (const map of recent.slice(1)) {
    const originYaw = yawFromQuaternion(map.info.origin.orientation);
    if (map.info.width !== reference.info.width
      || map.info.height !== reference.info.height
      || Math.abs(map.info.resolution - reference.info.resolution) > Number.EPSILON
      || Math.abs(map.info.origin.position.x - reference.info.origin.position.x) > EXPLORATION_MAP_ORIGIN_TOLERANCE_METERS
      || Math.abs(map.info.origin.position.y - reference.info.origin.position.y) > EXPLORATION_MAP_ORIGIN_TOLERANCE_METERS
      || Math.abs(wrappedAngleDifference(originYaw, referenceYaw)) > EXPLORATION_MAP_YAW_TOLERANCE_RADIANS) {
      return { stable: false, status: 'geometry-changing', sampleCount: recent.length };
    }
    if (occupancyChangeRatio(reference, map) > EXPLORATION_MAP_MAX_OCCUPANCY_CHANGE_RATIO) {
      return { stable: false, status: 'occupancy-changing', sampleCount: recent.length };
    }
  }
  return { stable: true, status: 'stable', sampleCount: recent.length };
}
