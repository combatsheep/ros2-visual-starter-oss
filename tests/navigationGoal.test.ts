import { describe, expect, it } from 'vitest';
import { cellCenterToWorld, type FrontierGrid } from '../src/frontierExploration';
import { adjustNavigationGoalForObstacleBeyond } from '../src/navigationGoal';

function gridWith(fill = 0): FrontierGrid {
  return {
    width: 20,
    height: 12,
    resolution: .1,
    data: new Int8Array(20 * 12).fill(fill),
  };
}

function setCell(grid: FrontierGrid, x: number, y: number, value: number): void {
  (grid.data as Int8Array)[x + y * grid.width] = value;
}

describe('adjustNavigationGoalForObstacleBeyond', () => {
  it('keeps a goal unchanged when known-free space continues beyond it', () => {
    const grid = gridWith();
    const robot = cellCenterToWorld(grid, { x: 3, y: 6 });
    const target = cellCenterToWorld(grid, { x: 10, y: 6 });
    const result = adjustNavigationGoalForObstacleBeyond(grid, robot, { ...target, yaw: .25 });

    expect(result.adjusted).toBe(false);
    expect(result.goal).toEqual({ ...target, yaw: .25 });
    expect(result.retreatMeters).toBe(0);
  });

  it.each([
    ['wall', 100, 'occupied'],
    ['unknown', -1, 'unknown'],
  ] as const)('moves a goal toward the robot when %s is immediately beyond it', (_label, occupancy, kind) => {
    const grid = gridWith();
    const robot = cellCenterToWorld(grid, { x: 1, y: 6 });
    const target = cellCenterToWorld(grid, { x: 10, y: 6 });
    setCell(grid, 13, 6, occupancy);

    const result = adjustNavigationGoalForObstacleBeyond(grid, robot, { ...target, yaw: .5 });

    expect(result.adjusted).toBe(true);
    expect(result.obstacleKind).toBe(kind);
    expect(result.retreatMeters).toBeGreaterThanOrEqual(.12);
    expect(result.retreatMeters).toBeLessThanOrEqual(.30);
    expect(result.goal.x).toBeLessThan(target.x);
    expect(result.goal.y).toBeCloseTo(target.y);
    expect(result.goal.yaw).toBe(.5);
  });

  it('treats the map edge as an obstacle beyond the goal', () => {
    const grid = gridWith();
    const robot = cellCenterToWorld(grid, { x: 10, y: 6 });
    const target = cellCenterToWorld(grid, { x: 17, y: 6 });
    const result = adjustNavigationGoalForObstacleBeyond(grid, robot, { ...target, yaw: 0 }, {
      minimumGoalClearanceMeters: .15,
    });

    expect(result.adjusted).toBe(true);
    expect(result.obstacleKind).toBe('map-boundary');
    expect(result.goal.x).toBeLessThan(target.x);
  });

  it('uses world coordinates correctly for a rotated OccupancyGrid origin', () => {
    const grid = { ...gridWith(), origin: { x: 2, y: -1, yaw: Math.PI / 2 } };
    const robot = cellCenterToWorld(grid, { x: 3, y: 6 });
    const target = cellCenterToWorld(grid, { x: 10, y: 6 });
    setCell(grid, 13, 6, 100);
    const result = adjustNavigationGoalForObstacleBeyond(grid, robot, { ...target, yaw: 1 });

    expect(result.adjusted).toBe(true);
    expect(Math.hypot(result.goal.x - robot.x, result.goal.y - robot.y))
      .toBeLessThan(Math.hypot(target.x - robot.x, target.y - robot.y));
  });

  it('does not invent an unsafe replacement when no retreat cell has enough clearance', () => {
    const grid = gridWith(100);
    for (let x = 3; x <= 13; x += 1) setCell(grid, x, 6, 0);
    const robot = cellCenterToWorld(grid, { x: 3, y: 6 });
    const target = cellCenterToWorld(grid, { x: 10, y: 6 });
    const result = adjustNavigationGoalForObstacleBeyond(grid, robot, { ...target, yaw: 0 });

    expect(result.adjusted).toBe(false);
    expect(result.obstacleKind).toBe('occupied');
    expect(result.goal).toEqual({ ...target, yaw: 0 });
  });

  it('never retreats an exploration goal inside the minimum useful travel distance', () => {
    const grid = gridWith();
    const robot = cellCenterToWorld(grid, { x: 3, y: 6 });
    const target = cellCenterToWorld(grid, { x: 10, y: 6 });
    setCell(grid, 13, 6, 100);

    const result = adjustNavigationGoalForObstacleBeyond(grid, robot, { ...target, yaw: 0 });

    expect(result.adjusted).toBe(true);
    expect(Math.hypot(result.goal.x - robot.x, result.goal.y - robot.y)).toBeGreaterThanOrEqual(.5);
    expect(result.retreatMeters).toBeCloseTo(.2);
  });
});
