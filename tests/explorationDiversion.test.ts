import { describe, expect, it } from 'vitest';
import {
  BackupActionStatusTracker,
  EXPLORATION_DIVERSION_DEFAULT_ENABLED,
  EXPLORATION_DIVERSION_MIN_DISTANCE_METERS,
  explorationDiversionEnabledFromStorage,
  selectExplorationDiversionCandidate,
} from '../src/explorationDiversion';
import type { FrontierCandidate } from '../src/frontierExploration';
import type { GoalStatusArrayMessage } from '../src/types';

function candidate(id: string, x: number, y = 0): FrontierCandidate {
  return {
    id,
    clusterId: `cluster-${id}`,
    clusterCellIndices: Int32Array.of(1),
    cell: { index: 1, x: 1, y: 1 },
    world: { x, y, yaw: 0 },
    metrics: { informationGain: 10, pathDistanceMeters: Math.hypot(x, y), clearanceMeters: 1, score: 10 },
  };
}

function statusMessage(entries: Array<{ id: number; status: number }>): GoalStatusArrayMessage {
  return {
    status_list: entries.map((entry) => ({
      goal_info: {
        goal_id: { uuid: [entry.id, ...Array<number>(15).fill(0)] },
        stamp: { sec: 1, nanosec: 0 },
      },
      status: entry.status,
    })),
  };
}

describe('detachable exploration recovery diversion', () => {
  it('defaults to off while preserving an explicit browser choice', () => {
    expect(EXPLORATION_DIVERSION_DEFAULT_ENABLED).toBe(false);
    expect(explorationDiversionEnabledFromStorage(null)).toBe(false);
    expect(explorationDiversionEnabledFromStorage('off')).toBe(false);
    expect(explorationDiversionEnabledFromStorage('on')).toBe(true);
  });

  it('selects the single farthest candidate from the previous goal', () => {
    const candidates = [
      candidate('near', .8),
      candidate('far-a', 4),
      candidate('far-b', 4.5),
      candidate('medium', 2.2),
    ];

    const selected = selectExplorationDiversionCandidate(candidates, { x: 0, y: 0 });

    expect(EXPLORATION_DIVERSION_MIN_DISTANCE_METERS).toBe(2);
    expect(selected).toMatchObject({ candidate: { id: 'far-b' }, minimumDistanceSatisfied: true });
  });

  it('uses the farthest available place on a small map and never selects the same point', () => {
    const fallback = selectExplorationDiversionCandidate([
      candidate('near', .4),
      candidate('farthest', 1.3),
      candidate('almost-farthest', 1.15),
    ], { x: 0, y: 0 });

    expect(fallback).toMatchObject({ candidate: { id: 'farthest' }, minimumDistanceSatisfied: false });
    expect(selectExplorationDiversionCandidate([candidate('same', 0)], { x: 0, y: 0 })).toBeNull();
  });

  it('fires once only after observing the same BackUp goal active and then succeeded', () => {
    const tracker = new BackupActionStatusTracker();

    expect(tracker.observe(statusMessage([{ id: 9, status: 4 }]))).toEqual({ activeGoalIds: [], succeededGoalIds: [] });
    expect(tracker.observe(statusMessage([{ id: 7, status: 2 }]))).toEqual({
      activeGoalIds: ['07000000000000000000000000000000'],
      succeededGoalIds: [],
    });
    expect(tracker.observe(statusMessage([{ id: 7, status: 4 }]))).toEqual({
      activeGoalIds: [],
      succeededGoalIds: ['07000000000000000000000000000000'],
    });
    expect(tracker.observe(statusMessage([{ id: 7, status: 4 }]))).toEqual({ activeGoalIds: [], succeededGoalIds: [] });
  });
});
