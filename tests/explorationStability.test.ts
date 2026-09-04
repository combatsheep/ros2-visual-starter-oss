import { describe, expect, it } from 'vitest';
import {
  assessExplorationMapStability,
  EXPLORATION_MAP_MAX_OCCUPANCY_CHANGE_RATIO,
  EXPLORATION_STABLE_MAP_SAMPLE_COUNT,
} from '../src/explorationStability';
import type { OccupancyGridMessage } from '../src/types';

const mapAt = (data: number[], width = 4, height = 2, originX = 0): OccupancyGridMessage => ({
  header: { frame_id: 'map', stamp: { sec: 100, nanosec: 0 } },
  info: {
    map_load_time: { sec: 100, nanosec: 0 },
    resolution: 0.05,
    width,
    height,
    origin: {
      position: { x: originX, y: 0, z: 0 },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
    },
  },
  data,
});

describe('exploration map stability', () => {
  it('requires three consecutive samples before allowing an Object Search goal', () => {
    const map = mapAt([0, 0, 0, 0, -1, -1, -1, -1]);
    expect(assessExplorationMapStability([map, map])).toMatchObject({
      stable: false,
      status: 'insufficient-samples',
      sampleCount: 2,
    });
    expect(assessExplorationMapStability([map, map, map])).toEqual({
      stable: true,
      status: 'stable',
      sampleCount: EXPLORATION_STABLE_MAP_SAMPLE_COUNT,
    });
  });

  it('holds while SLAM grows or shifts the map geometry', () => {
    const map = mapAt([0, 0, 0, 0, -1, -1, -1, -1]);
    expect(assessExplorationMapStability([map, map, mapAt([...map.data, -1, -1], 5, 2)])).toMatchObject({
      stable: false,
      status: 'geometry-changing',
    });
    expect(assessExplorationMapStability([map, map, mapAt(map.data, 4, 2, 0.2)])).toMatchObject({
      stable: false,
      status: 'geometry-changing',
    });
  });

  it('holds on a large occupancy rewrite even when map dimensions stay fixed', () => {
    const map = mapAt(new Array(8).fill(0));
    const changed = mapAt(new Array(8).fill(100));
    expect(assessExplorationMapStability([map, changed, changed])).toMatchObject({
      stable: false,
      status: 'occupancy-changing',
    });
    expect(EXPLORATION_MAP_MAX_OCCUPANCY_CHANGE_RATIO).toBeGreaterThan(0);
  });
});
