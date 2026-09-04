import { describe, expect, it } from 'vitest';
import { lidarWorldHeight, ROBOT_GEOMETRY, wheelGroundClearance } from '../src/robotGeometry';

describe('robot geometry', () => {
  it('places the bottom of both wheels on the floor', () => {
    expect(wheelGroundClearance()).toBeCloseTo(0);
  });

  it('emits LiDAR rays from inside the taller cylinder', () => {
    const cylinderCenter = lidarWorldHeight();
    const cylinderBottom = ROBOT_GEOMETRY.bodyCenterHeight + ROBOT_GEOMETRY.lidarCenterLocalY - ROBOT_GEOMETRY.lidarHeight / 2;
    const cylinderTop = ROBOT_GEOMETRY.bodyCenterHeight + ROBOT_GEOMETRY.lidarCenterLocalY + ROBOT_GEOMETRY.lidarHeight / 2;
    const bodyTop = ROBOT_GEOMETRY.bodyCenterHeight + ROBOT_GEOMETRY.bodyHeight / 2;

    expect(cylinderBottom).toBeCloseTo(bodyTop);
    expect(cylinderCenter).toBeGreaterThan(cylinderBottom);
    expect(cylinderCenter).toBeLessThan(cylinderTop);
  });

  it('places the onboard camera at the front base of the LiDAR cylinder', () => {
    const lidarBottom = ROBOT_GEOMETRY.lidarCenterLocalY - ROBOT_GEOMETRY.lidarHeight / 2;

    expect(ROBOT_GEOMETRY.cameraCenterLocalY).toBeGreaterThan(lidarBottom);
    expect(ROBOT_GEOMETRY.cameraCenterLocalY).toBeLessThan(ROBOT_GEOMETRY.lidarCenterLocalY);
    expect(ROBOT_GEOMETRY.cameraViewLocalZ).toBeLessThan(ROBOT_GEOMETRY.cameraLensCenterLocalZ);
    expect(ROBOT_GEOMETRY.cameraLensCenterLocalZ).toBeLessThan(ROBOT_GEOMETRY.cameraHousingCenterLocalZ);
  });

  it('places the larger direction arrow on the front face of the body', () => {
    expect(ROBOT_GEOMETRY.frontArrowLocalY).toBeGreaterThan(-ROBOT_GEOMETRY.bodyHeight / 2);
    expect(ROBOT_GEOMETRY.frontArrowLocalY).toBeLessThan(ROBOT_GEOMETRY.bodyHeight / 2);
    expect(ROBOT_GEOMETRY.frontArrowLocalZ).toBeLessThan(-0.2);
    expect(ROBOT_GEOMETRY.frontArrowRadius).toBeGreaterThan(0.055);
  });
});
