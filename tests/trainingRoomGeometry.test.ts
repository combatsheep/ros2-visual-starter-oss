import RAPIER from '@dimforge/rapier3d-compat';
import { describe, expect, it } from 'vitest';
import { lidarWorldHeight } from '../src/robotGeometry';
import { GATE_PARTS, partContainsHeight } from '../src/trainingRoomGeometry';

describe('training room gate geometry', () => {
  it('defines a collider-sized part for every visible gate mesh', () => {
    expect(GATE_PARTS).toHaveLength(3);
    expect(GATE_PARTS.filter((part) => part.kind === 'post')).toHaveLength(2);
    expect(GATE_PARTS.every((part) => part.width > 0 && part.height > 0 && part.depth > 0)).toBe(true);
  });

  it('places both gate posts across the LiDAR scan plane', () => {
    const scanHeight = lidarWorldHeight();
    const posts = GATE_PARTS.filter((part) => part.kind === 'post');

    expect(posts.every((post) => partContainsHeight(post, scanHeight))).toBe(true);
  });

  it('returns a Rapier LiDAR hit from a gate post collider', async () => {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    GATE_PARTS.forEach((part) => {
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(part.width / 2, part.height / 2, part.depth / 2)
          .setTranslation(part.x, part.y, part.z),
      );
    });
    world.step();
    const ray = new RAPIER.Ray(
      { x: -2.8, y: lidarWorldHeight(), z: 2.15 },
      { x: 0, y: 0, z: -1 },
    );

    const hit = world.castRay(ray, 8, true);

    expect(hit).not.toBeNull();
    expect(hit?.timeOfImpact).toBeCloseTo(0.94, 2);
    world.free();
  });
});
