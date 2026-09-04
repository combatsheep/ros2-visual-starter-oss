import type { FrontierCandidate, FrontierPoint } from './frontierExploration';
import type { GoalStatusArrayMessage, GoalStatusMessage } from './types';

export const EXPLORATION_DIVERSION_MIN_DISTANCE_METERS = 2;
export const EXPLORATION_DIVERSION_DEFAULT_ENABLED = false;
const MAX_TRACKED_BACKUP_GOALS = 64;

const GOAL_STATUS_ACTIVE = new Set([1, 2, 3]);
const GOAL_STATUS_SUCCEEDED = 4;
const GOAL_STATUS_TERMINAL = new Set([4, 5, 6]);

export interface ExplorationDiversionSelection {
  candidate: FrontierCandidate;
  distanceMeters: number;
  minimumDistanceSatisfied: boolean;
}

export interface BackupActionStatusObservation {
  activeGoalIds: string[];
  succeededGoalIds: string[];
}

export function explorationDiversionEnabledFromStorage(storedValue: string | null): boolean {
  if (storedValue === 'on') return true;
  if (storedValue === 'off') return false;
  return EXPLORATION_DIVERSION_DEFAULT_ENABLED;
}

function candidateDistance(candidate: FrontierCandidate, previousGoal: FrontierPoint): number {
  return Math.hypot(candidate.world.x - previousGoal.x, candidate.world.y - previousGoal.y);
}

/** Selects the single farthest eligible frontier from the previous goal. */
export function selectExplorationDiversionCandidate(
  candidates: readonly FrontierCandidate[],
  previousGoal: FrontierPoint,
  minimumDistanceMeters = EXPLORATION_DIVERSION_MIN_DISTANCE_METERS,
): ExplorationDiversionSelection | null {
  const measured = candidates
    .map((candidate) => ({ candidate, distanceMeters: candidateDistance(candidate, previousGoal) }))
    .filter((entry) => Number.isFinite(entry.distanceMeters) && entry.distanceMeters > Number.EPSILON);
  if (measured.length === 0) return null;

  measured.sort((left, right) => {
    if (left.distanceMeters !== right.distanceMeters) return right.distanceMeters - left.distanceMeters;
    if (left.candidate.cell.index !== right.candidate.cell.index) return left.candidate.cell.index - right.candidate.cell.index;
    return left.candidate.id.localeCompare(right.candidate.id);
  });
  const selected = measured[0];
  return selected ? { ...selected, minimumDistanceSatisfied: selected.distanceMeters >= minimumDistanceMeters } : null;
}

function goalStatusId(status: GoalStatusMessage): string | null {
  const uuid = status.goal_info?.goal_id?.uuid;
  if (typeof uuid === 'string') return uuid.length > 0 ? uuid : null;
  if (!Array.isArray(uuid) || uuid.length !== 16) return null;
  const bytes = uuid.map((value) => Number(value));
  if (bytes.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  return bytes.map((value) => value.toString(16).padStart(2, '0')).join('');
}

function rememberBounded(values: Set<string>, value: string): void {
  values.add(value);
  while (values.size > MAX_TRACKED_BACKUP_GOALS) {
    const oldest = values.values().next().value as string | undefined;
    if (!oldest) break;
    values.delete(oldest);
  }
}

/** Ignores retained terminal history until the same UUID was seen active. */
export class BackupActionStatusTracker {
  private readonly activeGoalIds = new Set<string>();
  private readonly terminalGoalIds = new Set<string>();

  observe(message: GoalStatusArrayMessage): BackupActionStatusObservation {
    const activated: string[] = [];
    const succeeded: string[] = [];
    for (const status of message.status_list ?? []) {
      const id = goalStatusId(status);
      if (!id) continue;
      if (GOAL_STATUS_ACTIVE.has(status.status)) {
        if (!this.terminalGoalIds.has(id) && !this.activeGoalIds.has(id)) {
          rememberBounded(this.activeGoalIds, id);
          activated.push(id);
        }
        continue;
      }
      if (!GOAL_STATUS_TERMINAL.has(status.status)) continue;
      const wasActive = this.activeGoalIds.delete(id);
      if (status.status === GOAL_STATUS_SUCCEEDED && wasActive && !this.terminalGoalIds.has(id)) succeeded.push(id);
      rememberBounded(this.terminalGoalIds, id);
    }
    return { activeGoalIds: activated, succeededGoalIds: succeeded };
  }
}
