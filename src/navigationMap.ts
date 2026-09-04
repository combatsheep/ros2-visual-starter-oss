import { Header, OccupancyGridMessage, PoseMessage, PoseStampedMessage, QuaternionMessage, RosTime, TransformStampedMessage } from './types';

export interface Point2 { x: number; y: number }
export interface RobotMarkerDimensions { length: number; width: number }
export interface MapViewport {
  scale: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

const ROBOT_FOOTPRINT = { length: 0.4, width: 0.5 } as const;
const clamp = (value: number, minimum: number, maximum: number): number => Math.max(minimum, Math.min(maximum, value));

export const EXPLORATION_NAVIGATION_TF_MAX_AGE_MS = 500;
const EXPLORATION_NAVIGATION_TF_FUTURE_TOLERANCE_MS = 1000;

export type NavigationTransformFreshness =
  | { status: 'fresh'; ageMs: number }
  | { status: 'missing' | 'invalid' }
  | { status: 'stale' | 'future'; ageMs: number };

export function rosTimeToMilliseconds(stamp: RosTime): number {
  return stamp.sec * 1000 + stamp.nanosec / 1_000_000;
}

/** Prevents exploration goals from being sent while SLAM's map->odom TF is lagging. */
export function navigationTransformFreshness(
  transform: TransformStampedMessage | null,
  nowMs: number,
  maxAgeMs = EXPLORATION_NAVIGATION_TF_MAX_AGE_MS,
): NavigationTransformFreshness {
  if (!transform) return { status: 'missing' };
  const timestampMs = rosTimeToMilliseconds(transform.header.stamp);
  if (!Number.isFinite(timestampMs) || timestampMs <= 0 || !Number.isFinite(nowMs)) return { status: 'invalid' };
  const ageMs = nowMs - timestampMs;
  if (ageMs < -EXPLORATION_NAVIGATION_TF_FUTURE_TOLERANCE_MS) return { status: 'future', ageMs };
  if (ageMs > maxAgeMs) return { status: 'stale', ageMs };
  return { status: 'fresh', ageMs: Math.max(0, ageMs) };
}

/** Finds the sensor/TF sample closest to a message timestamp without mixing unrelated frames. */
export function closestStamped<T extends { header: Header }>(samples: readonly T[], stamp: RosTime, maxDifferenceMs = 250): T | null {
  const target = rosTimeToMilliseconds(stamp);
  let closest: T | null = null;
  let closestDifference = Number.POSITIVE_INFINITY;
  for (const sample of samples) {
    const difference = Math.abs(rosTimeToMilliseconds(sample.header.stamp) - target);
    if (difference < closestDifference) {
      closest = sample;
      closestDifference = difference;
    }
  }
  return closestDifference <= maxDifferenceMs ? closest : null;
}

export function quaternionToYaw(quaternion: QuaternionMessage): number {
  return Math.atan2(2 * (quaternion.w * quaternion.z + quaternion.x * quaternion.y), 1 - 2 * (quaternion.y ** 2 + quaternion.z ** 2));
}

export function laserHitToWorld(pose: PoseMessage, scanAngle: number, range: number): Point2 {
  const angle = quaternionToYaw(pose.orientation) + scanAngle;
  return {
    x: pose.position.x + Math.cos(angle) * range,
    y: pose.position.y + Math.sin(angle) * range,
  };
}

/** Applies the map-to-odom correction observed at the robot to another odom pose. */
export function transformOdomPoseToMap(mapRobotPose: PoseMessage, odomRobotPose: PoseMessage, odomPose: PoseMessage): PoseMessage {
  const transformYaw = quaternionToYaw(mapRobotPose.orientation) - quaternionToYaw(odomRobotPose.orientation);
  const cosine = Math.cos(transformYaw);
  const sine = Math.sin(transformYaw);
  const rotatedRobotX = cosine * odomRobotPose.position.x - sine * odomRobotPose.position.y;
  const rotatedRobotY = sine * odomRobotPose.position.x + cosine * odomRobotPose.position.y;
  const translationX = mapRobotPose.position.x - rotatedRobotX;
  const translationY = mapRobotPose.position.y - rotatedRobotY;
  const x = translationX + cosine * odomPose.position.x - sine * odomPose.position.y;
  const y = translationY + sine * odomPose.position.x + cosine * odomPose.position.y;
  return makePose(x, y, transformYaw + quaternionToYaw(odomPose.orientation));
}

/** Applies a ROS planar TransformStamped (for example map -> odom) to a pose. */
export function applyPlanarTransform(transform: TransformStampedMessage, pose: PoseMessage): PoseMessage {
  const yaw = quaternionToYaw(transform.transform.rotation);
  const cosine = Math.cos(yaw);
  const sine = Math.sin(yaw);
  return makePose(
    transform.transform.translation.x + cosine * pose.position.x - sine * pose.position.y,
    transform.transform.translation.y + sine * pose.position.x + cosine * pose.position.y,
    yaw + quaternionToYaw(pose.orientation),
  );
}

export interface MappingPoseSelection {
  pose: PoseStampedMessage;
  source: 'tf-odom' | 'slam-pose';
  timestampMs: number;
}

/**
 * Selects the newest mapping pose without letting an old optional /pose sample
 * pin the UI while synchronized map->odom and odom samples continue to arrive.
 */
export function selectMappingPose(
  slamPose: PoseStampedMessage | null,
  mapToOdomSamples: readonly TransformStampedMessage[],
  odomSamples: readonly PoseStampedMessage[],
  maxSynchronizationDifferenceMs = 500,
): MappingPoseSelection | null {
  let synchronized: MappingPoseSelection | null = null;
  for (const mapToOdom of mapToOdomSamples) {
    const odom = closestStamped(odomSamples, mapToOdom.header.stamp, maxSynchronizationDifferenceMs);
    if (!odom) continue;
    const timestampMs = Math.min(
      rosTimeToMilliseconds(mapToOdom.header.stamp),
      rosTimeToMilliseconds(odom.header.stamp),
    );
    if (synchronized && synchronized.timestampMs >= timestampMs) continue;
    synchronized = {
      pose: { header: mapToOdom.header, pose: applyPlanarTransform(mapToOdom, odom.pose) },
      source: 'tf-odom',
      timestampMs,
    };
  }
  const direct = slamPose
    ? {
        pose: slamPose,
        source: 'slam-pose' as const,
        timestampMs: rosTimeToMilliseconds(slamPose.header.stamp),
      }
    : null;
  if (!synchronized) return direct;
  if (!direct || synchronized.timestampMs >= direct.timestampMs) return synchronized;
  return direct;
}

export function worldToMapCell(map: OccupancyGridMessage, point: Point2): Point2 {
  const origin = map.info.origin;
  const yaw = quaternionToYaw(origin.orientation);
  const dx = point.x - origin.position.x;
  const dy = point.y - origin.position.y;
  return {
    x: (Math.cos(yaw) * dx + Math.sin(yaw) * dy) / map.info.resolution,
    y: (-Math.sin(yaw) * dx + Math.cos(yaw) * dy) / map.info.resolution,
  };
}

export function mapCellToWorld(map: OccupancyGridMessage, cell: Point2): Point2 {
  const origin = map.info.origin;
  const yaw = quaternionToYaw(origin.orientation);
  const localX = cell.x * map.info.resolution;
  const localY = cell.y * map.info.resolution;
  return {
    x: origin.position.x + Math.cos(yaw) * localX - Math.sin(yaw) * localY,
    y: origin.position.y + Math.sin(yaw) * localX + Math.cos(yaw) * localY,
  };
}

export function worldToCanvas(map: OccupancyGridMessage, point: Point2, width: number, height: number): Point2 {
  const cell = worldToMapCell(map, point);
  return { x: cell.x / map.info.width * width, y: height - cell.y / map.info.height * height };
}

export function canvasToWorld(map: OccupancyGridMessage, point: Point2, width: number, height: number): Point2 {
  return mapCellToWorld(map, { x: point.x / width * map.info.width, y: (height - point.y) / height * map.info.height });
}

/** Fits an OccupancyGrid into a canvas without changing the map aspect ratio. */
export function createMapViewport(map: OccupancyGridMessage, width: number, height: number, zoom = 1): MapViewport {
  const safeWidth = Math.max(1, map.info.width);
  const safeHeight = Math.max(1, map.info.height);
  const fitPadding = Math.max(12, Math.min(width, height) * .035);
  const usableWidth = width - fitPadding * 2;
  const usableHeight = height - fitPadding * 2;
  const fittedScale = Math.min(usableWidth / safeWidth, usableHeight / safeHeight);
  const scale = Math.max(.001, fittedScale * clamp(zoom, .5, 4));
  const viewportWidth = safeWidth * scale;
  const viewportHeight = safeHeight * scale;
  const centeredOffsetY = (height - viewportHeight) / 2;
  const desiredUpwardBias = Math.abs(zoom - 1) < .001 ? Math.max(8, Math.min(width, height) * .02) : 0;
  const upwardBias = Math.min(desiredUpwardBias, Math.max(0, centeredOffsetY - 4));
  return {
    scale,
    offsetX: (width - viewportWidth) / 2,
    offsetY: centeredOffsetY - upwardBias,
    width: viewportWidth,
    height: viewportHeight,
  };
}

export function worldToViewportCanvas(map: OccupancyGridMessage, point: Point2, viewport: MapViewport): Point2 {
  const cell = worldToMapCell(map, point);
  return {
    x: viewport.offsetX + cell.x * viewport.scale,
    y: viewport.offsetY + (map.info.height - cell.y) * viewport.scale,
  };
}

export function viewportCanvasToWorld(map: OccupancyGridMessage, point: Point2, viewport: MapViewport): Point2 | null {
  if (point.x < viewport.offsetX || point.x > viewport.offsetX + viewport.width || point.y < viewport.offsetY || point.y > viewport.offsetY + viewport.height) return null;
  return mapCellToWorld(map, {
    x: (point.x - viewport.offsetX) / viewport.scale,
    y: map.info.height - (point.y - viewport.offsetY) / viewport.scale,
  });
}

/** Converts the 0.4m x 0.5m training-room robot footprint to readable map pixels. */
export function robotMarkerDimensions(map: OccupancyGridMessage, width: number, height: number): RobotMarkerDimensions {
  const mapWidthMeters = map.info.width * map.info.resolution;
  const mapHeightMeters = map.info.height * map.info.resolution;
  if (mapWidthMeters <= 0 || mapHeightMeters <= 0) return { length: 24, width: 30 };
  const pixelsPerMeter = Math.min(width / mapWidthMeters, height / mapHeightMeters);
  return {
    length: clamp(ROBOT_FOOTPRINT.length * pixelsPerMeter, 24, 72),
    width: clamp(ROBOT_FOOTPRINT.width * pixelsPerMeter, 30, 84),
  };
}

/** Keeps the marker at the physical robot footprint for aspect-fitted/zoomed maps. */
export function robotMarkerDimensionsForViewport(map: OccupancyGridMessage, viewport: MapViewport): RobotMarkerDimensions {
  const pixelsPerMeter = viewport.scale / map.info.resolution;
  return {
    length: clamp(ROBOT_FOOTPRINT.length * pixelsPerMeter, 24, 72),
    width: clamp(ROBOT_FOOTPRINT.width * pixelsPerMeter, 30, 84),
  };
}

export function makePose(x: number, y: number, yaw = 0): PoseMessage {
  return {
    position: { x, y, z: 0 },
    orientation: { x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) },
  };
}
