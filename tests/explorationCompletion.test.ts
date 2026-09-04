import { describe, expect, it } from 'vitest';
import {
  EXPLORATION_COMPLETION_MIN_EXPLORED_RATIO,
  EXPLORATION_FAILURES_BEFORE_CORNER_SWEEP,
  EXPLORATION_STALL_MIN_COVERAGE_GAIN_RATIO,
  EXPLORATION_STALL_SUCCESS_WINDOW,
  createExplorationSweepProgress,
  explorationCoverageAllowsCompletion,
  latchCornerSweepForCandidateExhaustion,
  observeExplorationSweepCoverage,
  recordExplorationGoalFailure,
  recordExplorationGoalSuccess,
  summarizeExplorationCoverage,
  summarizeExplorationCoverageFromOccupancyGrid,
} from '../src/explorationCompletion';

describe('exploration completion coverage', () => {
  it('requires 90 percent of the OccupancyGrid to be observed as free or occupied', () => {
    expect(EXPLORATION_COMPLETION_MIN_EXPLORED_RATIO).toBe(.9);
    expect(explorationCoverageAllowsCompletion(.8999)).toBe(false);
    expect(explorationCoverageAllowsCompletion(.9)).toBe(true);
  });

  it('counts observed occupied cells toward exploration while keeping free ratio diagnostic', () => {
    expect(summarizeExplorationCoverage(100, 62, 70)).toEqual({
      totalCellCount: 100,
      freeCellCount: 62,
      knownCellCount: 70,
      freeRatio: .62,
      exploredRatio: .7,
    });
  });

  it('derives live coverage directly from map cells while a goal is moving', () => {
    expect(summarizeExplorationCoverageFromOccupancyGrid([0, 20, 65, -1, 100])).toMatchObject({
      totalCellCount: 5,
      freeCellCount: 2,
      knownCellCount: 4,
      exploredRatio: .8,
    });
  });

  it('reports a fully observed map as 100 percent even when obstacles occupy ten percent', () => {
    const coverage = summarizeExplorationCoverage(100, 90, 100);

    expect(coverage.freeRatio).toBe(.9);
    expect(coverage.exploredRatio).toBe(1);
    expect(explorationCoverageAllowsCompletion(coverage.exploredRatio)).toBe(true);
  });

  it('rejects invalid cell counts and non-finite ratios', () => {
    expect(() => summarizeExplorationCoverage(0, 0, 0)).toThrow(RangeError);
    expect(() => summarizeExplorationCoverage(10, 11, 11)).toThrow(RangeError);
    expect(() => summarizeExplorationCoverage(10, 5, 4)).toThrow(RangeError);
    expect(explorationCoverageAllowsCompletion(Number.NaN)).toBe(false);
  });

  it('latches corner sweeping only after two successes gain less than one percentage point', () => {
    let progress = observeExplorationSweepCoverage(createExplorationSweepProgress(), .58);
    progress = recordExplorationGoalSuccess(progress);
    progress = observeExplorationSweepCoverage(progress, .584);
    expect(progress.cornerSweepLatched).toBe(false);
    progress = recordExplorationGoalSuccess(progress);
    progress = observeExplorationSweepCoverage(progress, .5899);

    expect(EXPLORATION_STALL_SUCCESS_WINDOW).toBe(2);
    expect(EXPLORATION_STALL_MIN_COVERAGE_GAIN_RATIO).toBe(.01);
    expect(progress).toMatchObject({
      successfulGoalCount: 2,
      cornerSweepLatched: true,
      cornerSweepTrigger: 'stalled-success-window',
    });
    expect(progress.lastWindowGainRatio).toBeCloseTo(.0099);
  });

  it('starts a fresh two-success window after sufficient progress and ignores failures/map-only updates', () => {
    let progress = observeExplorationSweepCoverage(createExplorationSweepProgress(), .5);
    progress = observeExplorationSweepCoverage(progress, .505);
    expect(progress.successfulGoalCount).toBe(0);
    progress = recordExplorationGoalSuccess(recordExplorationGoalSuccess(progress));
    progress = observeExplorationSweepCoverage(progress, .51);
    expect(progress).toMatchObject({
      baselineExploredRatio: .51,
      successfulGoalCount: 0,
      cornerSweepLatched: false,
    });
    expect(progress.lastWindowGainRatio).toBeCloseTo(.01);
    progress = recordExplorationGoalSuccess(recordExplorationGoalSuccess(progress));
    progress = observeExplorationSweepCoverage(progress, .515);
    expect(progress.cornerSweepLatched).toBe(true);
  });

  it('latches the corner tour when novel normal goals are exhausted below completion', () => {
    let progress = observeExplorationSweepCoverage(createExplorationSweepProgress(), .89);
    progress = recordExplorationGoalSuccess(progress);
    progress = latchCornerSweepForCandidateExhaustion(progress, .89, 0, 1);

    expect(progress).toMatchObject({
      successfulGoalCount: 1,
      cornerSweepLatched: true,
      cornerSweepTrigger: 'normal-candidates-exhausted',
      lastWindowGainRatio: null,
    });
    expect(latchCornerSweepForCandidateExhaustion(createExplorationSweepProgress(), .89, 1, 1))
      .toEqual(createExplorationSweepProgress());
    expect(latchCornerSweepForCandidateExhaustion(createExplorationSweepProgress(), .8, 0, 0))
      .toMatchObject({
        cornerSweepLatched: true,
        cornerSweepTrigger: 'normal-candidates-exhausted',
      });
    expect(latchCornerSweepForCandidateExhaustion(createExplorationSweepProgress(), .9, 0, 1))
      .toEqual(createExplorationSweepProgress());
  });

  it('tries another normal goal after one failure, then latches safe corner recovery after repeated failures', () => {
    let progress = observeExplorationSweepCoverage(createExplorationSweepProgress(), .8);
    progress = recordExplorationGoalFailure(progress);

    expect(EXPLORATION_FAILURES_BEFORE_CORNER_SWEEP).toBe(2);
    expect(progress).toMatchObject({
      consecutiveGoalFailures: 1,
      cornerSweepLatched: false,
      cornerSweepTrigger: null,
    });

    progress = recordExplorationGoalFailure(progress);
    expect(progress).toMatchObject({
      consecutiveGoalFailures: 2,
      cornerSweepLatched: true,
      cornerSweepTrigger: 'failed-goal-recovery',
    });
  });

  it('resets the consecutive failure window after a successful goal', () => {
    let progress = recordExplorationGoalFailure(createExplorationSweepProgress());
    progress = recordExplorationGoalSuccess(progress);

    expect(progress).toMatchObject({
      successfulGoalCount: 1,
      consecutiveGoalFailures: 0,
      cornerSweepLatched: false,
    });
  });
});
