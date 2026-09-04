export const EXPLORATION_COMPLETION_MIN_EXPLORED_RATIO = .9;
export const EXPLORATION_STALL_SUCCESS_WINDOW = 2;
export const EXPLORATION_STALL_MIN_COVERAGE_GAIN_RATIO = .01;
export const EXPLORATION_FAILURES_BEFORE_CORNER_SWEEP = 2;
export const EXPLORATION_FREE_OCCUPANCY_MAX = 20;

export type ExplorationCornerSweepTrigger = 'stalled-success-window' | 'normal-candidates-exhausted' | 'failed-goal-recovery';

export interface ExplorationSweepProgress {
  baselineExploredRatio: number | null;
  successfulGoalCount: number;
  consecutiveGoalFailures: number;
  cornerSweepLatched: boolean;
  cornerSweepTrigger: ExplorationCornerSweepTrigger | null;
  lastWindowGainRatio: number | null;
}

export interface ExplorationCoverage {
  totalCellCount: number;
  freeCellCount: number;
  knownCellCount: number;
  freeRatio: number;
  exploredRatio: number;
}

export function createExplorationSweepProgress(): ExplorationSweepProgress {
  return {
    baselineExploredRatio: null,
    successfulGoalCount: 0,
    consecutiveGoalFailures: 0,
    cornerSweepLatched: false,
    cornerSweepTrigger: null,
    lastWindowGainRatio: null,
  };
}

export function recordExplorationGoalSuccess(
  progress: ExplorationSweepProgress,
): ExplorationSweepProgress {
  if (progress.cornerSweepLatched) return { ...progress, consecutiveGoalFailures: 0 };
  return {
    ...progress,
    successfulGoalCount: progress.successfulGoalCount + 1,
    consecutiveGoalFailures: 0,
  };
}

/**
 * A single failed goal should first try another normal candidate. Repeated
 * failures latch the same safe corner tour used for stalled coverage, before
 * the bounded state-machine retry limit requires explicit user recovery.
 */
export function recordExplorationGoalFailure(
  progress: ExplorationSweepProgress,
  failureLimit = EXPLORATION_FAILURES_BEFORE_CORNER_SWEEP,
): ExplorationSweepProgress {
  if (!Number.isInteger(failureLimit) || failureLimit < 1) {
    throw new RangeError('Exploration failure recovery limit must be a positive integer.');
  }
  if (progress.cornerSweepLatched) return progress;
  const consecutiveGoalFailures = progress.consecutiveGoalFailures + 1;
  if (consecutiveGoalFailures < failureLimit) {
    return { ...progress, consecutiveGoalFailures };
  }
  return {
    ...progress,
    consecutiveGoalFailures,
    cornerSweepLatched: true,
    cornerSweepTrigger: 'failed-goal-recovery',
    lastWindowGainRatio: null,
  };
}

/**
 * Evaluates progress only after two successful goals. A productive two-goal
 * window starts a fresh observed-cell baseline; a gain below one percentage
 * point latches corner sweeping for the remainder of the exploration run.
 */
export function observeExplorationSweepCoverage(
  progress: ExplorationSweepProgress,
  exploredRatio: number,
  successfulGoalWindow = EXPLORATION_STALL_SUCCESS_WINDOW,
  minimumGainRatio = EXPLORATION_STALL_MIN_COVERAGE_GAIN_RATIO,
): ExplorationSweepProgress {
  if (!Number.isFinite(exploredRatio) || exploredRatio < 0 || exploredRatio > 1
    || !Number.isInteger(successfulGoalWindow) || successfulGoalWindow < 1
    || !Number.isFinite(minimumGainRatio) || minimumGainRatio < 0 || minimumGainRatio > 1) {
    throw new RangeError('Exploration sweep progress parameters are outside their supported range.');
  }
  if (progress.cornerSweepLatched) return progress;
  if (progress.baselineExploredRatio === null) return { ...progress, baselineExploredRatio: exploredRatio };
  if (progress.successfulGoalCount < successfulGoalWindow) return progress;
  const gainRatio = exploredRatio - progress.baselineExploredRatio;
  if (gainRatio + Number.EPSILON < minimumGainRatio) {
    return {
      ...progress,
      cornerSweepLatched: true,
      cornerSweepTrigger: 'stalled-success-window',
      lastWindowGainRatio: gainRatio,
    };
  }
  return {
    baselineExploredRatio: exploredRatio,
    successfulGoalCount: 0,
    consecutiveGoalFailures: 0,
    cornerSweepLatched: false,
    cornerSweepTrigger: null,
    lastWindowGainRatio: gainRatio,
  };
}

/**
 * Visit suppression can exhaust all novel normal goals before a second goal
 * succeeds. Below the completion ratio, that is a deterministic reason to try
 * the direct safe corner tour instead of waiting forever on the same map.
 */
export function latchCornerSweepForCandidateExhaustion(
  progress: ExplorationSweepProgress,
  exploredRatio: number,
  normalCandidateCount: number,
  successfulVisitCount: number,
  completionRatio = EXPLORATION_COMPLETION_MIN_EXPLORED_RATIO,
): ExplorationSweepProgress {
  if (!Number.isFinite(exploredRatio) || exploredRatio < 0 || exploredRatio > 1
    || !Number.isInteger(normalCandidateCount) || normalCandidateCount < 0
    || !Number.isInteger(successfulVisitCount) || successfulVisitCount < 0
    || !Number.isFinite(completionRatio) || completionRatio < 0 || completionRatio > 1) {
    throw new RangeError('Exploration candidate exhaustion ratios are outside their supported range.');
  }
  if (progress.cornerSweepLatched
    || normalCandidateCount > 0
    || exploredRatio + Number.EPSILON >= completionRatio) return progress;
  return {
    ...progress,
    cornerSweepLatched: true,
    cornerSweepTrigger: 'normal-candidates-exhausted',
    lastWindowGainRatio: null,
  };
}

export function summarizeExplorationCoverage(
  totalCellCount: number,
  freeCellCount: number,
  knownCellCount: number,
): ExplorationCoverage {
  if (!Number.isInteger(totalCellCount) || totalCellCount <= 0) {
    throw new RangeError('totalCellCount must be a positive integer.');
  }
  if (!Number.isInteger(freeCellCount) || freeCellCount < 0 || freeCellCount > totalCellCount) {
    throw new RangeError('freeCellCount must be between 0 and totalCellCount.');
  }
  if (!Number.isInteger(knownCellCount) || knownCellCount < freeCellCount || knownCellCount > totalCellCount) {
    throw new RangeError('knownCellCount must be between freeCellCount and totalCellCount.');
  }
  return {
    totalCellCount,
    freeCellCount,
    knownCellCount,
    freeRatio: freeCellCount / totalCellCount,
    exploredRatio: knownCellCount / totalCellCount,
  };
}

export function summarizeExplorationCoverageFromOccupancyGrid(
  data: ArrayLike<number>,
  freeOccupancyMax = EXPLORATION_FREE_OCCUPANCY_MAX,
): ExplorationCoverage {
  if (!Number.isInteger(data.length) || data.length <= 0) {
    throw new RangeError('OccupancyGrid data must contain at least one cell.');
  }
  if (!Number.isFinite(freeOccupancyMax) || freeOccupancyMax < 0 || freeOccupancyMax >= 100) {
    throw new RangeError('freeOccupancyMax must be between 0 and 99.');
  }
  let freeCellCount = 0;
  let knownCellCount = 0;
  for (let index = 0; index < data.length; index += 1) {
    const value = Number(data[index]);
    if (!Number.isFinite(value) || value < 0) continue;
    knownCellCount += 1;
    if (value <= freeOccupancyMax) freeCellCount += 1;
  }
  return summarizeExplorationCoverage(data.length, freeCellCount, knownCellCount);
}

export function explorationCoverageAllowsCompletion(
  exploredRatio: number,
  minimumExploredRatio = EXPLORATION_COMPLETION_MIN_EXPLORED_RATIO,
): boolean {
  return Number.isFinite(exploredRatio)
    && Number.isFinite(minimumExploredRatio)
    && minimumExploredRatio >= 0
    && minimumExploredRatio <= 1
    && exploredRatio >= minimumExploredRatio;
}
