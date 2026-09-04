import {
  EXPLORATION_REQUIRED_CLEARANCE_METERS,
  computeClearanceMeters,
  worldToGridCell,
  type FrontierGrid,
} from './frontierExploration';
import { quaternionToYaw } from './navigationMap';
import {
  APPLE_GOAL_DESIRED_DISTANCE_METERS,
  APPLE_GOAL_MAX_DISTANCE_METERS,
  appleDetectionHasValidDepth,
  appleDetectionIsWithinSearchRange,
  type AppleDetectionEvidence,
} from './objectSearchDetection';
import { ROBOT_GEOMETRY } from './robotGeometry';
import type { PoseMessage } from './types';
import { VISION_CAMERA } from './vision';

export const APPLE_APPROACH_MAX_STANDOFF_METERS = APPLE_GOAL_MAX_DISTANCE_METERS;
export const APPLE_APPROACH_FREE_OCCUPANCY_MAX = 20;

export interface AppleApproachGeometry {
  target: { x: number; y: number };
  measuredDepthMeters: number;
  cameraRangeMeters: number;
  bearingRadians: number;
  horizontalOffsetRatio: number;
}

export interface AppleApproachGoal extends AppleApproachGeometry {
  goal: { x: number; y: number; yaw: number };
  requestedCameraDistanceMeters: number;
  selectedCameraDistanceMeters: number;
  goalClearanceMeters: number;
  adjustedForClearance: boolean;
}

export type AppleApproachPlan =
  | { status: 'positioned'; geometry: AppleApproachGeometry | null }
  | { status: 'goal'; approach: AppleApproachGoal }
  | { status: 'unavailable'; reason: string };

function finitePose(pose: PoseMessage): boolean {
  return [
    pose.position.x,
    pose.position.y,
    pose.orientation.x,
    pose.orientation.y,
    pose.orientation.z,
    pose.orientation.w,
  ].every(Number.isFinite);
}

function projectAppleGeometry(
  detection: AppleDetectionEvidence,
  robotPose: PoseMessage,
): AppleApproachGeometry | null {
  if (!appleDetectionHasValidDepth(detection)
    || !finitePose(robotPose)
    || !Number.isFinite(detection.imageWidth)
    || detection.imageWidth <= 0
    || !Number.isFinite(detection.imageHeight)
    || detection.imageHeight <= 0) return null;

  const measuredDepthMeters = detection.distanceMeters as number;
  const verticalFovRadians = VISION_CAMERA.verticalFieldOfViewDegrees * Math.PI / 180;
  const focalLengthPixels = detection.imageHeight / (2 * Math.tan(verticalFovRadians / 2));
  const offsetPixels = detection.bbox.centerX - detection.imageWidth / 2;
  const lateralLeftMeters = -offsetPixels / focalLengthPixels * measuredDepthMeters;
  const cameraRangeMeters = Math.hypot(measuredDepthMeters, lateralLeftMeters);
  const bearingRadians = Math.atan2(lateralLeftMeters, measuredDepthMeters);
  const horizontalOffsetRatio = offsetPixels / (detection.imageWidth / 2);
  const robotYaw = quaternionToYaw(robotPose.orientation);
  const cameraForwardOffsetMeters = Math.abs(ROBOT_GEOMETRY.cameraViewLocalZ);
  const cameraX = robotPose.position.x + Math.cos(robotYaw) * cameraForwardOffsetMeters;
  const cameraY = robotPose.position.y + Math.sin(robotYaw) * cameraForwardOffsetMeters;
  const targetYaw = robotYaw + bearingRadians;
  return {
    target: {
      x: cameraX + Math.cos(targetYaw) * cameraRangeMeters,
      y: cameraY + Math.sin(targetYaw) * cameraRangeMeters,
    },
    measuredDepthMeters,
    cameraRangeMeters,
    bearingRadians,
    horizontalOffsetRatio,
  };
}

/**
 * Produces one map-frame Nav2 endpoint in front of the detected target.
 * The endpoint always faces the target and is accepted only on known-free
 * map cells with the same hard clearance used by Frontier Exploration.
 */
export function planAppleApproachGoal(
  detection: AppleDetectionEvidence,
  robotPose: PoseMessage,
  grid: FrontierGrid,
): AppleApproachPlan {
  if (appleDetectionIsWithinSearchRange(detection)) {
    // Any visible target within 5 m needs no center, map pose, or approach goal.
    return { status: 'positioned', geometry: null };
  }
  const geometry = projectAppleGeometry(detection, robotPose);
  if (!geometry) return { status: 'unavailable', reason: 'fresh DepthまたはSLAM poseから対象位置を計算できません。' };

  let clearanceMeters: Float64Array;
  try {
    clearanceMeters = computeClearanceMeters(grid, APPLE_APPROACH_FREE_OCCUPANCY_MAX);
  } catch {
    return { status: 'unavailable', reason: '現在のlive mapを接近goalの安全確認へ使用できません。' };
  }

  const robotYaw = quaternionToYaw(robotPose.orientation);
  const goalYaw = robotYaw + geometry.bearingRadians;
  const cameraForwardOffsetMeters = Math.abs(ROBOT_GEOMETRY.cameraViewLocalZ);
  const stepMeters = Math.max(.05, grid.resolution);
  for (
    let standoffMeters = APPLE_GOAL_DESIRED_DISTANCE_METERS;
    standoffMeters <= APPLE_APPROACH_MAX_STANDOFF_METERS + stepMeters / 2;
    standoffMeters += stepMeters
  ) {
    const selectedCameraDistanceMeters = Math.min(standoffMeters, APPLE_APPROACH_MAX_STANDOFF_METERS);
    const baseDistanceFromTarget = selectedCameraDistanceMeters + cameraForwardOffsetMeters;
    const goal = {
      x: geometry.target.x - Math.cos(goalYaw) * baseDistanceFromTarget,
      y: geometry.target.y - Math.sin(goalYaw) * baseDistanceFromTarget,
      yaw: goalYaw,
    };
    const cell = worldToGridCell(grid, goal);
    if (!cell) continue;
    const occupancy = Number(grid.data[cell.index]);
    if (!Number.isFinite(occupancy) || occupancy < 0 || occupancy > APPLE_APPROACH_FREE_OCCUPANCY_MAX) continue;
    const goalClearanceMeters = clearanceMeters[cell.index];
    if (!Number.isFinite(goalClearanceMeters)
      || goalClearanceMeters + Number.EPSILON < EXPLORATION_REQUIRED_CLEARANCE_METERS) continue;
    return {
      status: 'goal',
      approach: {
        ...geometry,
        goal,
        requestedCameraDistanceMeters: APPLE_GOAL_DESIRED_DISTANCE_METERS,
        selectedCameraDistanceMeters,
        goalClearanceMeters,
        adjustedForClearance: selectedCameraDistanceMeters > APPLE_GOAL_DESIRED_DISTANCE_METERS + Number.EPSILON,
      },
    };
  }
  return {
    status: 'unavailable',
    reason: '対象正面に既知freeかつSafety余白を満たす接近goalを作れません。手動で安全な位置へ移動して再開してください。',
  };
}
