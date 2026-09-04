import { describe, expect, it } from 'vitest';
import { ROBOT_GEOMETRY } from '../src/robotGeometry';
import { createStarterRobotModel } from '../src/starterRobotModel';

describe('neutral starter robot placeholder', () => {
  it('uses local primitive geometry and preserves the shared wheel floor', () => {
    const model = createStarterRobotModel();

    expect(model.group.name).toBe('starterRobotPlaceholder');
    expect(model.group.userData.placeholder).toBe(true);
    expect(model.wheels).toHaveLength(2);
    for (const wheel of model.wheels) {
      expect(wheel.position.y - ROBOT_GEOMETRY.wheelRadius).toBeCloseTo(-ROBOT_GEOMETRY.bodyCenterHeight, 8);
    }
  });
});
