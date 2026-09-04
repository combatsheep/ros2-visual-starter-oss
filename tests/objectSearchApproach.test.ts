import { describe, expect, it } from 'vitest';
import { worldToGridCell, type FrontierGrid } from '../src/frontierExploration';
import { makePose } from '../src/navigationMap';
import {
  APPLE_GOAL_DESIRED_DISTANCE_METERS,
  type AppleDetectionEvidence,
} from '../src/objectSearchDetection';
import { planAppleApproachGoal } from '../src/objectSearchApproach';
import { ROBOT_GEOMETRY } from '../src/robotGeometry';

function apple(overrides: Partial<AppleDetectionEvidence> = {}): AppleDetectionEvidence {
  return {
    classId: 'apple',
    confidence: .82,
    bbox: { centerX: 160, centerY: 120, width: 64, height: 48 },
    distanceMeters: 1.73,
    index: 0,
    bboxAreaRatio: .04,
    centerDistanceSquared: 0,
    imageWidth: 320,
    imageHeight: 240,
    frameStampMs: 1_000,
    observedAtMs: 1_010,
    ...overrides,
  };
}

function freeGrid(): FrontierGrid {
  return {
    width: 200,
    height: 200,
    resolution: .05,
    origin: { x: -5, y: -5, yaw: 0 },
    data: Array<number>(200 * 200).fill(0),
  };
}

describe('apple approach goal planning', () => {
  it('recognizes any visible apple within 5 m without requiring camera centering', () => {
    const plan = planAppleApproachGoal(apple({
      bbox: { centerX: 42, centerY: 120, width: 64, height: 48 },
      centerDistanceSquared: (42 - 160) ** 2,
      distanceMeters: 4.99,
    }), makePose(0, 0, .4), freeGrid());
    expect(plan.status).toBe('positioned');
    if (plan.status !== 'positioned') throw new Error('expected a positioned target');
    expect(plan.geometry).toBeNull();
  });

  it('does not position an apple without valid distance evidence', () => {
    const plan = planAppleApproachGoal(apple({ distanceMeters: null }), makePose(0, 0, .4), freeGrid());
    expect(plan).toMatchObject({ status: 'unavailable' });
  });

  it('projects an off-center detection and produces a safe goal facing the apple', () => {
    const plan = planAppleApproachGoal(apple({
      bbox: { centerX: 100, centerY: 120, width: 64, height: 48 },
      centerDistanceSquared: (100 - 160) ** 2,
      distanceMeters: 5.1,
    }), makePose(0, 0, 0), freeGrid());
    expect(plan.status).toBe('goal');
    if (plan.status !== 'goal') throw new Error('expected an approach goal');

    expect(plan.approach.horizontalOffsetRatio).toBeLessThan(0);
    expect(plan.approach.goal.yaw).toBeGreaterThan(0);
    const cameraOffset = Math.abs(ROBOT_GEOMETRY.cameraViewLocalZ);
    const finalCamera = {
      x: plan.approach.goal.x + Math.cos(plan.approach.goal.yaw) * cameraOffset,
      y: plan.approach.goal.y + Math.sin(plan.approach.goal.yaw) * cameraOffset,
    };
    expect(Math.hypot(
      plan.approach.target.x - finalCamera.x,
      plan.approach.target.y - finalCamera.y,
    )).toBeCloseTo(APPLE_GOAL_DESIRED_DISTANCE_METERS, 6);
    expect(Math.atan2(
      plan.approach.target.y - plan.approach.goal.y,
      plan.approach.target.x - plan.approach.goal.x,
    )).toBeCloseTo(plan.approach.goal.yaw, 6);
  });

  it('retreats along the same sight line when the desired endpoint lacks clearance', () => {
    const grid = freeGrid();
    const offCenterApple = apple({
      bbox: { centerX: 100, centerY: 120, width: 64, height: 48 },
      centerDistanceSquared: (100 - 160) ** 2,
      distanceMeters: 5.1,
    });
    const desired = planAppleApproachGoal(offCenterApple, makePose(0, 0), grid);
    expect(desired.status).toBe('goal');
    if (desired.status !== 'goal') throw new Error('expected a desired goal');
    const nearbyObstacle = {
      x: desired.approach.goal.x + Math.cos(desired.approach.goal.yaw) * .2,
      y: desired.approach.goal.y + Math.sin(desired.approach.goal.yaw) * .2,
    };
    const blockedCell = worldToGridCell(grid, nearbyObstacle);
    if (!blockedCell) throw new Error('goal must be on the test map');
    (grid.data as number[])[blockedCell.index] = 100;

    const adjusted = planAppleApproachGoal(offCenterApple, makePose(0, 0), grid);
    expect(adjusted.status).toBe('goal');
    if (adjusted.status !== 'goal') throw new Error('expected an adjusted goal');
    expect(adjusted.approach.adjustedForClearance).toBe(true);
    expect(adjusted.approach.selectedCameraDistanceMeters).toBeGreaterThan(APPLE_GOAL_DESIRED_DISTANCE_METERS);
    expect(adjusted.approach.goal.yaw).toBeCloseTo(desired.approach.goal.yaw, 8);
  });

  it('does not invent a goal without valid Depth', () => {
    const plan = planAppleApproachGoal(apple({
      bbox: { centerX: 100, centerY: 120, width: 64, height: 48 },
      centerDistanceSquared: (100 - 160) ** 2,
      distanceMeters: null,
    }), makePose(0, 0), freeGrid());
    expect(plan).toMatchObject({ status: 'unavailable' });
  });
});
