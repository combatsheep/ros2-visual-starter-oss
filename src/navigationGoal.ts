import {
  EXPLORATION_REQUIRED_CLEARANCE_METERS,
  computeClearanceMeters,
  worldToGridCell,
  type FrontierGrid,
  type FrontierPoint,
} from './frontierExploration';

export interface NavigationGoalPoint extends FrontierPoint {
  yaw: number;
}

export type NavigationGoalObstacleKind = 'occupied' | 'unknown' | 'map-boundary';

export interface NavigationGoalAdjustment {
  goal: NavigationGoalPoint;
  adjusted: boolean;
  obstacleKind: NavigationGoalObstacleKind | null;
  obstacleDistanceMeters: number | null;
  retreatMeters: number;
}

export interface NavigationGoalAdjustmentOptions {
  freeOccupancyMax?: number;
  lookBeyondMeters?: number;
  desiredObstacleClearanceMeters?: number;
  maximumRetreatMeters?: number;
  minimumRetreatMeters?: number;
  minimumGoalClearanceMeters?: number;
  minimumRobotGoalDistanceMeters?: number;
}

const DEFAULT_OPTIONS: Required<NavigationGoalAdjustmentOptions> = {
  freeOccupancyMax: 20,
  lookBeyondMeters: .55,
  desiredObstacleClearanceMeters: .48,
  maximumRetreatMeters: .30,
  minimumRetreatMeters: .06,
  minimumGoalClearanceMeters: EXPLORATION_REQUIRED_CLEARANCE_METERS,
  minimumRobotGoalDistanceMeters: .5,
};

function validateOptions(options: Required<NavigationGoalAdjustmentOptions>): void {
  if (!Number.isFinite(options.freeOccupancyMax) || options.freeOccupancyMax < 0 || options.freeOccupancyMax >= 100) {
    throw new RangeError('freeOccupancyMax must be between 0 and 99.');
  }
  for (const [key, value] of Object.entries(options)) {
    if (key === 'freeOccupancyMax') continue;
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`${key} must be finite and non-negative.`);
  }
}

function obstacleAt(grid: FrontierGrid, point: FrontierPoint, freeOccupancyMax: number): NavigationGoalObstacleKind | null {
  const cell = worldToGridCell(grid, point);
  if (!cell) return 'map-boundary';
  const occupancy = grid.data[cell.index];
  if (occupancy < 0) return 'unknown';
  return occupancy > freeOccupancyMax ? 'occupied' : null;
}

/**
 * If unknown space, a wall, or the map edge is immediately beyond the goal,
 * move only the goal toward the robot. This module never issues a velocity or
 * recovery command and is independent of ROS, Transport, and the DOM.
 */
export function adjustNavigationGoalForObstacleBeyond(
  grid: FrontierGrid,
  robotWorld: FrontierPoint,
  requestedGoal: NavigationGoalPoint,
  overrides: NavigationGoalAdjustmentOptions = {},
): NavigationGoalAdjustment {
  const options = { ...DEFAULT_OPTIONS, ...overrides };
  validateOptions(options);
  const unchanged = (obstacleKind: NavigationGoalObstacleKind | null = null, obstacleDistanceMeters: number | null = null): NavigationGoalAdjustment => ({
    goal: { ...requestedGoal },
    adjusted: false,
    obstacleKind,
    obstacleDistanceMeters,
    retreatMeters: 0,
  });
  const dx = requestedGoal.x - robotWorld.x;
  const dy = requestedGoal.y - robotWorld.y;
  const distanceToGoal = Math.hypot(dx, dy);
  if (!Number.isFinite(distanceToGoal) || distanceToGoal <= grid.resolution) return unchanged();
  const direction = { x: dx / distanceToGoal, y: dy / distanceToGoal };
  const sampleStep = Math.max(grid.resolution / 2, .01);
  let obstacleKind: NavigationGoalObstacleKind | null = null;
  let obstacleDistanceMeters: number | null = null;
  for (let distance = sampleStep; distance <= options.lookBeyondMeters + sampleStep / 2; distance += sampleStep) {
    obstacleKind = obstacleAt(grid, {
      x: requestedGoal.x + direction.x * distance,
      y: requestedGoal.y + direction.y * distance,
    }, options.freeOccupancyMax);
    if (obstacleKind) {
      obstacleDistanceMeters = distance;
      break;
    }
  }
  if (!obstacleKind || obstacleDistanceMeters === null
    || obstacleDistanceMeters >= options.desiredObstacleClearanceMeters) return unchanged(obstacleKind, obstacleDistanceMeters);

  const maximumRetreat = Math.min(
    options.maximumRetreatMeters,
    Math.max(0, distanceToGoal - options.minimumRobotGoalDistanceMeters),
  );
  const requestedRetreat = Math.min(
    maximumRetreat,
    Math.max(options.minimumRetreatMeters, options.desiredObstacleClearanceMeters - obstacleDistanceMeters),
  );
  if (maximumRetreat < options.minimumRetreatMeters) return unchanged(obstacleKind, obstacleDistanceMeters);

  const clearanceMeters = computeClearanceMeters(grid, options.freeOccupancyMax);
  for (let retreat = requestedRetreat; retreat <= maximumRetreat + sampleStep / 2; retreat += sampleStep) {
    const boundedRetreat = Math.min(retreat, maximumRetreat);
    const candidate: NavigationGoalPoint = {
      x: requestedGoal.x - direction.x * boundedRetreat,
      y: requestedGoal.y - direction.y * boundedRetreat,
      yaw: requestedGoal.yaw,
    };
    const cell = worldToGridCell(grid, candidate);
    if (!cell || grid.data[cell.index] < 0 || grid.data[cell.index] > options.freeOccupancyMax) continue;
    if (clearanceMeters[cell.index] + Number.EPSILON < options.minimumGoalClearanceMeters) continue;
    return {
      goal: candidate,
      adjusted: true,
      obstacleKind,
      obstacleDistanceMeters,
      retreatMeters: boundedRetreat,
    };
  }
  return unchanged(obstacleKind, obstacleDistanceMeters);
}
