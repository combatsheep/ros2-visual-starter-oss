import { describe, expect, it } from 'vitest';
import { DEFAULT_PLAYGROUND } from '../src/playground';
import { lidarWorldHeight, ROBOT_CIRCUMSCRIBED_RADIUS_METERS, ROBOT_FOOTPRINT, ROBOT_GEOMETRY, ROBOT_SAFE_STOP_DISTANCE_METERS, wheelGroundClearance } from '../src/robotGeometry';

describe('robot geometry', () => {
  it('keeps the reduced footprint inside the default gate opening', () => {
    const gate = DEFAULT_PLAYGROUND.objects.find((object) => object.kind === 'gate');
    expect(gate).toBeDefined();
    const postWidth = Math.min(gate!.size.depth, gate!.size.width / 4);
    const openingWidth = gate!.size.width - postWidth;

    expect(ROBOT_FOOTPRINT).toEqual({ lengthMeters: .32, widthMeters: .4 });
    expect(openingWidth).toBeGreaterThan(ROBOT_FOOTPRINT.widthMeters);
    expect(ROBOT_SAFE_STOP_DISTANCE_METERS).toBeGreaterThan(ROBOT_CIRCUMSCRIBED_RADIUS_METERS);
  });

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
