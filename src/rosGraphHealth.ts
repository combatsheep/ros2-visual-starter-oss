import type { RosLifecycleManagerActivity } from './types';

export type RosLifecycleManagerName = keyof RosLifecycleManagerActivity;

export interface RosGraphHealthResult {
  missing: string[];
  forbidden: string[];
  notActiveLifecycleManagers: string[];
  consecutiveMissingChecks: number;
  shouldStop: boolean;
  ready: boolean;
}

export interface ExplorationReadinessHealthResult {
  ready: boolean;
  consecutiveFailureChecks: number;
  shouldInvalidateReadiness: boolean;
}

export type RosGraphRuntimeMode = 'sim' | 'base' | 'mapping' | 'navigation' | 'exploration';

export interface RosGraphRule {
  required: readonly string[];
  forbidden: readonly string[];
  requiredLifecycleManagers: readonly RosLifecycleManagerName[];
}

const BASE_REQUIRED = ['/safety_controller', '/command_gate', '/map_library', '/rosbridge_websocket'] as const;
const MAPPING_NODES = ['/slam_toolbox', '/map_saver', '/lifecycle_manager_mapping'] as const;
const LOCALIZATION_NODES = ['/map_server', '/amcl'] as const;
const NAV2_NODES = ['/controller_server', '/planner_server', '/behavior_server', '/bt_navigator', '/lifecycle_manager_navigation'] as const;
const DEFERRED_NAV2_NODES = ['/navigation_lifecycle_coordinator'] as const;
const UNKNOWN_LIFECYCLE_MANAGERS: RosLifecycleManagerActivity = { mapping: null, navigation: null };
const LIFECYCLE_MANAGER_NODES: Readonly<Record<RosLifecycleManagerName, string>> = {
  mapping: '/lifecycle_manager_mapping',
  navigation: '/lifecycle_manager_navigation',
};

const without = (all: readonly string[], selected: readonly string[]): string[] => {
  const selectedSet = new Set(selected);
  return all.filter((node) => !selectedSet.has(node));
};

const modeSpecificNodes = [...MAPPING_NODES, ...LOCALIZATION_NODES, ...NAV2_NODES, ...DEFERRED_NAV2_NODES];

export const ROS_GRAPH_RULES: Readonly<Record<RosGraphRuntimeMode, RosGraphRule>> = {
  sim: { required: [], forbidden: modeSpecificNodes, requiredLifecycleManagers: [] },
  base: { required: BASE_REQUIRED, forbidden: modeSpecificNodes, requiredLifecycleManagers: [] },
  mapping: {
    required: [...BASE_REQUIRED, ...MAPPING_NODES],
    forbidden: without(modeSpecificNodes, MAPPING_NODES),
    requiredLifecycleManagers: ['mapping'],
  },
  navigation: {
    required: [...BASE_REQUIRED, ...LOCALIZATION_NODES, ...NAV2_NODES],
    forbidden: without(modeSpecificNodes, [...LOCALIZATION_NODES, ...NAV2_NODES]),
    requiredLifecycleManagers: ['navigation'],
  },
  exploration: {
    required: [...BASE_REQUIRED, ...MAPPING_NODES, ...NAV2_NODES, ...DEFERRED_NAV2_NODES],
    forbidden: [...LOCALIZATION_NODES],
    requiredLifecycleManagers: ['mapping', 'navigation'],
  },
};

export function rosGraphRuleForMode(mode: RosGraphRuntimeMode): RosGraphRule {
  return ROS_GRAPH_RULES[mode];
}

export function evaluateRosGraphHealth(
  required: readonly string[],
  available: readonly string[],
  previousMissingChecks: number,
  graceChecks = 2,
  forbiddenNodes: readonly string[] = [],
  requiredLifecycleManagers: readonly RosLifecycleManagerName[] = [],
  lifecycleManagers: RosLifecycleManagerActivity = UNKNOWN_LIFECYCLE_MANAGERS,
): RosGraphHealthResult {
  const missing = required.filter((node) => !available.includes(node));
  const forbidden = forbiddenNodes.filter((node) => available.includes(node));
  const notActiveLifecycleManagers = requiredLifecycleManagers
    .filter((manager) => lifecycleManagers[manager] !== true)
    .map((manager) => LIFECYCLE_MANAGER_NODES[manager]);
  const ready = missing.length === 0 && forbidden.length === 0 && notActiveLifecycleManagers.length === 0;
  if (missing.length === 0 && forbidden.length === 0 && notActiveLifecycleManagers.length === 0) {
    return { missing, forbidden, notActiveLifecycleManagers, consecutiveMissingChecks: 0, shouldStop: false, ready };
  }
  const consecutiveMissingChecks = Math.min(previousMissingChecks + 1, graceChecks);
  return {
    missing,
    forbidden,
    notActiveLifecycleManagers,
    consecutiveMissingChecks,
    shouldStop: previousMissingChecks < graceChecks && consecutiveMissingChecks >= graceChecks,
    ready,
  };
}

export function evaluateRuntimeRosGraphHealth(
  mode: RosGraphRuntimeMode,
  available: readonly string[],
  previousMissingChecks: number,
  lifecycleManagers: RosLifecycleManagerActivity = UNKNOWN_LIFECYCLE_MANAGERS,
  graceChecks = 2,
): RosGraphHealthResult {
  const rule = rosGraphRuleForMode(mode);
  return evaluateRosGraphHealth(
    rule.required,
    available,
    previousMissingChecks,
    graceChecks,
    rule.forbidden,
    rule.requiredLifecycleManagers,
    lifecycleManagers,
  );
}

/**
 * Adds a bounded grace period around exploration graph health.  In particular,
 * a transient null response from either lifecycle-manager service must not
 * invalidate a readiness cycle that has already accepted Nav2 health once.
 */
export function evaluateExplorationReadinessHealth(
  graphHealth: Pick<RosGraphHealthResult, 'ready'>,
  hasNavigateToPose: boolean,
  previousFailureChecks: number,
  readinessHasNavigationEvidence: boolean,
  graceChecks = 2,
): ExplorationReadinessHealthResult {
  const boundedGraceChecks = Math.max(1, Math.floor(graceChecks));
  const boundedPreviousChecks = Math.max(0, Math.min(Math.floor(previousFailureChecks), boundedGraceChecks));
  const ready = graphHealth.ready && hasNavigateToPose;
  if (ready) return { ready, consecutiveFailureChecks: 0, shouldInvalidateReadiness: false };
  const consecutiveFailureChecks = Math.min(boundedPreviousChecks + 1, boundedGraceChecks);
  return {
    ready,
    consecutiveFailureChecks,
    shouldInvalidateReadiness: readinessHasNavigationEvidence
      && boundedPreviousChecks < boundedGraceChecks
      && consecutiveFailureChecks >= boundedGraceChecks,
  };
}
