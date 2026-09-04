import type { ConnectionState, NavigationState, PoseStampedMessage, RuntimeMode } from './types';
import { EXPLORATION_COMPLETION_MIN_EXPLORED_RATIO, explorationCoverageAllowsCompletion } from './explorationCompletion';
import {
  appleDetectionIsWithinSearchRange,
  APPLE_POSTSTOP_WINDOW_FRAMES,
  createAppleDetectionTracker,
  observeAppleDetectionFrame,
  resetAppleDetectionTrackerForPostStop,
  type AppleDetectionEvidence,
  type AppleDetectionInput,
  type AppleDetectionTracker,
} from './objectSearchDetection';
import type { AppleApproachGoal } from './objectSearchApproach';
import { getObjectSearchTarget, type ObjectSearchTargetClass } from './objectSearchTargets';

export interface RuntimeManagerState {
  mode: RuntimeMode;
  target: RuntimeMode;
  processing: boolean;
  phase: string;
  error: string;
  backendAlive: boolean;
}

export type RuntimeLifecycle =
  | { status: 'stable'; mode: RuntimeMode }
  | { status: 'switching'; mode: RuntimeMode; target: RuntimeMode; phase: 'processing' | 'closing' }
  | { status: 'error'; mode: RuntimeMode; target: RuntimeMode; message: string };

export type MapReadiness =
  | { status: 'unavailable'; cycle: number }
  | { status: 'initializing'; target: 'mapping' | 'navigation' | 'exploration'; reason: 'runtime-switch' | 'reconnect' | 'map-reset' | 'navigation-health'; mapReceived: boolean; poseReceived: boolean; navigationReceived: boolean; cycle: number }
  | { status: 'ready'; mode: 'mapping' | 'navigation' | 'exploration'; cycle: number }
  | { status: 'resetting'; phase: 'switching-to-mapping' | 'requesting-reset'; cycle: number }
  | { status: 'error'; target: 'mapping' | 'navigation' | 'exploration'; message: string; cycle: number };

export type CommandOwnership =
  | { owner: 'manual' }
  | { owner: 'navigation' }
  | { owner: 'stopped'; reason: 'runtime-switch' | 'map-initialization' | 'map-error' | 'transport' | 'stage' | 'runtime-error' };

export interface PendingCommandOwner {
  owner: 'navigation';
  requestedAtMs: number;
  expiresAtMs: number;
  acknowledged: boolean;
}

export interface SafetyState {
  stopped: boolean;
}

export type ViewState =
  | { mode: 'sim' }
  | { mode: 'stage'; surface: 'plan' | 'orbit'; gesture: 'idle' | 'active' };

export type NavigationTask =
  | { status: 'idle'; taskId: number }
  | { status: 'sending'; taskId: number; source: 'operator' | 'exploration' | 'object-search'; goalId: string | null }
  | { status: 'moving'; taskId: number; source: 'operator' | 'exploration' | 'object-search'; goalId: string | null }
  | { status: 'succeeded'; taskId: number; source: 'operator' | 'exploration' | 'object-search' }
  | { status: 'canceled'; taskId: number; source: 'operator' | 'exploration' | 'object-search' }
  | { status: 'failed'; taskId: number; source: 'operator' | 'exploration' | 'object-search'; error: string };

export interface ExplorationRunContext {
  generation: number;
  goalPolicy: ExplorationGoalPolicy;
  mapCycle: number;
  lastMapGeneration: number;
  retryCount: number;
  replanCount: number;
  noCandidateConfirmations: number;
  blacklistedCandidateIds: readonly string[];
}

export interface ExplorationEvidence {
  cycle: number;
  mapGeneration: number;
  mapObservedAtMs: number | null;
  poseObservedAtMs: number | null;
}

export interface ExplorationFreshnessRequest {
  mapGeneration: number;
  nowMs: number;
}

export type ExplorationGoalPolicy = 'coverage' | 'object-search';

export interface ExplorationSelectedGoal {
  candidateId: string;
  mapGeneration: number;
  goal: PoseStampedMessage;
}

export type ExplorationPauseReason =
  | 'user'
  | 'origin-reset'
  | 'manual-override'
  | 'operator-conflict'
  | 'safety-stop'
  | 'navigation-unavailable'
  | 'control-lease'
  | 'vision'
  | 'object-found-candidate'
  | 'stage'
  | 'runtime-change'
  | 'transport';

export type ExplorationNoCandidateReason =
  | 'no-frontiers'
  | 'no-eligible-candidates'
  | 'robot-out-of-bounds'
  | 'robot-not-free'
  | 'robot-insufficient-clearance'
  | 'blacklist-cooldown';

export type ExplorationReplanReason =
  | 'goal-succeeded'
  | 'goal-failed'
  | 'goal-canceled'
  | 'navigation-transform-stale'
  | 'navigation-recovery'
  | 'recovery-diversion'
  | 'no-candidates'
  | 'frontiers-unresolved'
  | 'coverage-insufficient'
  | 'candidate-evidence-unavailable'
  | 'candidate-cooldown';

export type ExplorationState =
  | { status: 'idle'; generation: number }
  | (ExplorationRunContext & { status: 'evaluating'; mapGeneration: number })
  | (ExplorationRunContext & { status: 'sending'; taskId: number; selected: ExplorationSelectedGoal })
  | (ExplorationRunContext & { status: 'moving'; taskId: number; selected: ExplorationSelectedGoal })
  | (ExplorationRunContext & { status: 'replanning'; reason: ExplorationReplanReason; afterMapGeneration: number; requireFreshMap: boolean })
  | (ExplorationRunContext & { status: 'paused'; reason: ExplorationPauseReason; resumeAfterMapGeneration: number })
  | (ExplorationRunContext & { status: 'completed'; confirmedMapGeneration: number })
  | (ExplorationRunContext & { status: 'error'; message: string; recoverable: true; resumeAfterMapGeneration: number });

export interface ControlLeaseState {
  owner: boolean;
  generation: number;
}

export type VisionReadinessStatus = 'unavailable' | 'initializing' | 'ready' | 'error';

export interface VisionReadinessState {
  status: VisionReadinessStatus;
  cycle: number;
  modelReady: boolean;
  statusObservedAtMs: number | null;
  frameObservedAtMs: number | null;
  detectorObservedAtMs: number | null;
  detectorFrameObservedAtMs: number | null;
  synchronizedFrameObservedAtMs: number | null;
  synchronizedDetectorObservedAtMs: number | null;
  message: string;
}

export type ObjectSearchPauseReason =
  | 'user'
  | 'safety-stop'
  | 'transport'
  | 'runtime-change'
  | 'control-lease'
  | 'stage'
  | 'origin-reset'
  | 'manual-override'
  | 'navigation-unavailable'
  | 'target-lost'
  | 'vision';

export interface ObjectSearchStopEvidence {
  manualOwnerAcknowledgedAtMs: number | null;
  zeroVelocitySampleObservedAtMs: readonly number[];
  lastMotionObservedAtMs: number | null;
}

export interface ObjectSearchRunContext {
  missionId: number;
  generation: number;
  targetClass: ObjectSearchTargetClass;
  displayName: string;
  normalizedCommand: string;
  requestedAtMs: number;
  mapCycle: number;
  explorationGeneration: number | null;
  visionCycle: number;
  transportCycle: number;
  controlLeaseGeneration: number;
  runtimePreparationPending: boolean;
  lostCount: number;
  detectionTracker: AppleDetectionTracker;
  lastChatStatus: string;
}

export type ObjectSearchState =
  | { status: 'idle'; generation: number }
  | (ObjectSearchRunContext & { status: 'preparing' })
  | (ObjectSearchRunContext & { status: 'searching'; explorationGeneration: number })
  | (ObjectSearchRunContext & { status: 'candidate'; candidate: AppleDetectionEvidence; candidateConfirmedAtMs: number; positionConfirmed: boolean })
  | (ObjectSearchRunContext & { status: 'approaching'; candidate: AppleDetectionEvidence; approach: AppleApproachGoal; taskId: number; approachRequestedAtMs: number })
  | (ObjectSearchRunContext & { status: 'stopping'; candidate: AppleDetectionEvidence; stopRequestedAtMs: number; stopEvidence: ObjectSearchStopEvidence })
  | (ObjectSearchRunContext & { status: 'confirming'; candidate: AppleDetectionEvidence; stoppedAtMs: number; stopEvidence: ObjectSearchStopEvidence })
  | (ObjectSearchRunContext & { status: 'succeeded'; stoppedAtMs: number; foundAtMs: number; evidence: AppleDetectionEvidence; stopEvidence: ObjectSearchStopEvidence })
  | (ObjectSearchRunContext & { status: 'paused'; reason: ObjectSearchPauseReason; resumeAfterMapGeneration: number })
  | (ObjectSearchRunContext & { status: 'finalizing'; reason: 'exploration-completed'; finalizationStartedAtMs: number; stopEvidence: ObjectSearchStopEvidence })
  | (ObjectSearchRunContext & { status: 'not_found'; notFoundAtMs: number; confirmedMapGeneration: number })
  | (ObjectSearchRunContext & { status: 'canceled'; canceledAtMs: number })
  | (ObjectSearchRunContext & { status: 'error'; message: string; recoverable: boolean });

export interface AppState {
  runtime: RuntimeLifecycle;
  map: MapReadiness;
  command: CommandOwnership;
  pendingCommandOwner: PendingCommandOwner | null;
  transport: ConnectionState;
  transportCycle: number;
  view: ViewState;
  navigation: NavigationTask;
  exploration: ExplorationState;
  explorationEvidence: ExplorationEvidence;
  controlLease: ControlLeaseState;
  vision: VisionReadinessState;
  objectSearch: ObjectSearchState;
  safety: SafetyState;
  nextMapCycle: number;
  nextTaskId: number;
  nextObjectSearchMissionId: number;
}

export type AppEvent =
  | { type: 'RUNTIME_SWITCH_REQUESTED'; target: RuntimeMode }
  | { type: 'RUNTIME_MANAGER_OBSERVED'; snapshot: RuntimeManagerState }
  | { type: 'TRANSPORT_CHANGED'; connection: ConnectionState; detail?: string }
  | { type: 'MAP_RECEIVED'; cycle: number }
  | { type: 'POSE_READY'; cycle: number }
  | { type: 'NAVIGATION_READY'; cycle: number }
  | { type: 'NAVIGATION_UNAVAILABLE'; cycle: number; status: string }
  | { type: 'MAP_RESET_REQUESTED' }
  | { type: 'MAP_RESET_COMPLETED'; success: boolean; error?: string }
  | { type: 'VIEW_REQUESTED'; view: 'sim' | 'stage' }
  | { type: 'STAGE_SURFACE_REQUESTED'; surface: 'plan' | 'orbit' }
  | { type: 'STAGE_GESTURE_CHANGED'; active: boolean }
  | { type: 'ROBOT_ORIGIN_RESET_REQUESTED' }
  | { type: 'COMMAND_OWNER_REQUESTED'; owner: 'manual' | 'navigation'; requestedAtMs: number }
  | { type: 'COMMAND_OWNER_OBSERVED'; owner: 'manual' | 'navigation'; observedAtMs: number }
  | { type: 'NAVIGATION_GOAL_REQUESTED'; goal: PoseStampedMessage; requestedAtMs: number }
  | { type: 'NAVIGATION_GOAL_ACCEPTED'; taskId: number; goalId: string }
  | { type: 'NAVIGATION_GOAL_FEEDBACK'; taskId: number }
  | { type: 'NAVIGATION_GOAL_SUCCEEDED'; taskId: number; completedAtMs?: number }
  | { type: 'NAVIGATION_GOAL_FAILED'; taskId: number; error: string; canceled: boolean; transient?: 'stale-transform' | 'navigation-recovery' }
  | { type: 'NAVIGATION_GOAL_CANCEL_REQUESTED'; status: string }
  | { type: 'EXPLORATION_MAP_OBSERVED'; cycle: number; mapGeneration: number; observedAtMs: number }
  | { type: 'EXPLORATION_POSE_OBSERVED'; cycle: number; observedAtMs: number }
  | { type: 'EXPLORATION_START_REQUESTED'; mapGeneration: number; requestedAtMs: number; goalPolicy?: ExplorationGoalPolicy }
  | { type: 'EXPLORATION_EVALUATION_REQUESTED'; generation: number; mapGeneration: number }
  | { type: 'EXPLORATION_GOAL_REQUESTED'; generation: number; mapGeneration: number; candidateId: string; goal: PoseStampedMessage; requestedAtMs: number }
  | { type: 'EXPLORATION_NO_CANDIDATES'; generation: number; mapGeneration: number; reason: ExplorationNoCandidateReason; exploredCoverageRatio: number; recoveryExhausted?: boolean }
  | { type: 'EXPLORATION_RECOVERY_DIVERSION_REQUESTED'; taskId: number }
  | { type: 'EXPLORATION_PAUSE_REQUESTED'; status?: string }
  | { type: 'EXPLORATION_RESUME_REQUESTED'; mapGeneration: number; requestedAtMs: number; goalPolicy?: ExplorationGoalPolicy }
  | { type: 'EXPLORATION_STOP_REQUESTED'; status?: string }
  | { type: 'EXPLORATION_ERROR_REPORTED'; generation: number; error: string }
  | { type: 'CONTROL_LEASE_CHANGED'; owner: boolean; changedAtMs: number }
  | { type: 'VISION_STATUS_OBSERVED'; cycle: number; status: 'ready' | 'initializing' | 'unavailable' | 'error'; observedAtMs: number; error?: string }
  | { type: 'VISION_FRAME_OBSERVED'; cycle: number; observedAtMs: number }
  | { type: 'VISION_DETECTOR_OBSERVED'; cycle: number; observedAtMs: number; frameObservedAtMs: number }
  | { type: 'OBJECT_SEARCH_COMMAND_REQUESTED'; targetClass: ObjectSearchTargetClass; displayName: string; normalizedCommand: string; requestedAtMs: number }
  | { type: 'OBJECT_SEARCH_ADVANCE_REQUESTED'; generation: number; visionCycle: number; mapCycle: number; mapGeneration: number; explorationGeneration: number; requestedAtMs: number }
  | { type: 'OBJECT_SEARCH_RESUME_REQUESTED'; generation: number; visionCycle: number; mapCycle: number; mapGeneration: number; explorationGeneration: number; requestedAtMs: number }
  | { type: 'OBJECT_SEARCH_CANCEL_REQUESTED'; generation: number; requestedAtMs: number }
  | { type: 'OBJECT_SEARCH_HEALTH_CHECK_REQUESTED'; generation: number; requestedAtMs: number }
  | { type: 'OBJECT_SEARCH_DETECTION_OBSERVED'; generation: number; visionCycle: number; transportCycle: number; explorationGeneration: number; frameStampMs: number; cameraFrameStampMs: number; observedAtMs: number; imageWidth: number; imageHeight: number; detections: readonly AppleDetectionInput[] }
  | { type: 'OBJECT_SEARCH_APPROACH_REQUESTED'; generation: number; visionCycle: number; transportCycle: number; explorationGeneration: number; candidateFrameStampMs: number; requestedAtMs: number; goal: PoseStampedMessage; approach: AppleApproachGoal }
  | { type: 'OBJECT_SEARCH_APPROACH_UNAVAILABLE'; generation: number; candidateFrameStampMs: number; requestedAtMs: number; reason: string }
  | { type: 'OBJECT_SEARCH_SAFE_STOP_REQUESTED'; generation: number; visionCycle: number; transportCycle: number; explorationGeneration: number; candidateFrameStampMs: number; requestedAtMs: number }
  | { type: 'ROBOT_MOTION_OBSERVED'; generation: number; transportCycle: number; observedAtMs: number; linearX: number; angularZ: number }
  | { type: 'SAFETY_CHANGED'; stopped: boolean; status?: string }
  | { type: 'WINDOW_FOCUS_LOST' }
  | { type: 'SAFE_STOP_REQUESTED'; status: string };

export type AppEffect =
  | { type: 'RELEASE_USER_INPUT' }
  | { type: 'ZERO_VELOCITY' }
  | { type: 'CANCEL_NAVIGATION_GOAL' }
  | { type: 'SET_COMMAND_OWNER'; owner: 'manual' | 'navigation' }
  | { type: 'CLEAR_GOAL_DATA' }
  | { type: 'CLEAR_RUNTIME_DATA' }
  | { type: 'RESET_NAVIGATION_ORIGIN' }
  | { type: 'RESET_ROBOT_ORIGIN' }
  | { type: 'REQUEST_RUNTIME'; mode: RuntimeMode }
  | { type: 'REQUEST_MAP_RESET' }
  | { type: 'SEND_NAVIGATION_GOAL'; goal: PoseStampedMessage; taskId: number; afterCancelSettles?: boolean }
  | { type: 'EVALUATE_EXPLORATION_MAP'; generation: number; mapGeneration: number; blacklistedCandidateIds: readonly string[] }
  | { type: 'WAIT_FOR_EXPLORATION_MAP'; generation: number; afterMapGeneration: number; requireFreshMap: boolean }
  | { type: 'CLEAR_EXPLORATION_DATA' }
  | { type: 'ENTER_STAGE' }
  | { type: 'EXIT_STAGE' }
  | { type: 'SET_STAGE_SURFACE'; surface: 'plan' | 'orbit' }
  | { type: 'SET_NAVIGATION_STATUS'; message: string }
  | { type: 'SYNC_OBJECT_SEARCH_CHAT'; status: 'idle' | 'accepted' | 'paused'; targetClass: ObjectSearchTargetClass | null; role?: 'robot' | 'system' | 'error'; message?: string }
  | { type: 'ANNOUNCE'; message: string };

export interface TransitionResult {
  state: AppState;
  effects: AppEffect[];
  accepted: boolean;
  rejection?: string;
}

export interface ProcessingModalModel {
  title: string;
  detail: string;
  status: string;
}

export const MAX_EXPLORATION_RETRIES = 8;
export const MAX_EXPLORATION_BLACKLIST_SIZE = 32;
export const EXPLORATION_NO_CANDIDATE_CONFIRMATIONS_REQUIRED = 3;
export const EXPLORATION_POSE_FRESHNESS_MS = 1_800;
export const EXPLORATION_MAP_FRESHNESS_MS = EXPLORATION_POSE_FRESHNESS_MS * 2;
export const COMMAND_OWNER_ACK_TIMEOUT_MS = 750;
export const NAVIGATION_GOAL_CANCEL_SETTLE_MS = 200;
export const VISION_FRAME_FRESHNESS_MS = 1_000;
export const VISION_DETECTOR_FRESHNESS_MS = 2_000;
export const VISION_DETECTION_TO_FRAME_MAX_AGE_MS = 500;
export const APPLE_STOP_MAX_LINEAR_X = .02;
export const APPLE_STOP_MAX_ANGULAR_Z = .03;
export const APPLE_STOP_REQUIRED_ZERO_SAMPLES = 2;
export const APPLE_STOP_EVIDENCE_MAX_AGE_MS = 600;
export const APPLE_MAX_LOST_TARGET_COUNT = 3;

const EXPLORATION_CLOCK_SKEW_TOLERANCE_MS = 1_000;

const runtimeModes = new Set<RuntimeMode>(['sim', 'base', 'mapping', 'navigation', 'exploration']);

export function isRuntimeMode(value: string): value is RuntimeMode {
  return runtimeModes.has(value as RuntimeMode);
}

export function createInitialAppState(): AppState {
  return {
    runtime: { status: 'stable', mode: 'sim' },
    map: { status: 'unavailable', cycle: 0 },
    command: { owner: 'manual' },
    pendingCommandOwner: null,
    transport: 'SIMULATED',
    transportCycle: 0,
    view: { mode: 'sim' },
    navigation: { status: 'idle', taskId: 0 },
    exploration: { status: 'idle', generation: 0 },
    explorationEvidence: { cycle: 0, mapGeneration: 0, mapObservedAtMs: null, poseObservedAtMs: null },
    controlLease: { owner: true, generation: 0 },
    vision: {
      status: 'unavailable',
      cycle: 0,
      modelReady: false,
      statusObservedAtMs: null,
      frameObservedAtMs: null,
      detectorObservedAtMs: null,
      detectorFrameObservedAtMs: null,
      synchronizedFrameObservedAtMs: null,
      synchronizedDetectorObservedAtMs: null,
      message: '',
    },
    objectSearch: { status: 'idle', generation: 0 },
    safety: { stopped: false },
    nextMapCycle: 0,
    nextTaskId: 0,
    nextObjectSearchMissionId: 0,
  };
}

export function currentRuntimeMode(state: AppState): RuntimeMode {
  return state.runtime.mode;
}

export function runtimeManagerSnapshot(state: AppState): RuntimeManagerState {
  if (state.runtime.status === 'switching') {
    return {
      mode: state.runtime.mode,
      target: state.runtime.target,
      processing: true,
      phase: state.runtime.phase,
      error: '',
      backendAlive: state.runtime.mode !== 'sim',
    };
  }
  if (state.runtime.status === 'error') {
    return {
      mode: state.runtime.mode,
      target: state.runtime.target,
      processing: false,
      phase: '',
      error: state.runtime.message,
      backendAlive: state.runtime.mode !== 'sim',
    };
  }
  return {
    mode: state.runtime.mode,
    target: state.runtime.mode,
    processing: false,
    phase: '',
    error: '',
    backendAlive: state.runtime.mode !== 'sim',
  };
}

function transportReady(state: AppState): boolean {
  const mode = currentRuntimeMode(state);
  return mode === 'sim' ? state.transport === 'SIMULATED' : state.transport === 'CONNECTED';
}

function transportHasExplicitError(state: AppState): boolean {
  return state.transport === 'ERROR';
}

export function isInteractionLocked(state: AppState): boolean {
  if (state.runtime.status === 'switching') return true;
  if (state.runtime.status === 'error') return false;
  if (state.map.status === 'initializing') return state.map.reason !== 'navigation-health';
  if (state.map.status === 'resetting') return true;
  if (state.map.status === 'error' || transportHasExplicitError(state)) return false;
  return !transportReady(state);
}

/**
 * ROS graph service calls are intentionally suspended while the backend graph
 * is being replaced, SLAM reset is in flight, or the cold mapping session has
 * not produced both map and pose evidence yet. rosapi requests are
 * comparatively expensive over rosbridge and can otherwise race lifecycle
 * discovery before a Large stage publishes its first map.
 */
export function canQueryRosGraph(state: AppState): boolean {
  if (state.runtime.status !== 'stable'
    || state.transport !== 'CONNECTED'
    || state.map.status === 'resetting') return false;
  if (state.map.status !== 'initializing') return true;
  if (state.map.reason === 'navigation-health') return true;
  return state.map.mapReceived && state.map.poseReceived;
}

export function canEnableNavigationControl(state: AppState): boolean {
  const runtimeMode = state.runtime.status === 'stable' ? state.runtime.mode : null;
  return state.runtime.status === 'stable'
    && (runtimeMode === 'navigation' || runtimeMode === 'exploration')
    && !state.safety.stopped
    && state.transport === 'CONNECTED'
    && state.map.status === 'ready'
    && state.map.mode === runtimeMode
    && state.view.mode === 'sim'
    && !isInteractionLocked(state);
}

function navigationTaskIsActive(navigation: NavigationTask): navigation is Extract<NavigationTask, { status: 'sending' | 'moving' }> {
  return navigation.status === 'sending' || navigation.status === 'moving';
}

function navigationRecoveryMayContinue(state: AppState): boolean {
  if (!navigationTaskIsActive(state.navigation) || state.command.owner !== 'navigation' || !state.safety.stopped) return false;
  const runtimeMode = state.runtime.status === 'stable' ? state.runtime.mode : null;
  return (runtimeMode === 'navigation' || runtimeMode === 'exploration')
    && state.transport === 'CONNECTED'
    && state.map.status === 'ready'
    && state.map.mode === runtimeMode
    && state.view.mode === 'sim'
    && !isInteractionLocked(state);
}

export function explorationIsActive(exploration: ExplorationState): exploration is Extract<ExplorationState, { status: 'evaluating' | 'sending' | 'moving' | 'replanning' }> {
  return exploration.status === 'evaluating'
    || exploration.status === 'sending'
    || exploration.status === 'moving'
    || exploration.status === 'replanning';
}

export function explorationUnavailableReason(state: AppState): string | null {
  if (state.runtime.status !== 'stable' || state.runtime.mode !== 'exploration') return '探索を開始するには探索構成を準備してください。';
  if (state.transport !== 'CONNECTED') return '探索を開始するにはROS2へ接続してください。';
  if (state.safety.stopped) return 'Safety stopが解除されるまで探索を開始・再開できません。';
  if (state.map.status !== 'ready' || state.map.mode !== 'exploration') return 'live map、SLAM pose、Nav2の準備完了を待ってください。';
  if (state.view.mode !== 'sim') return 'STAGE編集中は探索できません。SIMへ戻ってください。';
  if (isInteractionLocked(state)) return 'runtimeまたはmapの初期化完了を待ってください。';
  if (navigationTaskIsActive(state.navigation) && state.navigation.source === 'operator') return '進行中のNav2目標を停止してから探索を開始してください。';
  return null;
}

function explorationEvidenceAgeReason(observedAtMs: number | null, nowMs: number, maximumAgeMs: number, label: string): string | null {
  if (observedAtMs === null) return `${label}をまだ確認できません。`;
  const ageMs = nowMs - observedAtMs;
  if (!Number.isFinite(ageMs) || ageMs < -EXPLORATION_CLOCK_SKEW_TOLERANCE_MS) return `${label}の時刻を確認できません。`;
  if (ageMs > maximumAgeMs) return `${label}が古いため探索を開始・再開できません。fresh dataを待ってください。`;
  return null;
}

export function explorationFreshnessUnavailableReason(state: AppState, request: ExplorationFreshnessRequest): string | null {
  if (!Number.isFinite(request.nowMs)) return '探索開始時刻を確認できません。';
  if (!Number.isInteger(request.mapGeneration) || request.mapGeneration < 0) return 'fresh map generationを確認できません。';
  if (state.map.status !== 'ready' || state.map.mode !== 'exploration') return 'live map、SLAM pose、Nav2の準備完了を待ってください。';
  const evidence = state.explorationEvidence;
  if (evidence.cycle !== state.map.cycle || evidence.mapGeneration !== request.mapGeneration) {
    return '現在のreadiness cycleに対応するfresh live mapを確認できません。';
  }
  return explorationEvidenceAgeReason(evidence.mapObservedAtMs, request.nowMs, EXPLORATION_MAP_FRESHNESS_MS, 'live map')
    ?? explorationEvidenceAgeReason(evidence.poseObservedAtMs, request.nowMs, EXPLORATION_POSE_FRESHNESS_MS, 'SLAM pose');
}

export function canStartExploration(state: AppState, freshness: ExplorationFreshnessRequest): boolean {
  return (state.exploration.status === 'idle' || state.exploration.status === 'completed')
    && explorationUnavailableReason(state) === null
    && explorationFreshnessUnavailableReason(state, freshness) === null;
}

export function canPauseExploration(state: AppState): boolean {
  return explorationIsActive(state.exploration);
}

function explorationErrorResumeUnavailableReason(state: AppState, freshness: ExplorationFreshnessRequest): string | null {
  const exploration = state.exploration;
  if (exploration.status === 'error' && freshness.mapGeneration <= exploration.resumeAfterMapGeneration) {
    return '探索エラー後のfresh live mapを待ってください。';
  }
  return null;
}

export function canResumeExploration(state: AppState, freshness: ExplorationFreshnessRequest): boolean {
  if ((state.exploration.status !== 'paused' && state.exploration.status !== 'error')
    || explorationUnavailableReason(state) !== null
    || explorationFreshnessUnavailableReason(state, freshness) !== null
    || explorationErrorResumeUnavailableReason(state, freshness) !== null) return false;
  return state.map.status === 'ready' && state.map.mode === 'exploration';
}

export function canStopExploration(state: AppState): boolean {
  return state.exploration.status !== 'idle';
}

export interface ObjectSearchReadinessRequest {
  generation: number;
  visionCycle: number;
  mapCycle: number;
  mapGeneration: number;
  explorationGeneration: number;
  nowMs: number;
}

function objectSearchHasMission(objectSearch: ObjectSearchState): objectSearch is Exclude<ObjectSearchState, { status: 'idle' | 'canceled' }> {
  return objectSearch.status !== 'idle' && objectSearch.status !== 'canceled';
}

function objectSearchCanBePaused(objectSearch: ObjectSearchState): objectSearch is Extract<ObjectSearchState, { status: 'preparing' | 'searching' | 'candidate' | 'approaching' | 'stopping' | 'confirming' | 'finalizing' }> {
  return objectSearch.status === 'preparing'
    || objectSearch.status === 'searching'
    || objectSearch.status === 'candidate'
    || objectSearch.status === 'approaching'
    || objectSearch.status === 'stopping'
    || objectSearch.status === 'confirming'
    || objectSearch.status === 'finalizing';
}

function objectSearchContext(objectSearch: Exclude<ObjectSearchState, { status: 'idle' }>): ObjectSearchRunContext {
  return {
    missionId: objectSearch.missionId,
    generation: objectSearch.generation,
    targetClass: objectSearch.targetClass,
    displayName: objectSearch.displayName,
    normalizedCommand: objectSearch.normalizedCommand,
    requestedAtMs: objectSearch.requestedAtMs,
    mapCycle: objectSearch.mapCycle,
    explorationGeneration: objectSearch.explorationGeneration,
    visionCycle: objectSearch.visionCycle,
    transportCycle: objectSearch.transportCycle,
    controlLeaseGeneration: objectSearch.controlLeaseGeneration,
    runtimePreparationPending: objectSearch.runtimePreparationPending,
    lostCount: objectSearch.lostCount,
    detectionTracker: objectSearch.detectionTracker,
    lastChatStatus: objectSearch.lastChatStatus,
  };
}

function blankVisionState(cycle: number, status: 'unavailable' | 'initializing' = 'initializing'): VisionReadinessState {
  return {
    status,
    cycle,
    modelReady: false,
    statusObservedAtMs: null,
    frameObservedAtMs: null,
    detectorObservedAtMs: null,
    detectorFrameObservedAtMs: null,
    synchronizedFrameObservedAtMs: null,
    synchronizedDetectorObservedAtMs: null,
    message: '',
  };
}

function invalidateVisionEvidence(vision: VisionReadinessState): VisionReadinessState {
  return blankVisionState(vision.cycle + 1);
}

function visionWithDerivedReadiness(vision: VisionReadinessState): VisionReadinessState {
  if (vision.status === 'error' || vision.status === 'unavailable') return vision;
  const newlyPaired = vision.frameObservedAtMs !== null
    && vision.detectorObservedAtMs !== null
    && vision.detectorFrameObservedAtMs !== null
    && Math.abs(vision.frameObservedAtMs - vision.detectorFrameObservedAtMs) <= VISION_DETECTION_TO_FRAME_MAX_AGE_MS;
  const synchronizedFrameObservedAtMs = newlyPaired
    ? vision.detectorFrameObservedAtMs
    : vision.synchronizedFrameObservedAtMs;
  const synchronizedDetectorObservedAtMs = newlyPaired
    ? vision.detectorObservedAtMs
    : vision.synchronizedDetectorObservedAtMs;
  const ready = vision.modelReady
    && vision.statusObservedAtMs !== null
    && synchronizedFrameObservedAtMs !== null
    && synchronizedDetectorObservedAtMs !== null;
  return {
    ...vision,
    synchronizedFrameObservedAtMs,
    synchronizedDetectorObservedAtMs,
    status: ready ? 'ready' : 'initializing',
  };
}

function objectSearchEvidenceAgeReason(observedAtMs: number | null, nowMs: number, maximumAgeMs: number, label: string): string | null {
  if (observedAtMs === null) return `${label}をまだ確認できません。`;
  const ageMs = nowMs - observedAtMs;
  if (!Number.isFinite(ageMs) || ageMs < -EXPLORATION_CLOCK_SKEW_TOLERANCE_MS) return `${label}の時刻を確認できません。`;
  if (ageMs > maximumAgeMs) return `${label}が古いため、物体探索へ使用できません。fresh dataを待ってください。`;
  return null;
}

export function objectSearchReadinessUnavailableReason(state: AppState, request: ObjectSearchReadinessRequest): string | null {
  const mission = state.objectSearch;
  if (!objectSearchHasMission(mission)) return '準備中または一時停止中の物体探索はありません。';
  if (mission.generation !== request.generation) return '古いObject Search mission callbackは使用しません。';
  if (!Number.isFinite(request.nowMs)) return 'Object Searchの要求時刻を確認できません。';
  if (request.visionCycle !== state.vision.cycle || mission.visionCycle !== request.visionCycle) return '古いVision cycleの証拠は使用しません。';
  if (request.mapCycle !== state.map.cycle || mission.mapCycle !== request.mapCycle) return '古いmap readiness cycleは使用しません。';
  if (request.explorationGeneration !== state.exploration.generation) return '古いFrontier Exploration run callbackは使用しません。';
  if (mission.controlLeaseGeneration !== state.controlLease.generation || !state.controlLease.owner) return 'この端末に操作権がありません。「この端末で操作」を押してください。';
  if (state.view.mode !== 'sim') return 'STAGE編集中は物体探索を開始・再開できません。SIMへ戻ってください。';
  if (state.safety.stopped) return 'Safety stopが解除されるまで、物体探索を開始・再開できません。';
  const explorationReason = explorationUnavailableReason(state);
  if (explorationReason) return explorationReason;
  const vision = state.vision;
  if (vision.status === 'error') return vision.message || 'YOLOX Visionがエラーです。';
  if (vision.status !== 'ready' || !vision.modelReady) return 'YOLOX model、fresh Camera frame、detector応答の準備を待ってください。';
  if (vision.synchronizedFrameObservedAtMs === null
    || vision.synchronizedDetectorObservedAtMs === null
    || vision.synchronizedFrameObservedAtMs < mission.requestedAtMs
    || vision.synchronizedDetectorObservedAtMs < mission.requestedAtMs) {
    return 'mission開始前のCamera frameまたはDetectionは物体探索へ使用しません。';
  }
  return objectSearchEvidenceAgeReason(vision.statusObservedAtMs, request.nowMs, VISION_DETECTOR_FRESHNESS_MS, 'YOLOX status')
    ?? objectSearchEvidenceAgeReason(vision.synchronizedFrameObservedAtMs, request.nowMs, VISION_FRAME_FRESHNESS_MS, 'Camera frame')
    ?? objectSearchEvidenceAgeReason(vision.synchronizedDetectorObservedAtMs, request.nowMs, VISION_DETECTOR_FRESHNESS_MS, 'detector応答')
    ?? explorationFreshnessUnavailableReason(state, { mapGeneration: request.mapGeneration, nowMs: request.nowMs });
}

export function objectSearchStatusMessage(objectSearch: ObjectSearchState): string {
  if (objectSearch.status === 'idle') return '探索命令待ち';
  if (objectSearch.status === 'preparing') return objectSearch.lastChatStatus || '探索構成を準備しています。';
  if (objectSearch.status === 'searching') return objectSearch.lastChatStatus || `地図を作りながら、${objectSearch.displayName}を探しています。`;
  if (objectSearch.status === 'candidate') return objectSearch.lastChatStatus || `${objectSearch.displayName}候補を安定検出しました。Camera内かつ5m以内なので停止します。`;
  if (objectSearch.status === 'approaching') return objectSearch.lastChatStatus || `Nav2で${objectSearch.displayName}の正面へ接近しています。`;
  if (objectSearch.status === 'stopping') return objectSearch.lastChatStatus || 'goal取消、manual owner、速度0を確認しています。';
  if (objectSearch.status === 'confirming') return objectSearch.lastChatStatus || `停止後のfresh Cameraで${objectSearch.displayName}を再確認しています。`;
  if (objectSearch.status === 'succeeded') return objectSearch.lastChatStatus || `${objectSearch.displayName}を見つけました`;
  if (objectSearch.status === 'not_found') return objectSearch.lastChatStatus || `${objectSearch.displayName}はありませんでした`;
  if (objectSearch.status === 'paused') return objectSearch.lastChatStatus || `${objectSearch.displayName}探索は一時停止中です。理由を確認して明示的に再開してください。`;
  if (objectSearch.status === 'finalizing') return objectSearch.lastChatStatus || '探索完了後のVision確認待ちです。';
  if (objectSearch.status === 'canceled') return objectSearch.lastChatStatus || `${objectSearch.displayName}探索を中止しました。`;
  return objectSearch.message;
}

export function mapSaveUnavailableReason(state: AppState): string | null {
  if (state.runtime.status !== 'stable') return 'runtimeの切替完了後に地図を保存してください。';
  const mode = state.runtime.mode;
  if (mode !== 'mapping' && mode !== 'exploration') return '地図保存はMAPPINGまたは探索構成で実行できます。';
  if (state.transport !== 'CONNECTED') return '地図を保存するにはROS2へ接続してください。';
  if (state.view.mode !== 'sim') return '地図を保存するにはSIM画面へ戻ってください。';
  if (isInteractionLocked(state)) return 'live mapの初期化完了後に地図を保存してください。';
  if (state.map.status !== 'ready' || state.map.mode !== mode) return 'fresh live mapの準備完了後に地図を保存してください。';
  if (mode === 'exploration') {
    if (explorationIsActive(state.exploration)) return '探索を一時停止してgoalと速度を止めてから地図を保存してください。';
    if (navigationTaskIsActive(state.navigation)) return '進行中のNav2 goalを取り消してから地図を保存してください。';
  }
  return null;
}

export function canSaveCurrentMap(state: AppState): boolean {
  return mapSaveUnavailableReason(state) === null;
}

export function canAcceptManualMotion(state: AppState): boolean {
  return state.runtime.status === 'stable'
    && state.command.owner === 'manual'
    && !explorationIsActive(state.exploration)
    && !(state.map.status === 'initializing' && state.map.reason === 'navigation-health')
    && state.view.mode === 'sim'
    && transportReady(state)
    && !isInteractionLocked(state);
}

export function processingModalModel(state: AppState): ProcessingModalModel | null {
  if (!isInteractionLocked(state)) return null;
  const waitingForTransport = state.transport === 'CONNECTING'
    || state.transport === 'RECONNECTING'
    || state.transport === 'DISCONNECTED'
    || state.transport === 'ERROR';
  if (state.map.status === 'resetting') {
    return {
      title: 'MAP初期化中',
      detail: '現在マップを消去して、SLAM Toolboxから新しい地図を作成しています。',
      status: state.map.phase === 'switching-to-mapping' ? 'mapping構成へ安全に切り替えています…' : 'SLAM Toolboxへresetを要求しています…',
    };
  }
  if (state.map.status === 'initializing') {
    if (state.map.target === 'mapping') {
      return {
        title: 'MAP初期化中',
        detail: 'SLAM Toolboxと/mapを準備しています。地図が安定するまで自機を操作できません。',
        status: state.runtime.status === 'switching' ? 'ROS backendを切り替えています…' : 'SLAM Toolboxのmap配信を待っています…',
      };
    }
    if (state.map.target === 'exploration') {
      return {
        title: '探索構成初期化中',
        detail: 'SLAM Toolboxのlive map・同期pose・Nav2 Actionを準備しています。',
        status: state.runtime.status === 'switching'
          ? 'ROS backendを探索構成へ切り替えています…'
          : !state.map.mapReceived
            ? 'SLAM Toolboxのfresh mapを待っています…'
            : !state.map.poseReceived
              ? 'SLAM poseと自機位置の同期を待っています…'
              : 'Nav2 Actionと必須Nodeの準備を待っています…',
      };
    }
    return {
      title: 'NAV2初期化中',
      detail: 'Map Server・AMCL・Nav2と自機の位置を同期しています。',
      status: state.runtime.status === 'switching'
        ? 'ROS backendを切り替えています…'
        : waitingForTransport
          ? 'rosbridgeへ再接続しています…'
        : state.map.mapReceived
          ? 'AMCLと自機位置の同期を待っています…'
          : 'Map Serverのmap配信を待っています…',
    };
  }
  const target = state.runtime.status === 'switching' ? state.runtime.target : currentRuntimeMode(state);
  return target === 'sim'
    ? { title: 'SIMへ復帰中', detail: 'ROS2構成を安全に停止してSIMを再開しています。', status: 'SIMの再接続を待っています…' }
    : { title: 'ROS2構成切替中', detail: 'Safety ControllerとTopic接続を準備しています。', status: 'ROS2接続の完了を待っています…' };
}

function accepted(state: AppState, effects: AppEffect[] = []): TransitionResult {
  return { state, effects, accepted: true };
}

function rejected(state: AppState, rejection?: string): TransitionResult {
  return { state, effects: [], accepted: false, ...(rejection ? { rejection } : {}) };
}

function stoppedEffects(clear: 'goal' | 'runtime' | 'none' = 'goal'): AppEffect[] {
  return [
    { type: 'RELEASE_USER_INPUT' },
    { type: 'CANCEL_NAVIGATION_GOAL' },
    { type: 'SET_COMMAND_OWNER', owner: 'manual' },
    { type: 'ZERO_VELOCITY' },
    ...(clear === 'goal' ? [{ type: 'CLEAR_GOAL_DATA' } as const] : clear === 'runtime' ? [{ type: 'CLEAR_RUNTIME_DATA' } as const] : []),
  ];
}

function canceledNavigation(navigation: NavigationTask): NavigationTask {
  if (navigationTaskIsActive(navigation)) {
    return { status: 'canceled', taskId: navigation.taskId, source: navigation.source };
  }
  return { status: 'idle', taskId: navigation.taskId };
}

function pendingNavigationOwner(requestedAtMs: number): PendingCommandOwner {
  return { owner: 'navigation', requestedAtMs, expiresAtMs: requestedAtMs + COMMAND_OWNER_ACK_TIMEOUT_MS, acknowledged: false };
}

function explorationContext(exploration: Exclude<ExplorationState, { status: 'idle' }>): ExplorationRunContext {
  return {
    generation: exploration.generation,
    goalPolicy: exploration.goalPolicy ?? 'coverage',
    mapCycle: exploration.mapCycle,
    lastMapGeneration: exploration.lastMapGeneration,
    retryCount: exploration.retryCount,
    replanCount: exploration.replanCount,
    noCandidateConfirmations: exploration.noCandidateConfirmations,
    blacklistedCandidateIds: exploration.blacklistedCandidateIds,
  };
}

export function explorationUsesObjectSearchPolicy(exploration: ExplorationState): boolean {
  return exploration.status !== 'idle' && exploration.goalPolicy === 'object-search';
}

function withExplorationGoalPolicy(
  exploration: Exclude<ExplorationState, { status: 'idle' }>,
  goalPolicy: ExplorationGoalPolicy,
): ExplorationState {
  if (exploration.goalPolicy === goalPolicy) return exploration;
  return { ...exploration, goalPolicy };
}

function latestObservedExplorationMapGeneration(state: AppState, exploration: Exclude<ExplorationState, { status: 'idle' }>): number {
  if (state.explorationEvidence.cycle !== exploration.mapCycle) return exploration.lastMapGeneration;
  return Math.max(exploration.lastMapGeneration, state.explorationEvidence.mapGeneration);
}

function pausedExploration(state: AppState, reason: ExplorationPauseReason): ExplorationState {
  const exploration = state.exploration;
  if (exploration.status === 'paused') return exploration;
  if (!explorationIsActive(exploration)) return exploration;
  const resumeAfterMapGeneration = latestObservedExplorationMapGeneration(state, exploration);
  return {
    ...explorationContext(exploration),
    lastMapGeneration: resumeAfterMapGeneration,
    status: 'paused',
    reason,
    resumeAfterMapGeneration,
  };
}

function clearedExploration(exploration: ExplorationState): ExplorationState {
  return { status: 'idle', generation: exploration.generation + 1 };
}

function appendExplorationBlacklist(blacklist: readonly string[], candidateId: string): readonly string[] {
  if (blacklist.includes(candidateId)) return blacklist;
  return [...blacklist, candidateId].slice(-MAX_EXPLORATION_BLACKLIST_SIZE);
}

function explorationEvaluationEffect(exploration: ExplorationRunContext, mapGeneration: number): AppEffect {
  return {
    type: 'EVALUATE_EXPLORATION_MAP',
    generation: exploration.generation,
    mapGeneration,
    blacklistedCandidateIds: exploration.blacklistedCandidateIds,
  };
}

function explorationWaitEffect(exploration: ExplorationRunContext, afterMapGeneration: number, requireFreshMap: boolean): AppEffect {
  return {
    type: 'WAIT_FOR_EXPLORATION_MAP',
    generation: exploration.generation,
    afterMapGeneration,
    requireFreshMap,
  };
}

function nextReadiness(state: AppState, target: 'mapping' | 'navigation' | 'exploration', reason: 'runtime-switch' | 'reconnect' | 'map-reset'): Pick<AppState, 'map' | 'nextMapCycle'> {
  const cycle = state.nextMapCycle + 1;
  return {
    map: { status: 'initializing', target, reason, mapReceived: false, poseReceived: false, navigationReceived: false, cycle },
    nextMapCycle: cycle,
  };
}

function stoppedReasonForState(state: AppState): CommandOwnership {
  if (state.view.mode === 'stage') return { owner: 'stopped', reason: 'stage' };
  if (state.runtime.status === 'error') return { owner: 'stopped', reason: 'runtime-error' };
  if (state.runtime.status === 'switching') return { owner: 'stopped', reason: 'runtime-switch' };
  if (state.map.status === 'initializing' || state.map.status === 'resetting') return { owner: 'stopped', reason: 'map-initialization' };
  if (state.map.status === 'error') return { owner: 'stopped', reason: 'map-error' };
  if (!transportReady(state)) return { owner: 'stopped', reason: 'transport' };
  return { owner: 'manual' };
}

function withSafeCommandState(state: AppState): AppState {
  if (state.command.owner === 'navigation'
    && (canEnableNavigationControl(state) || navigationRecoveryMayContinue(state))) return state;
  return { ...state, command: stoppedReasonForState(state), pendingCommandOwner: null };
}

function objectSearchPauseMessage(reason: ObjectSearchPauseReason, displayName = '物体'): string {
  switch (reason) {
    case 'safety-stop': return `安全停止のため、${displayName}探索を一時停止しました。`;
    case 'transport': return `ROS 2との接続が切れたため、${displayName}探索を一時停止しました。`;
    case 'runtime-change': return `runtimeが変わったため、${displayName}探索を一時停止しました。探索構成を確認して再開してください。`;
    case 'control-lease': return `別の画面へ操作権が移ったため、${displayName}探索を一時停止しました。`;
    case 'stage': return `STAGE編集中のため、${displayName}探索を一時停止しました。SIMへ戻って再開してください。`;
    case 'origin-reset': return `自機の原点を変更したため、${displayName}探索を一時停止しました。fresh mapを待って再開してください。`;
    case 'manual-override': return `手動操作へ切り替えたため、${displayName}探索を一時停止しました。`;
    case 'navigation-unavailable': return `Nav2またはlive mapの準備が失われたため、${displayName}探索を一時停止しました。`;
    case 'target-lost': return `停止後に${displayName}を見失いました。安全条件を確認して探索を再開してください。`;
    case 'vision': return `Visionのfreshな応答を確認できないため、${displayName}探索を一時停止しました。`;
    case 'user': return `${displayName}探索を一時停止しました。`;
  }
}

function explorationPauseReasonForObjectSearch(reason: ObjectSearchPauseReason): ExplorationPauseReason {
  if (reason === 'control-lease' || reason === 'vision') return reason;
  if (reason === 'target-lost') return 'object-found-candidate';
  if (reason === 'user') return 'user';
  return reason;
}

function refreshedObjectSearchContext(
  state: AppState,
  objectSearch: Exclude<ObjectSearchState, { status: 'idle' }>,
  vision: VisionReadinessState,
  message: string,
): ObjectSearchRunContext {
  const generation = objectSearch.generation + 1;
  const notBeforeFrameStampMs = Math.max(
    objectSearch.requestedAtMs,
    vision.synchronizedFrameObservedAtMs ?? objectSearch.requestedAtMs,
  );
  return {
    ...objectSearchContext(objectSearch),
    generation,
    mapCycle: state.map.cycle,
    explorationGeneration: state.exploration.generation,
    visionCycle: vision.cycle,
    transportCycle: state.transportCycle,
    controlLeaseGeneration: state.controlLease.generation,
    detectionTracker: createAppleDetectionTracker({
      phase: 'prestop',
      targetClass: objectSearch.targetClass,
      missionGeneration: generation,
      visionCycle: vision.cycle,
      transportCycle: state.transportCycle,
      notBeforeFrameStampMs,
    }),
    lastChatStatus: message,
  };
}

function pauseObjectSearchDirect(state: AppState, reason: ObjectSearchPauseReason, message?: string): TransitionResult {
  const objectSearch = state.objectSearch;
  if (!objectSearchCanBePaused(objectSearch)) return accepted(state);
  const resolvedMessage = message ?? objectSearchPauseMessage(reason, objectSearch.displayName);
  const vision = invalidateVisionEvidence(state.vision);
  const exploration = pausedExploration(state, explorationPauseReasonForObjectSearch(reason));
  const nextBase: AppState = {
    ...state,
    vision,
    navigation: canceledNavigation(state.navigation),
    exploration,
    command: { owner: 'manual' },
    pendingCommandOwner: null,
    objectSearch: {
      ...refreshedObjectSearchContext({ ...state, exploration }, objectSearch, vision, resolvedMessage),
      runtimePreparationPending: false,
      status: 'paused',
      reason,
      resumeAfterMapGeneration: state.explorationEvidence.mapGeneration,
    },
  };
  const next = withSafeCommandState(nextBase);
  return accepted(next, [
    ...stoppedEffects(),
    { type: 'SET_NAVIGATION_STATUS', message: resolvedMessage },
    { type: 'SYNC_OBJECT_SEARCH_CHAT', status: 'paused', targetClass: objectSearch.targetClass, role: 'robot', message: resolvedMessage },
  ]);
}

function pauseObjectSearchAfterTransition(result: TransitionResult, reason: ObjectSearchPauseReason): TransitionResult {
  if (!result.accepted || !objectSearchCanBePaused(result.state.objectSearch)) return result;
  const objectSearch = result.state.objectSearch;
  const message = objectSearchPauseMessage(reason, objectSearch.displayName);
  const vision = invalidateVisionEvidence(result.state.vision);
  const exploration = pausedExploration(result.state, explorationPauseReasonForObjectSearch(reason));
  const next = withSafeCommandState({
    ...result.state,
    vision,
    command: { owner: 'manual' },
    pendingCommandOwner: null,
    navigation: canceledNavigation(result.state.navigation),
    exploration,
    objectSearch: {
      ...refreshedObjectSearchContext({ ...result.state, exploration }, objectSearch, vision, message),
      runtimePreparationPending: false,
      status: 'paused',
      reason,
      resumeAfterMapGeneration: result.state.explorationEvidence.mapGeneration,
    },
  });
  const effectTypes = new Set(result.effects.map((effect) => effect.type));
  const alreadyStopped = effectTypes.has('CANCEL_NAVIGATION_GOAL')
    && effectTypes.has('SET_COMMAND_OWNER')
    && effectTypes.has('ZERO_VELOCITY');
  const effects = alreadyStopped
    ? [...result.effects]
    : [...stoppedEffects(), { type: 'SET_NAVIGATION_STATUS', message } as const];
  effects.push({ type: 'SYNC_OBJECT_SEARCH_CHAT', status: 'paused', targetClass: objectSearch.targetClass, role: 'robot', message });
  return accepted(next, effects);
}

function invalidateObjectSearchEvidence(state: AppState): AppState {
  const objectSearch = state.objectSearch;
  const vision = invalidateVisionEvidence(state.vision);
  if (objectSearch.status === 'idle' || objectSearch.status === 'canceled') return { ...state, vision };
  const context = refreshedObjectSearchContext(state, objectSearch, vision, objectSearch.lastChatStatus);
  return {
    ...state,
    vision,
    objectSearch: {
      ...objectSearch,
      ...context,
      runtimePreparationPending: objectSearch.runtimePreparationPending,
    } as ObjectSearchState,
  };
}

function completeReadiness(state: AppState): TransitionResult | null {
  const readiness = state.map;
  if (readiness.status !== 'initializing' || state.runtime.status !== 'stable' || state.runtime.mode !== readiness.target) return null;
  const ready = readiness.target === 'mapping'
    ? readiness.mapReceived
    : readiness.target === 'navigation'
      ? readiness.mapReceived && readiness.poseReceived
      : readiness.mapReceived && readiness.poseReceived && readiness.navigationReceived;
  if (!ready) return null;
  const next = withSafeCommandState({ ...state, map: { status: 'ready', mode: readiness.target, cycle: readiness.cycle } });
  const message = readiness.target === 'navigation'
    ? 'NAV2の初期化と自機・mapの同期が完了しました。自機を操作できます。'
    : readiness.target === 'exploration'
      ? '探索構成のlive map・SLAM pose・Nav2 Actionが揃いました。探索を開始できます。'
      : 'MAPの初期化が完了しました。mapとLiDARが同期した状態で自機を操作できます。';
  return accepted(next, [
    { type: 'SET_COMMAND_OWNER', owner: 'manual' },
    {
      type: 'SET_NAVIGATION_STATUS',
      message: readiness.target === 'navigation'
        ? 'AMCL / Nav2の操作待ち'
        : readiness.target === 'exploration'
          ? 'Online SLAM / Frontier探索の開始待ち'
          : 'SLAM Toolboxで地図を作成中',
    },
    { type: 'ANNOUNCE', message },
  ]);
}

function runtimeSwitchState(state: AppState, target: RuntimeMode): AppState {
  const readiness = target === 'mapping' || target === 'navigation' || target === 'exploration'
    ? nextReadiness(state, target, 'runtime-switch')
    : { map: { status: 'unavailable', cycle: state.nextMapCycle } as MapReadiness, nextMapCycle: state.nextMapCycle };
  return {
    ...state,
    runtime: { status: 'switching', mode: currentRuntimeMode(state), target, phase: target === 'sim' ? 'closing' : 'processing' },
    ...readiness,
    command: { owner: 'stopped', reason: 'runtime-switch' },
    pendingCommandOwner: null,
    view: { mode: 'sim' },
    navigation: canceledNavigation(state.navigation),
    exploration: pausedExploration(state, 'runtime-change'),
  };
}

function observeStableRuntime(state: AppState, mode: RuntimeMode): TransitionResult {
  if (state.runtime.status === 'switching' && state.runtime.target !== mode) return rejected(state);
  if (state.runtime.status === 'stable' && state.runtime.mode === mode) return accepted(state);
  const previousMode = currentRuntimeMode(state);
  let next: AppState = { ...state, runtime: { status: 'stable', mode } };
  const effects: AppEffect[] = [];
  const externalModeChange = state.runtime.status !== 'switching' && previousMode !== mode;

  if (externalModeChange) {
    next = {
      ...next,
      command: { owner: 'stopped', reason: 'runtime-switch' },
      pendingCommandOwner: null,
      view: { mode: 'sim' },
      navigation: canceledNavigation(state.navigation),
      exploration: pausedExploration(state, 'runtime-change'),
    };
    effects.push(...stoppedEffects('runtime'));
    if (state.view.mode === 'stage') effects.push({ type: 'EXIT_STAGE' });
    if (mode === 'navigation') effects.push({ type: 'RESET_NAVIGATION_ORIGIN' });
  }

  if (state.map.status === 'resetting' && state.map.phase === 'switching-to-mapping' && mode === 'mapping') {
    next = { ...next, map: { ...state.map, phase: 'requesting-reset' } };
    effects.push({ type: 'REQUEST_MAP_RESET' });
  } else if (mode === 'sim' || mode === 'base') {
    next = { ...next, map: { status: 'unavailable', cycle: state.nextMapCycle } };
  } else if (!(state.map.status === 'initializing' && state.map.target === mode) && !(state.map.status === 'ready' && state.map.mode === mode) && !(state.map.status === 'resetting' && mode === 'mapping')) {
    const readiness = nextReadiness(next, mode, 'runtime-switch');
    next = { ...next, ...readiness, command: { owner: 'stopped', reason: 'map-initialization' } };
    if (!effects.some((effect) => effect.type === 'CLEAR_RUNTIME_DATA')) effects.push(...stoppedEffects('runtime'));
  }

  const hasClearNavigationEffect = effects.some((effect) => effect.type === 'CLEAR_RUNTIME_DATA');
  if (previousMode !== mode && (mode === 'mapping' || mode === 'navigation' || mode === 'exploration') && !hasClearNavigationEffect) {
    effects.push({ type: 'CLEAR_RUNTIME_DATA' });
  }
  next = withSafeCommandState(next);
  if (!isInteractionLocked(next) && next.command.owner === 'manual' && !effects.some((effect) => effect.type === 'SET_COMMAND_OWNER')) {
    effects.push({ type: 'SET_COMMAND_OWNER', owner: 'manual' });
  }
  return accepted(next, effects);
}

function startOrAttachObjectSearch(
  state: AppState,
  request: ObjectSearchReadinessRequest,
  resumable: boolean,
): TransitionResult {
  const mission = state.objectSearch;
  if (resumable) {
    if (mission.status !== 'paused' && mission.status !== 'error') return rejected(state, '一時停止中またはrecoverable errorの物体探索だけを再開できます。');
  } else if (mission.status !== 'preparing') {
    return rejected(state, '準備中の物体探索だけを開始できます。');
  }
  const unavailable = objectSearchReadinessUnavailableReason(state, request);
  if (unavailable) return rejected(state, unavailable);

  let explorationResult: TransitionResult;
  if (explorationIsActive(state.exploration)) {
    explorationResult = accepted({
      ...state,
      exploration: withExplorationGoalPolicy(state.exploration, 'object-search'),
    });
  } else if (state.exploration.status === 'paused' || state.exploration.status === 'error') {
    explorationResult = transitionAppStateCore(state, {
      type: 'EXPLORATION_RESUME_REQUESTED',
      mapGeneration: request.mapGeneration,
      requestedAtMs: request.nowMs,
      goalPolicy: 'object-search',
    });
  } else {
    explorationResult = transitionAppStateCore(state, {
      type: 'EXPLORATION_START_REQUESTED',
      mapGeneration: request.mapGeneration,
      requestedAtMs: request.nowMs,
      goalPolicy: 'object-search',
    });
  }
  if (!explorationResult.accepted || !explorationIsActive(explorationResult.state.exploration)) {
    return explorationResult.accepted
      ? rejected(state, 'Frontier Explorationを開始または現在runへattachできません。')
      : explorationResult;
  }
  const message = `地図を作りながら、${mission.displayName}を探しています。`;
  const context: ObjectSearchRunContext = {
    ...objectSearchContext(mission),
    mapCycle: explorationResult.state.map.cycle,
    explorationGeneration: explorationResult.state.exploration.generation,
    visionCycle: explorationResult.state.vision.cycle,
    transportCycle: explorationResult.state.transportCycle,
    controlLeaseGeneration: explorationResult.state.controlLease.generation,
    runtimePreparationPending: false,
    detectionTracker: createAppleDetectionTracker({
      phase: 'prestop',
      targetClass: mission.targetClass,
      missionGeneration: mission.generation,
      visionCycle: explorationResult.state.vision.cycle,
      transportCycle: explorationResult.state.transportCycle,
      notBeforeFrameStampMs: request.nowMs,
    }),
    lastChatStatus: message,
  };
  return accepted({
    ...explorationResult.state,
    objectSearch: { ...context, status: 'searching', explorationGeneration: explorationResult.state.exploration.generation },
  }, [
    ...explorationResult.effects,
    { type: 'SYNC_OBJECT_SEARCH_CHAT', status: 'accepted', targetClass: mission.targetClass, role: 'robot', message },
  ]);
}

function objectSearchPauseReasonForUnavailable(state: AppState, unavailable: string): ObjectSearchPauseReason {
  if (!state.controlLease.owner || unavailable.includes('操作権')) return 'control-lease';
  if (state.safety.stopped || unavailable.includes('Safety')) return 'safety-stop';
  if (state.transport !== 'CONNECTED' || unavailable.includes('ROS2')) return 'transport';
  if (state.runtime.status !== 'stable' || state.runtime.mode !== 'exploration' || unavailable.includes('runtime')) return 'runtime-change';
  if (state.view.mode !== 'sim' || unavailable.includes('STAGE')) return 'stage';
  if (unavailable.includes('Vision') || unavailable.includes('YOLOX') || unavailable.includes('Camera') || unavailable.includes('detector') || unavailable.includes('Detection')) return 'vision';
  return 'navigation-unavailable';
}

function emptyObjectSearchStopEvidence(): ObjectSearchStopEvidence {
  return {
    manualOwnerAcknowledgedAtMs: null,
    zeroVelocitySampleObservedAtMs: [],
    lastMotionObservedAtMs: null,
  };
}

function objectSearchDetectionCycleRejection(
  state: AppState,
  mission: Exclude<ObjectSearchState, { status: 'idle' }>,
  event: Pick<Extract<AppEvent, { type: 'OBJECT_SEARCH_DETECTION_OBSERVED' | 'OBJECT_SEARCH_APPROACH_REQUESTED' | 'OBJECT_SEARCH_SAFE_STOP_REQUESTED' }>, 'generation' | 'visionCycle' | 'transportCycle' | 'explorationGeneration'>,
): string | null {
  if (event.generation !== mission.generation) return '古いObject Search mission callbackは使用しません。';
  if (event.visionCycle !== state.vision.cycle || event.visionCycle !== mission.visionCycle) return '古いVision cycleのcallbackは使用しません。';
  if (event.transportCycle !== state.transportCycle || event.transportCycle !== mission.transportCycle) return '古いTransport cycleのcallbackは使用しません。';
  if (event.explorationGeneration !== state.exploration.generation
    || event.explorationGeneration !== mission.explorationGeneration) return '古いFrontier Exploration run callbackは使用しません。';
  return null;
}

function objectSearchStopEnvironmentUnavailableReason(state: AppState): string | null {
  if (!state.controlLease.owner) return 'この端末に操作権がありません。';
  if (state.safety.stopped) return 'Safety stop中は物体発見を確定しません。';
  if (state.transport !== 'CONNECTED') return 'ROS2 Transportが接続されていません。';
  if (state.runtime.status !== 'stable' || state.runtime.mode !== 'exploration') return 'exploration runtimeが安定していません。';
  if (state.view.mode !== 'sim') return 'STAGE編集中は物体発見を確定しません。';
  if (state.vision.status === 'error') return state.vision.message || 'Vision error中は物体発見を確定しません。';
  return null;
}

function zeroVelocityEvidence(linearX: number, angularZ: number): boolean {
  return Math.abs(linearX) <= APPLE_STOP_MAX_LINEAR_X
    && Math.abs(angularZ) <= APPLE_STOP_MAX_ANGULAR_Z;
}

function objectSearchStopEvidenceIsFresh(
  evidence: ObjectSearchStopEvidence,
  nowMs: number,
  requireFreshOwnerAcknowledgement: boolean,
): boolean {
  if (evidence.manualOwnerAcknowledgedAtMs === null
    || evidence.zeroVelocitySampleObservedAtMs.length < APPLE_STOP_REQUIRED_ZERO_SAMPLES) return false;
  const zeroSamples = evidence.zeroVelocitySampleObservedAtMs.slice(-APPLE_STOP_REQUIRED_ZERO_SAMPLES);
  if (zeroSamples.some((observedAtMs) => nowMs - observedAtMs < 0 || nowMs - observedAtMs > APPLE_STOP_EVIDENCE_MAX_AGE_MS)) return false;
  if (requireFreshOwnerAcknowledgement
    && (nowMs - evidence.manualOwnerAcknowledgedAtMs < 0
      || nowMs - evidence.manualOwnerAcknowledgedAtMs > APPLE_STOP_EVIDENCE_MAX_AGE_MS)) return false;
  return evidence.lastMotionObservedAtMs === zeroSamples.at(-1);
}

function objectSearchStopIsMaintained(state: AppState, evidence: ObjectSearchStopEvidence, nowMs: number): boolean {
  return objectSearchStopEnvironmentUnavailableReason(state) === null
    && !navigationTaskIsActive(state.navigation)
    && state.command.owner === 'manual'
    && state.pendingCommandOwner === null
    && objectSearchStopEvidenceIsFresh(evidence, nowMs, false);
}

function maybeConfirmObjectSearchStop(result: TransitionResult, observedAtMs: number): TransitionResult {
  if (!result.accepted || result.state.objectSearch.status !== 'stopping') return result;
  const mission = result.state.objectSearch;
  if (objectSearchStopEnvironmentUnavailableReason(result.state) !== null
    || navigationTaskIsActive(result.state.navigation)
    || result.state.command.owner !== 'manual'
    || result.state.pendingCommandOwner !== null
    || !objectSearchStopEvidenceIsFresh(mission.stopEvidence, observedAtMs, true)) return result;
  const message = `Robotのmanual ownerと連続する速度0を確認しました。停止後のCameraで${mission.displayName}を再確認しています。`;
  return accepted({
    ...result.state,
    objectSearch: {
      ...objectSearchContext(mission),
      detectionTracker: resetAppleDetectionTrackerForPostStop(mission.detectionTracker, observedAtMs),
      lastChatStatus: message,
      status: 'confirming',
      candidate: mission.candidate,
      stoppedAtMs: observedAtMs,
      stopEvidence: mission.stopEvidence,
    },
  }, [
    ...result.effects,
    { type: 'SET_NAVIGATION_STATUS', message: 'Object Search停止確認 / post-stop Cameraを確認中' },
    { type: 'SYNC_OBJECT_SEARCH_CHAT', status: 'accepted', targetClass: mission.targetClass, role: 'robot', message },
  ]);
}

function observeObjectSearchManualOwner(result: TransitionResult, event: Extract<AppEvent, { type: 'COMMAND_OWNER_OBSERVED' }>): TransitionResult {
  if (!result.accepted) return result;
  const mission = result.state.objectSearch;
  if (mission.status !== 'stopping' && mission.status !== 'confirming' && mission.status !== 'finalizing') return result;
  if (event.owner !== 'manual') {
    if (mission.status === 'confirming' || mission.status === 'finalizing') {
      return pauseObjectSearchDirect(result.state, 'navigation-unavailable', `Command Gateのmanual ownerを維持できないため、${mission.displayName}発見を確定せず一時停止しました。`);
    }
    return result;
  }
  if (mission.status === 'finalizing') {
    if (event.observedAtMs < mission.finalizationStartedAtMs
      || (mission.stopEvidence.manualOwnerAcknowledgedAtMs !== null
        && event.observedAtMs < mission.stopEvidence.manualOwnerAcknowledgedAtMs)) {
      return rejected(result.state, '探索完了前のmanual owner acknowledgementは不在確認へ使用しません。');
    }
    return accepted({
      ...result.state,
      objectSearch: {
        ...mission,
        stopEvidence: { ...mission.stopEvidence, manualOwnerAcknowledgedAtMs: event.observedAtMs },
      },
    }, result.effects);
  }
  if (mission.status === 'confirming') return result;
  if (event.observedAtMs < mission.stopRequestedAtMs
    || (mission.stopEvidence.manualOwnerAcknowledgedAtMs !== null
      && event.observedAtMs < mission.stopEvidence.manualOwnerAcknowledgedAtMs)) return rejected(result.state, '古いmanual owner acknowledgementは停止証拠へ使用しません。');
  const nextMission: ObjectSearchState = {
    ...mission,
    stopEvidence: { ...mission.stopEvidence, manualOwnerAcknowledgedAtMs: event.observedAtMs },
  };
  return maybeConfirmObjectSearchStop(accepted({ ...result.state, objectSearch: nextMission }, result.effects), event.observedAtMs);
}

function observeObjectSearchMotion(state: AppState, event: Extract<AppEvent, { type: 'ROBOT_MOTION_OBSERVED' }>): TransitionResult {
  if (!Number.isFinite(event.observedAtMs) || !Number.isFinite(event.linearX) || !Number.isFinite(event.angularZ)) {
    return rejected(state, 'Robot速度の停止証拠を確認できません。');
  }
  const mission = state.objectSearch;
  if (mission.status !== 'stopping'
    && mission.status !== 'confirming'
    && mission.status !== 'finalizing'
    && mission.status !== 'succeeded') return accepted(state);
  if (event.generation !== mission.generation) return rejected(state, '古いObject Search missionの速度証拠は使用しません。');
  if (event.transportCycle !== state.transportCycle || event.transportCycle !== mission.transportCycle) {
    return rejected(state, '古いTransport cycleの速度証拠は使用しません。');
  }
  if (mission.status === 'succeeded') {
    return zeroVelocityEvidence(event.linearX, event.angularZ)
      ? accepted(state)
      : accepted(state, [...stoppedEffects(), { type: 'SET_NAVIGATION_STATUS', message: 'Object Search成功後の停止を維持 / 速度0' }]);
  }
  if ((mission.status === 'stopping' && event.observedAtMs < mission.stopRequestedAtMs)
    || (mission.status === 'finalizing' && event.observedAtMs < mission.finalizationStartedAtMs)) {
    return rejected(state, '停止要求前の速度sampleは使用しません。');
  }
  if (mission.stopEvidence.lastMotionObservedAtMs !== null
    && event.observedAtMs <= mission.stopEvidence.lastMotionObservedAtMs) {
    return rejected(state, '同一または古いRobot速度sampleは重複して数えません。');
  }
  const zeroVelocitySampleObservedAtMs = zeroVelocityEvidence(event.linearX, event.angularZ)
    ? [...mission.stopEvidence.zeroVelocitySampleObservedAtMs, event.observedAtMs].slice(-APPLE_STOP_REQUIRED_ZERO_SAMPLES)
    : [];
  const stopEvidence: ObjectSearchStopEvidence = {
    ...mission.stopEvidence,
    zeroVelocitySampleObservedAtMs,
    lastMotionObservedAtMs: event.observedAtMs,
  };
  if (mission.status === 'finalizing') {
    return accepted({ ...state, objectSearch: { ...mission, stopEvidence } });
  }
  if (mission.status === 'confirming' && zeroVelocitySampleObservedAtMs.length === 0) {
    return pauseObjectSearchDirect({ ...state, objectSearch: { ...mission, stopEvidence } }, 'navigation-unavailable', `Robotが速度0を維持していないため、${mission.displayName}発見を確定せず一時停止しました。`);
  }
  const updated = accepted({ ...state, objectSearch: { ...mission, stopEvidence } as ObjectSearchState });
  return maybeConfirmObjectSearchStop(updated, event.observedAtMs);
}

function lostTargetTracker(
  generation: number,
  state: AppState,
  targetClass: ObjectSearchTargetClass,
  notBeforeFrameStampMs: number,
): AppleDetectionTracker {
  return createAppleDetectionTracker({
    phase: 'prestop',
    targetClass,
    missionGeneration: generation,
    visionCycle: state.vision.cycle,
    transportCycle: state.transportCycle,
    notBeforeFrameStampMs,
  });
}

function handleObjectSearchPostStopLost(
  state: AppState,
  mission: Extract<ObjectSearchState, { status: 'confirming' }>,
  event: Extract<AppEvent, { type: 'OBJECT_SEARCH_DETECTION_OBSERVED' }>,
): TransitionResult {
  const lostCount = mission.lostCount + 1;
  const generation = mission.generation + 1;
  const detectionTracker = lostTargetTracker(generation, state, mission.targetClass, event.observedAtMs);
  const context: ObjectSearchRunContext = {
    ...objectSearchContext(mission),
    generation,
    mapCycle: state.map.cycle,
    explorationGeneration: state.exploration.generation,
    visionCycle: state.vision.cycle,
    transportCycle: state.transportCycle,
    controlLeaseGeneration: state.controlLease.generation,
    runtimePreparationPending: false,
    lostCount,
    detectionTracker,
    lastChatStatus: '',
  };
  if (lostCount >= APPLE_MAX_LOST_TARGET_COUNT) {
    const message = `停止後に${mission.displayName}を${APPLE_MAX_LOST_TARGET_COUNT}回見失ったため、探索を自動再開せず停止しました。安全条件を確認して再開してください。`;
    return accepted({
      ...state,
      objectSearch: { ...context, lastChatStatus: message, status: 'error', message, recoverable: true },
    }, [{ type: 'SYNC_OBJECT_SEARCH_CHAT', status: 'paused', targetClass: mission.targetClass, role: 'error', message }]);
  }

  const lostMessage = `${mission.displayName}を見失いました。探索を再開します。`;
  const pausedMission: ObjectSearchState = {
    ...context,
    lastChatStatus: lostMessage,
    status: 'paused',
    reason: 'target-lost',
    resumeAfterMapGeneration: state.explorationEvidence.mapGeneration,
  };
  const pausedState: AppState = { ...state, objectSearch: pausedMission };
  const freshness = { mapGeneration: state.explorationEvidence.mapGeneration, nowMs: event.observedAtMs };
  const unavailable = objectSearchStopEnvironmentUnavailableReason(pausedState)
    ?? explorationUnavailableReason(pausedState)
    ?? explorationFreshnessUnavailableReason(pausedState, freshness);
  if (unavailable || state.vision.status !== 'ready' || !state.vision.modelReady) {
    const reason = objectSearchPauseReasonForUnavailable(pausedState, unavailable ?? 'Visionのfreshな応答を確認できません。');
    const message = `${mission.displayName}を見失いました。${objectSearchPauseMessage(reason, mission.displayName)}`;
    return accepted({
      ...pausedState,
      objectSearch: { ...pausedMission, reason, lastChatStatus: message },
    }, [{ type: 'SYNC_OBJECT_SEARCH_CHAT', status: 'paused', targetClass: mission.targetClass, role: 'robot', message }]);
  }

  const resumed = transitionAppStateCore(pausedState, {
    type: 'EXPLORATION_RESUME_REQUESTED',
    mapGeneration: freshness.mapGeneration,
    requestedAtMs: event.observedAtMs,
  });
  if (!resumed.accepted || !explorationIsActive(resumed.state.exploration)) {
    const message = `${mission.displayName}を見失いました。${resumed.rejection ?? 'fresh mapから探索を再評価できないため一時停止しました。'}`;
    return accepted({
      ...pausedState,
      objectSearch: { ...pausedMission, lastChatStatus: message },
    }, [{ type: 'SYNC_OBJECT_SEARCH_CHAT', status: 'paused', targetClass: mission.targetClass, role: 'robot', message }]);
  }
  return accepted({
    ...resumed.state,
    objectSearch: {
      ...context,
      explorationGeneration: resumed.state.exploration.generation,
      lastChatStatus: lostMessage,
      status: 'searching',
    },
  }, [
    ...resumed.effects,
    { type: 'SYNC_OBJECT_SEARCH_CHAT', status: 'accepted', targetClass: mission.targetClass, role: 'robot', message: lostMessage },
  ]);
}

function observeObjectSearchDetection(
  state: AppState,
  event: Extract<AppEvent, { type: 'OBJECT_SEARCH_DETECTION_OBSERVED' }>,
): TransitionResult {
  const mission = state.objectSearch;
  if (mission.status !== 'searching' && mission.status !== 'confirming' && mission.status !== 'finalizing') {
    return rejected(state, '現在のObject Search stateではDetection frameを受理しません。');
  }
  const cycleRejection = objectSearchDetectionCycleRejection(state, mission, event);
  if (cycleRejection) return rejected(state, cycleRejection);
  const environmentUnavailable = objectSearchStopEnvironmentUnavailableReason(state);
  if (environmentUnavailable) return rejected(state, environmentUnavailable);
  if (mission.status === 'finalizing'
    && !objectSearchStopIsMaintained(state, mission.stopEvidence, event.observedAtMs)) {
    return accepted(state);
  }
  const observation = observeAppleDetectionFrame(mission.detectionTracker, {
    missionGeneration: event.generation,
    visionCycle: event.visionCycle,
    transportCycle: event.transportCycle,
    frameStampMs: event.frameStampMs,
    cameraFrameStampMs: event.cameraFrameStampMs,
    observedAtMs: event.observedAtMs,
    imageWidth: event.imageWidth,
    imageHeight: event.imageHeight,
    detections: event.detections,
  });
  if (!observation.accepted) return rejected(state, observation.rejection);

  if (mission.status === 'searching') {
    if (!observation.candidateConfirmed
      || !observation.selected
      || !appleDetectionIsWithinSearchRange(observation.selected)) {
      return accepted({ ...state, objectSearch: { ...mission, detectionTracker: observation.tracker } });
    }
    const positionConfirmed = true;
    const message = `${mission.displayName}をCameraで確認し、5m以内なので安全停止を開始します。`;
    return accepted({
      ...state,
      objectSearch: {
        ...objectSearchContext(mission),
        detectionTracker: observation.tracker,
        lastChatStatus: message,
        status: 'candidate',
        candidate: observation.selected,
        candidateConfirmedAtMs: event.observedAtMs,
        positionConfirmed,
      },
    }, [{ type: 'SYNC_OBJECT_SEARCH_CHAT', status: 'accepted', targetClass: mission.targetClass, role: 'robot', message }]);
  }

  if (mission.status === 'finalizing') {
    const finalizingState: AppState = {
      ...state,
      objectSearch: { ...mission, detectionTracker: observation.tracker },
    };
    if (observation.postStopConfirmed && observation.selected) {
      const message = `探索完了後のfresh Cameraで${mission.displayName}を確認しました。安全停止を実証して確定します。`;
      return accepted({
        ...finalizingState,
        objectSearch: {
          ...objectSearchContext(mission),
          detectionTracker: observation.tracker,
          lastChatStatus: message,
          status: 'candidate',
          candidate: observation.selected,
          candidateConfirmedAtMs: event.observedAtMs,
          positionConfirmed: true,
        },
      }, [{ type: 'SYNC_OBJECT_SEARCH_CHAT', status: 'accepted', targetClass: mission.targetClass, role: 'robot', message }]);
    }
    if (observation.tracker.acceptedFrameCount >= APPLE_POSTSTOP_WINDOW_FRAMES) {
      if (state.exploration.status !== 'completed') {
        return rejected(state, 'Frontier Exploration完了前は対象不在を確定しません。');
      }
      const message = `${mission.displayName}はありませんでした`;
      return accepted({
        ...finalizingState,
        objectSearch: {
          ...objectSearchContext(mission),
          detectionTracker: observation.tracker,
          lastChatStatus: message,
          status: 'not_found',
          notFoundAtMs: event.observedAtMs,
          confirmedMapGeneration: state.exploration.confirmedMapGeneration,
        },
      }, [
        { type: 'ZERO_VELOCITY' },
        { type: 'SET_NAVIGATION_STATUS', message: 'Object Search完了 / 探索可能範囲で対象なし' },
        { type: 'SYNC_OBJECT_SEARCH_CHAT', status: 'idle', targetClass: null, role: 'robot', message },
      ]);
    }
    return accepted(finalizingState);
  }

  const confirmingState: AppState = {
    ...state,
    objectSearch: { ...mission, detectionTracker: observation.tracker },
  };
  if (observation.postStopConfirmed && observation.selected) {
    if (!objectSearchStopIsMaintained(confirmingState, mission.stopEvidence, event.observedAtMs)) {
      return pauseObjectSearchDirect(confirmingState, 'navigation-unavailable', `Robotの停止証拠を維持できないため、${mission.displayName}発見を確定せず一時停止しました。`);
    }
    const message = `${mission.displayName}を見つけました`;
    const evidence = observation.selected;
    return accepted({
      ...confirmingState,
      objectSearch: {
        ...objectSearchContext(mission),
        detectionTracker: observation.tracker,
        lastChatStatus: message,
        status: 'succeeded',
        stoppedAtMs: mission.stoppedAtMs,
        foundAtMs: event.observedAtMs,
        evidence,
        stopEvidence: mission.stopEvidence,
      },
    }, [
      { type: 'ZERO_VELOCITY' },
      { type: 'SET_NAVIGATION_STATUS', message: 'Object Search成功 / manual owner・速度0・active goalなし' },
      { type: 'SYNC_OBJECT_SEARCH_CHAT', status: 'accepted', targetClass: mission.targetClass, role: 'robot', message },
    ]);
  }
  if (observation.postStopLost) return handleObjectSearchPostStopLost(confirmingState, confirmingState.objectSearch as Extract<ObjectSearchState, { status: 'confirming' }>, event);
  return accepted(confirmingState);
}

function validObjectSearchApproachGoal(goal: PoseStampedMessage, approach: AppleApproachGoal): boolean {
  const values = [
    goal.header.stamp.sec,
    goal.header.stamp.nanosec,
    goal.pose.position.x,
    goal.pose.position.y,
    goal.pose.orientation.x,
    goal.pose.orientation.y,
    goal.pose.orientation.z,
    goal.pose.orientation.w,
    approach.target.x,
    approach.target.y,
    approach.goal.x,
    approach.goal.y,
    approach.goal.yaw,
    approach.measuredDepthMeters,
    approach.cameraRangeMeters,
    approach.bearingRadians,
    approach.horizontalOffsetRatio,
    approach.requestedCameraDistanceMeters,
    approach.selectedCameraDistanceMeters,
    approach.goalClearanceMeters,
  ];
  return goal.header.frame_id === 'map'
    && values.every(Number.isFinite)
    && approach.selectedCameraDistanceMeters > 0
    && approach.goalClearanceMeters >= 0
    && Math.abs(goal.pose.position.x - approach.goal.x) <= 1e-6
    && Math.abs(goal.pose.position.y - approach.goal.y) <= 1e-6;
}

function requestObjectSearchApproach(
  state: AppState,
  event: Extract<AppEvent, { type: 'OBJECT_SEARCH_APPROACH_REQUESTED' }>,
): TransitionResult {
  const mission = state.objectSearch;
  if (mission.status !== 'candidate' || mission.positionConfirmed) {
    return rejected(state, '接近が必要なstable target candidateがありません。');
  }
  if (!Number.isFinite(event.requestedAtMs)) return rejected(state, 'Object Search接近goalの要求時刻を確認できません。');
  const cycleRejection = objectSearchDetectionCycleRejection(state, mission, event);
  if (cycleRejection) return rejected(state, cycleRejection);
  if (mission.candidate.frameStampMs !== event.candidateFrameStampMs) return rejected(state, '古いtarget candidateから接近goalを送りません。');
  if (!validObjectSearchApproachGoal(event.goal, event.approach)) return rejected(state, 'target接近goalのmap座標を確認できません。');
  const unavailable = objectSearchStopEnvironmentUnavailableReason(state);
  if (unavailable) return rejected(state, unavailable);
  if (!canEnableNavigationControl(state)) return rejected(state, 'target接近goalにはfresh live map、SLAM pose、Nav2、Transportが必要です。');
  const exploration = pausedExploration(state, 'object-found-candidate');
  if (exploration.status !== 'paused') return rejected(state, '現在のFrontier Exploration runを接近goalへ安全に引き継げません。');
  const taskId = state.nextTaskId + 1;
  const message = `${mission.displayName}を安定検出しました。Cameraから約${event.approach.selectedCameraDistanceMeters.toFixed(2)}m手前で正対する位置へNav2で接近します。`;
  const next: AppState = {
    ...state,
    command: { owner: 'navigation' },
    pendingCommandOwner: pendingNavigationOwner(event.requestedAtMs),
    navigation: { status: 'sending', taskId, source: 'object-search', goalId: null },
    exploration,
    objectSearch: {
      ...objectSearchContext(mission),
      lastChatStatus: message,
      status: 'approaching',
      candidate: mission.candidate,
      approach: event.approach,
      taskId,
      approachRequestedAtMs: event.requestedAtMs,
    },
    nextTaskId: taskId,
  };
  return accepted(next, [
    ...stoppedEffects(),
    { type: 'SET_NAVIGATION_STATUS', message: `Object Search / ${mission.displayName}正面の接近goalをNav2へ送信中` },
    { type: 'SEND_NAVIGATION_GOAL', goal: event.goal, taskId, afterCancelSettles: true },
    { type: 'SYNC_OBJECT_SEARCH_CHAT', status: 'accepted', targetClass: mission.targetClass, role: 'robot', message },
  ]);
}

function rejectObjectSearchApproach(
  state: AppState,
  event: Extract<AppEvent, { type: 'OBJECT_SEARCH_APPROACH_UNAVAILABLE' }>,
): TransitionResult {
  const mission = state.objectSearch;
  if (mission.status !== 'candidate' || mission.generation !== event.generation) {
    return rejected(state, '古いObject Search接近goalの失敗通知は使用しません。');
  }
  if (!Number.isFinite(event.requestedAtMs) || !event.reason.trim()) return rejected(state, 'Object Search接近goalの失敗理由を確認できません。');
  if (mission.candidate.frameStampMs !== event.candidateFrameStampMs) return rejected(state, '古いtarget candidateの失敗通知は使用しません。');
  return pauseObjectSearchDirect(
    state,
    'navigation-unavailable',
    `${mission.displayName}は見えていますが正面への安全な接近goalを作れないため停止しました。${event.reason}`,
  );
}

function beginObjectSearchStop(
  state: AppState,
  mission: Extract<ObjectSearchState, { status: 'candidate' | 'approaching' }>,
  requestedAtMs: number,
  navigation: NavigationTask,
  message: string,
): TransitionResult {
  const exploration = pausedExploration(state, 'object-found-candidate');
  if (exploration.status !== 'paused' && exploration.status !== 'completed') {
    return rejected(state, '現在のFrontier Exploration runを安全停止できません。');
  }
  const next = withSafeCommandState({
    ...state,
    command: { owner: 'manual' },
    pendingCommandOwner: null,
    navigation,
    exploration,
    objectSearch: {
      ...objectSearchContext(mission),
      lastChatStatus: message,
      status: 'stopping',
      candidate: mission.candidate,
      stopRequestedAtMs: requestedAtMs,
      stopEvidence: emptyObjectSearchStopEvidence(),
    },
  });
  return accepted(next, [
    ...stoppedEffects(),
    { type: 'SET_NAVIGATION_STATUS', message: `${mission.displayName}を確認 / goal終了・manual owner・速度0を確認中` },
    { type: 'SYNC_OBJECT_SEARCH_CHAT', status: 'accepted', targetClass: mission.targetClass, role: 'robot', message },
  ]);
}

function requestObjectSearchSafeStop(
  state: AppState,
  event: Extract<AppEvent, { type: 'OBJECT_SEARCH_SAFE_STOP_REQUESTED' }>,
): TransitionResult {
  const mission = state.objectSearch;
  if (mission.status !== 'candidate') return rejected(state, 'stable target candidateがないため停止処理を開始しません。');
  if (!mission.positionConfirmed) return rejected(state, `Camera内かつ5m以内の${mission.displayName}候補を確認する前は成功停止を開始しません。`);
  if (!Number.isFinite(event.requestedAtMs)) return rejected(state, 'Object Search停止要求の時刻を確認できません。');
  const cycleRejection = objectSearchDetectionCycleRejection(state, mission, event);
  if (cycleRejection) return rejected(state, cycleRejection);
  if (mission.candidate.frameStampMs !== event.candidateFrameStampMs) return rejected(state, '古いtarget candidate callbackは使用しません。');
  const unavailable = objectSearchStopEnvironmentUnavailableReason(state);
  if (unavailable) return rejected(state, unavailable);
  const message = `${mission.displayName}をCameraで確認し、5m以内です。goal取消、manual owner、速度0の実証を待っています。`;
  return beginObjectSearchStop(state, mission, event.requestedAtMs, canceledNavigation(state.navigation), message);
}

function transitionAppStateCore(state: AppState, event: AppEvent): TransitionResult {
  switch (event.type) {
    case 'RUNTIME_SWITCH_REQUESTED': {
      if (state.runtime.status === 'switching') {
        if (state.runtime.target === event.target) return accepted(state);
        return rejected(state, '別のruntime切替が進行中です。完了後にもう一度操作してください。');
      }
      if (state.runtime.status === 'stable' && state.runtime.mode === event.target) return accepted(state);
      const next = runtimeSwitchState(state, event.target);
      const effects = stoppedEffects('runtime');
      if (state.view.mode === 'stage') effects.push({ type: 'EXIT_STAGE' });
      if (event.target === 'navigation' && currentRuntimeMode(state) !== 'navigation') effects.push({ type: 'RESET_NAVIGATION_ORIGIN' });
      effects.push({ type: 'REQUEST_RUNTIME', mode: event.target });
      return accepted(next, effects);
    }
    case 'RUNTIME_MANAGER_OBSERVED': {
      const snapshot = event.snapshot;
      if (!isRuntimeMode(snapshot.mode) || !isRuntimeMode(snapshot.target)) return rejected(state);
      if (snapshot.processing) {
        if (state.runtime.status === 'switching' && state.runtime.target === snapshot.target) {
          const phase = snapshot.phase === 'closing' || snapshot.target === 'sim' ? 'closing' : 'processing';
          return accepted({ ...state, runtime: { status: 'switching', mode: state.runtime.mode, target: state.runtime.target, phase } });
        }
        const next = runtimeSwitchState(state, snapshot.target);
        const effects = stoppedEffects('runtime');
        if (state.view.mode === 'stage') effects.push({ type: 'EXIT_STAGE' });
        if (snapshot.target === 'navigation' && currentRuntimeMode(state) !== 'navigation') effects.push({ type: 'RESET_NAVIGATION_ORIGIN' });
        return accepted(next, effects);
      }
      if (snapshot.error) {
        const target = snapshot.target === 'mapping' || snapshot.target === 'navigation' || snapshot.target === 'exploration' ? snapshot.target : 'mapping';
        const next: AppState = {
          ...state,
          runtime: { status: 'error', mode: snapshot.mode, target: snapshot.target, message: snapshot.error },
          map: state.map.status === 'initializing' || state.map.status === 'resetting'
            ? { status: 'error', target, message: snapshot.error, cycle: state.map.cycle }
            : state.map,
          command: { owner: 'stopped', reason: 'runtime-error' },
          pendingCommandOwner: null,
          navigation: canceledNavigation(state.navigation),
          exploration: pausedExploration(state, 'runtime-change'),
        };
        return accepted(next, [...stoppedEffects('runtime'), { type: 'SET_NAVIGATION_STATUS', message: 'runtime切替エラー / 停止中' }, { type: 'ANNOUNCE', message: snapshot.error }]);
      }
      return observeStableRuntime(state, snapshot.mode);
    }
    case 'TRANSPORT_CHANGED': {
      if (state.transport === event.connection) return accepted(state);
      const expectedConnectionTransition = currentRuntimeMode(state) === 'sim' || state.transport === 'SIMULATED';
      const startsUnavailableSession = (state.transport === 'CONNECTED' || state.transport === 'SIMULATED')
        && (event.connection === 'CONNECTING'
          || event.connection === 'RECONNECTING'
          || event.connection === 'DISCONNECTED'
          || event.connection === 'ERROR');
      let next: AppState = { ...state, transport: event.connection, transportCycle: state.transportCycle + 1 };
      const effects: AppEffect[] = [];
      let shouldClearRuntimeData = false;
      if (event.connection === 'CONNECTING' || event.connection === 'RECONNECTING' || event.connection === 'DISCONNECTED' || event.connection === 'ERROR') {
        const mode = state.runtime.status === 'switching' ? state.runtime.target : currentRuntimeMode(next);
        if (mode === 'mapping' || mode === 'navigation' || mode === 'exploration') {
          if (event.connection === 'ERROR') {
            // main.ts retries rosbridge automatically.  Keep the active
            // readiness cycle locked instead of exposing a transient map
            // error between retry attempts.  A connection lost after ready
            // still starts a new cycle so delayed map/pose callbacks cannot
            // revive the old session.
            const alreadyInitializingTarget = next.map.status === 'initializing' && next.map.target === mode;
            if (!alreadyInitializingTarget || startsUnavailableSession) {
              const readiness = nextReadiness(next, mode, 'reconnect');
              next = { ...next, ...readiness };
            }
          } else if (next.map.status !== 'resetting' && startsUnavailableSession) {
            const readiness = nextReadiness(next, mode, 'reconnect');
            next = { ...next, ...readiness };
          }
          shouldClearRuntimeData = true;
        }
        next = {
          ...next,
          command: { owner: 'stopped', reason: 'transport' },
          pendingCommandOwner: null,
          navigation: canceledNavigation(next.navigation),
          exploration: pausedExploration(state, 'transport'),
        };
        effects.push(...stoppedEffects('none'));
        if (shouldClearRuntimeData) effects.push({ type: 'CLEAR_RUNTIME_DATA' });
        effects.push({ type: 'SET_NAVIGATION_STATUS', message: event.connection === 'ERROR' ? 'ROS接続エラー' : 'ROS切断 / 停止中' });
        if (event.connection !== 'ERROR' && !expectedConnectionTransition) effects.push({ type: 'ANNOUNCE', message: 'rosbridgeとの接続が切れたため速度を0にしました。再接続を待つか、SIMモードへ戻って学習を続けられます。' });
      } else {
        const mode = currentRuntimeMode(next);
        if (event.connection === 'CONNECTED' && (mode === 'mapping' || mode === 'navigation' || mode === 'exploration') && next.map.status === 'error') {
          const readiness = nextReadiness(next, mode, 'reconnect');
          next = { ...next, ...readiness };
          effects.push({ type: 'CLEAR_RUNTIME_DATA' });
        }
        next = withSafeCommandState(next);
        if (!isInteractionLocked(next) && next.command.owner === 'manual') {
          effects.push({ type: 'SET_COMMAND_OWNER', owner: 'manual' });
        }
      }
      return accepted(next, effects);
    }
    case 'MAP_RECEIVED': {
      if (event.cycle !== state.map.cycle) return rejected(state, '古いreadiness cycleのmapは使用しません。');
      if (state.transport !== 'CONNECTED') return rejected(state, 'ROS2未接続時のmap callbackは使用しません。');
      if (state.runtime.status !== 'stable') return rejected(state);
      const readiness = state.map;
      if (state.runtime.mode !== 'mapping' && state.runtime.mode !== 'navigation' && state.runtime.mode !== 'exploration') return rejected(state);
      if (readiness.status === 'ready') return readiness.mode === state.runtime.mode ? accepted(state) : rejected(state);
      if (readiness.status !== 'initializing' || readiness.target !== state.runtime.mode) return rejected(state);
      if (readiness.mapReceived) return accepted(state);
      const next = { ...state, map: { ...readiness, mapReceived: true } };
      return completeReadiness(next) ?? accepted(next);
    }
    case 'POSE_READY': {
      const readiness = state.map;
      if (event.cycle !== readiness.cycle) return rejected(state, '古いreadiness cycleのposeは使用しません。');
      if (state.transport !== 'CONNECTED') return rejected(state, 'ROS2未接続時のpose callbackは使用しません。');
      if (state.runtime.status !== 'stable'
        || (state.runtime.mode !== 'navigation' && state.runtime.mode !== 'exploration')
        || readiness.status !== 'initializing'
        || readiness.target !== state.runtime.mode
        || readiness.poseReceived) return accepted(state);
      const next = { ...state, map: { ...readiness, poseReceived: true } };
      return completeReadiness(next) ?? accepted(next);
    }
    case 'EXPLORATION_MAP_OBSERVED': {
      if (event.cycle !== state.map.cycle) return rejected(state, '古いreadiness cycleのexploration mapは使用しません。');
      if (state.runtime.status !== 'stable' || state.runtime.mode !== 'exploration' || state.transport !== 'CONNECTED') return rejected(state);
      if (!Number.isInteger(event.mapGeneration) || event.mapGeneration < 0 || !Number.isFinite(event.observedAtMs)) return rejected(state, 'live mapのfreshness evidenceを確認できません。');
      const previous = state.explorationEvidence;
      if (previous.cycle === event.cycle && event.mapGeneration <= previous.mapGeneration) return rejected(state, '古いmap generationのfreshness evidenceは使用しません。');
      const evidence: ExplorationEvidence = {
        cycle: event.cycle,
        mapGeneration: event.mapGeneration,
        mapObservedAtMs: event.observedAtMs,
        poseObservedAtMs: previous.cycle === event.cycle ? previous.poseObservedAtMs : null,
      };
      return accepted({ ...state, explorationEvidence: evidence });
    }
    case 'EXPLORATION_POSE_OBSERVED': {
      if (event.cycle !== state.map.cycle) return rejected(state, '古いreadiness cycleのexploration poseは使用しません。');
      if (state.runtime.status !== 'stable' || state.runtime.mode !== 'exploration' || state.transport !== 'CONNECTED') return rejected(state);
      if (!Number.isFinite(event.observedAtMs)) return rejected(state, 'SLAM poseのfreshness evidenceを確認できません。');
      const previous = state.explorationEvidence;
      if (previous.cycle === event.cycle && previous.poseObservedAtMs !== null) {
        if (event.observedAtMs < previous.poseObservedAtMs) return rejected(state, '古いSLAM poseのfreshness evidenceは使用しません。');
        if (event.observedAtMs === previous.poseObservedAtMs) return accepted(state);
      }
      const evidence: ExplorationEvidence = {
        cycle: event.cycle,
        mapGeneration: previous.cycle === event.cycle ? previous.mapGeneration : 0,
        mapObservedAtMs: previous.cycle === event.cycle ? previous.mapObservedAtMs : null,
        poseObservedAtMs: event.observedAtMs,
      };
      return accepted({ ...state, explorationEvidence: evidence });
    }
    case 'NAVIGATION_READY': {
      const readiness = state.map;
      if (event.cycle !== readiness.cycle) return rejected(state, '古いreadiness cycleのNav2準備完了は使用しません。');
      if (state.runtime.status !== 'stable' || state.runtime.mode !== 'exploration') return rejected(state);
      if (readiness.status === 'ready' && readiness.mode === 'exploration') return accepted(state);
      if (readiness.status !== 'initializing' || readiness.target !== 'exploration') return rejected(state);
      if (readiness.navigationReceived) return accepted(state);
      const next = { ...state, map: { ...readiness, navigationReceived: true } };
      return completeReadiness(next) ?? accepted(next);
    }
    case 'NAVIGATION_UNAVAILABLE': {
      const readiness = state.map;
      if (event.cycle !== readiness.cycle) return rejected(state, '古いreadiness cycleのNav2停止通知は使用しません。');
      if (state.runtime.status !== 'stable' || state.runtime.mode !== 'exploration') return rejected(state);
      const cycle = state.nextMapCycle + 1;
      const map: MapReadiness = readiness.status === 'ready' && readiness.mode === 'exploration'
        ? {
            status: 'initializing',
            target: 'exploration',
            reason: 'navigation-health',
            mapReceived: false,
            poseReceived: false,
            navigationReceived: false,
            cycle,
          }
        : readiness.status === 'initializing' && readiness.target === 'exploration' && readiness.navigationReceived
          ? { ...readiness, reason: 'navigation-health', mapReceived: false, poseReceived: false, navigationReceived: false, cycle }
          : readiness;
      if (map === readiness) return readiness.status === 'initializing' && readiness.target === 'exploration'
        ? accepted(state)
        : rejected(state);
      const next = withSafeCommandState({
        ...state,
        map,
        nextMapCycle: cycle,
        navigation: canceledNavigation(state.navigation),
        exploration: pausedExploration(state, 'navigation-unavailable'),
      });
      return accepted(next, [
        ...stoppedEffects(),
        { type: 'SET_NAVIGATION_STATUS', message: event.status },
      ]);
    }
    case 'MAP_RESET_REQUESTED': {
      if (isInteractionLocked(state)) return rejected(state, '別の初期化処理が進行中です。完了後に現在マップをリセットしてください。');
      if (state.view.mode !== 'sim') return rejected(state, 'STAGE編集中は現在マップをリセットできません。SIMへ戻ってから実行してください。');
      if (state.runtime.status !== 'stable' || (state.runtime.mode !== 'mapping' && state.runtime.mode !== 'navigation' && state.runtime.mode !== 'exploration')) return rejected(state, '現在マップのリセットはmapping、navigation、またはexploration構成で実行してください。');
      if (state.transport !== 'CONNECTED') return rejected(state, '現在マップのリセットはROS2へ接続してから実行してください。');
      const cycle = state.nextMapCycle + 1;
      const switching = state.runtime.mode === 'navigation';
      const next: AppState = {
        ...state,
        runtime: switching ? { status: 'switching', mode: 'navigation', target: 'mapping', phase: 'processing' } : state.runtime,
        map: { status: 'resetting', phase: switching ? 'switching-to-mapping' : 'requesting-reset', cycle },
        nextMapCycle: cycle,
        command: { owner: 'stopped', reason: 'map-initialization' },
        pendingCommandOwner: null,
        view: { mode: 'sim' },
        navigation: canceledNavigation(state.navigation),
        exploration: clearedExploration(state.exploration),
      };
      const effects = stoppedEffects('runtime');
      effects.push({ type: 'CLEAR_EXPLORATION_DATA' });
      effects.push(switching ? { type: 'REQUEST_RUNTIME', mode: 'mapping' } : { type: 'REQUEST_MAP_RESET' });
      return accepted(next, effects);
    }
    case 'MAP_RESET_COMPLETED': {
      if (state.map.status !== 'resetting' || state.map.phase !== 'requesting-reset') return rejected(state);
      const target = state.runtime.status === 'stable' && state.runtime.mode === 'exploration' ? 'exploration' : 'mapping';
      if (!event.success) {
        const next = withSafeCommandState({ ...state, map: { status: 'error', target, message: event.error || '現在マップのリセットに失敗しました。', cycle: state.map.cycle } });
        return accepted(next, [
          { type: 'SET_NAVIGATION_STATUS', message: '現在マップのリセットに失敗しました' },
          { type: 'ANNOUNCE', message: event.error || 'SLAM Toolboxの地図をリセットできませんでした。mappingモードとROSログを確認してください。' },
        ]);
      }
      const next: AppState = {
        ...state,
        map: { status: 'initializing', target, reason: 'map-reset', mapReceived: false, poseReceived: false, navigationReceived: false, cycle: state.map.cycle },
        command: { owner: 'stopped', reason: 'map-initialization' },
      };
      return accepted(next, [
        { type: 'CLEAR_RUNTIME_DATA' },
        { type: 'SET_NAVIGATION_STATUS', message: '現在マップをリセットしました / 新しいmapを待機中…' },
      ]);
    }
    case 'VIEW_REQUESTED': {
      if (state.view.mode === event.view) return accepted(state);
      if (event.view === 'stage') {
        if (isInteractionLocked(state)) return rejected(state, 'runtimeまたはmapの初期化中はSTAGEへ切り替えられません。完了を待ってください。');
        const next: AppState = {
          ...state,
          view: { mode: 'stage', surface: 'plan', gesture: 'idle' },
          command: { owner: 'stopped', reason: 'stage' },
          pendingCommandOwner: null,
          navigation: canceledNavigation(state.navigation),
          exploration: pausedExploration(state, 'stage'),
        };
        return accepted(next, [...stoppedEffects(), { type: 'ENTER_STAGE' }]);
      }
      const next = withSafeCommandState({ ...state, view: { mode: 'sim' } });
      return accepted(next, [{ type: 'RELEASE_USER_INPUT' }, { type: 'ZERO_VELOCITY' }, { type: 'EXIT_STAGE' }, ...(next.command.owner === 'manual' ? [{ type: 'SET_COMMAND_OWNER', owner: 'manual' } as const] : [])]);
    }
    case 'STAGE_SURFACE_REQUESTED': {
      if (state.view.mode !== 'stage') return rejected(state);
      if (state.view.surface === event.surface) return accepted(state);
      return accepted({ ...state, view: { ...state.view, surface: event.surface, gesture: 'idle' } }, [{ type: 'SET_STAGE_SURFACE', surface: event.surface }]);
    }
    case 'STAGE_GESTURE_CHANGED': {
      if (state.view.mode !== 'stage') return rejected(state);
      const gesture = event.active ? 'active' : 'idle';
      if (state.view.gesture === gesture) return accepted(state);
      return accepted({ ...state, view: { ...state.view, gesture } });
    }
    case 'ROBOT_ORIGIN_RESET_REQUESTED': {
      if (isInteractionLocked(state)) return rejected(state, 'runtimeまたはmapの初期化完了後に初期位置へ戻してください。');
      const resetPausesExploration = explorationIsActive(state.exploration) || state.exploration.status === 'paused';
      const next = withSafeCommandState({
        ...state,
        pendingCommandOwner: null,
        navigation: canceledNavigation(state.navigation),
        exploration: pausedExploration(state, 'origin-reset'),
        command: state.view.mode === 'stage' ? { owner: 'stopped', reason: 'stage' } : { owner: 'manual' },
      });
      return accepted(next, [
        ...stoppedEffects(),
        { type: 'RESET_ROBOT_ORIGIN' },
        { type: 'SET_NAVIGATION_STATUS', message: '自機を初期位置へ戻しました / 速度0' },
        {
          type: 'ANNOUNCE',
          message: resetPausesExploration
            ? 'goalと速度を停止して、自機を初期位置へ戻しました。探索を続ける場合はfresh mapを待って「再開」を押してください。'
            : currentRuntimeMode(state) === 'navigation'
              ? 'goalと速度を停止して、自機を初期位置へ戻しました。地図上の現在位置が同期してから次の目標を送ってください。'
              : 'goalと速度を停止して、自機を初期位置へ戻しました。',
        },
      ]);
    }
    case 'COMMAND_OWNER_REQUESTED': {
      if (!Number.isFinite(event.requestedAtMs)) return rejected(state, 'command ownerの切替時刻を確認できません。');
      if (event.owner === 'navigation' && objectSearchCanBePaused(state.objectSearch)) {
        return rejected(state, 'Object Search Mission中はoperatorのNav2操作へ切り替えられません。先に探索を一時停止または中止してください。');
      }
      if (event.owner === 'navigation' && explorationIsActive(state.exploration)) {
        return rejected(state, '探索中はoperatorのNav2操作へ切り替えられません。探索を一時停止してから操作してください。');
      }
      if (event.owner === 'navigation' && !canEnableNavigationControl(state)) return rejected(state, 'NAV2 activated後、mapと自機位置の同期が完了してからNav2操作へ切り替えてください。');
      if (event.owner === 'manual'
        && ((state.map.status === 'initializing' && state.map.reason === 'navigation-health')
          || isInteractionLocked(state)
          || state.view.mode !== 'sim'
          || !transportReady(state))) return rejected(state, '現在は安全ロック中のため手動操作へ切り替えられません。');
      if (event.owner === 'manual' && explorationIsActive(state.exploration)) {
        const next = withSafeCommandState({
          ...state,
          command: { owner: 'manual' },
          navigation: canceledNavigation(state.navigation),
          exploration: pausedExploration(state, 'manual-override'),
        });
        return accepted(next, [
          ...stoppedEffects(),
          { type: 'SET_NAVIGATION_STATUS', message: '手動操作へ切り替えたため探索を一時停止しました' },
          { type: 'ANNOUNCE', message: '探索を一時停止して手動操作へ切り替えました。再開時はfresh mapから候補を選び直します。' },
        ]);
      }
      if (state.command.owner === event.owner) return accepted(state);
      const navigation = event.owner === 'manual' ? canceledNavigation(state.navigation) : state.navigation;
      const effects: AppEffect[] = [];
      if (event.owner === 'manual' && navigationTaskIsActive(state.navigation)) effects.push({ type: 'CANCEL_NAVIGATION_GOAL' }, { type: 'ZERO_VELOCITY' }, { type: 'CLEAR_GOAL_DATA' });
      effects.push({ type: 'SET_COMMAND_OWNER', owner: event.owner });
      return accepted({
        ...state,
        command: { owner: event.owner },
        pendingCommandOwner: event.owner === 'navigation' ? pendingNavigationOwner(event.requestedAtMs) : null,
        navigation,
      }, effects);
    }
    case 'COMMAND_OWNER_OBSERVED': {
      if (!Number.isFinite(event.observedAtMs)) return rejected(state, 'command ownerの観測時刻を確認できません。');
      const pending = state.pendingCommandOwner;
      if (pending && state.command.owner === pending.owner) {
        if (event.observedAtMs <= pending.expiresAtMs) {
          if (event.owner === pending.owner && !pending.acknowledged) {
            return accepted({ ...state, pendingCommandOwner: { ...pending, acknowledged: true } });
          }
          return accepted(state);
        }
        if (event.owner === pending.owner) return accepted({ ...state, pendingCommandOwner: null });
      }
      const observedState = pending ? { ...state, pendingCommandOwner: null } : state;
      if (event.owner === 'navigation'
        && observedState.command.owner !== 'navigation'
        && explorationIsActive(observedState.exploration)) {
        const explorationOwnsActiveTask = navigationTaskIsActive(observedState.navigation)
          && observedState.navigation.source === 'exploration'
          && (observedState.exploration.status === 'sending' || observedState.exploration.status === 'moving');
        if (explorationOwnsActiveTask) {
          return accepted({ ...observedState, command: { owner: 'navigation' } });
        }
        // Command Gate repeats its retained mode every second. A delayed
        // navigation echo can arrive after a successful goal has already
        // switched the reducer to manual/replanning. Reassert manual instead
        // of misclassifying that internal echo as an operator goal.
        return accepted(observedState, [
          { type: 'SET_COMMAND_OWNER', owner: 'manual' },
          { type: 'ZERO_VELOCITY' },
          { type: 'SET_NAVIGATION_STATUS', message: 'Command Gate ownerを手動へ再同期 / 探索を継続' },
        ]);
      }
      if (event.owner === 'navigation'
        && !canEnableNavigationControl(observedState)
        && !navigationRecoveryMayContinue(observedState)) {
        return accepted({ ...observedState, command: stoppedReasonForState(observedState) }, [{ type: 'SET_COMMAND_OWNER', owner: 'manual' }, { type: 'ZERO_VELOCITY' }]);
      }
      if (event.owner === 'navigation'
        && observedState.command.owner !== 'navigation'
        && !navigationTaskIsActive(observedState.navigation)) {
        return accepted(observedState, [{ type: 'SET_COMMAND_OWNER', owner: 'manual' }, { type: 'ZERO_VELOCITY' }]);
      }
      if (event.owner === 'manual' && observedState.command.owner === 'stopped') return accepted(observedState);
      if (observedState.command.owner === event.owner) return accepted(observedState);
      if (event.owner === 'manual' && navigationTaskIsActive(observedState.navigation)) {
        return accepted({
          ...observedState,
          command: { owner: 'manual' },
          navigation: canceledNavigation(observedState.navigation),
          exploration: pausedExploration(observedState, 'manual-override'),
        }, [{ type: 'CANCEL_NAVIGATION_GOAL' }, { type: 'ZERO_VELOCITY' }, { type: 'CLEAR_GOAL_DATA' }]);
      }
      return accepted({ ...observedState, command: { owner: event.owner } });
    }
    case 'NAVIGATION_GOAL_REQUESTED': {
      if (!Number.isFinite(event.requestedAtMs)) return rejected(state, 'Nav2 goalの要求時刻を確認できません。');
      if (objectSearchCanBePaused(state.objectSearch)) {
        return rejected(state, 'Object Search Mission中はoperatorのNav2 goalを送信できません。先に探索を一時停止または中止してください。');
      }
      if (explorationIsActive(state.exploration)) return rejected(state, '探索中はoperator目標を送れません。探索を一時停止してから目標を指定してください。');
      if (!canEnableNavigationControl(state)) return rejected(state, '目標を送るにはNAV2 activated後、mapと自機位置の同期完了を待ってください。');
      const taskId = state.nextTaskId + 1;
      const next: AppState = {
        ...state,
        command: { owner: 'navigation' },
        pendingCommandOwner: pendingNavigationOwner(event.requestedAtMs),
        navigation: { status: 'sending', taskId, source: 'operator', goalId: null },
        nextTaskId: taskId,
      };
      return accepted(next, [
        { type: 'SET_COMMAND_OWNER', owner: 'navigation' },
        { type: 'SET_NAVIGATION_STATUS', message: 'Nav2へ目標を送信中' },
        { type: 'SEND_NAVIGATION_GOAL', goal: event.goal, taskId },
      ]);
    }
    case 'NAVIGATION_GOAL_ACCEPTED': {
      if (state.navigation.taskId !== event.taskId || state.navigation.status !== 'sending') return rejected(state);
      if (state.navigation.source === 'exploration'
        && (state.exploration.status !== 'sending' || state.exploration.taskId !== event.taskId)) return rejected(state);
      if (state.navigation.source === 'object-search'
        && (state.objectSearch.status !== 'approaching' || state.objectSearch.taskId !== event.taskId)) return rejected(state);
      return accepted({ ...state, navigation: { ...state.navigation, goalId: event.goalId } });
    }
    case 'NAVIGATION_GOAL_FEEDBACK': {
      if (state.navigation.taskId !== event.taskId || (state.navigation.status !== 'sending' && state.navigation.status !== 'moving')) return rejected(state);
      const next: NavigationTask = { status: 'moving', taskId: event.taskId, source: state.navigation.source, goalId: state.navigation.goalId };
      if (state.navigation.source === 'exploration') {
        const exploration = state.exploration;
        if ((exploration.status !== 'sending' && exploration.status !== 'moving') || exploration.taskId !== event.taskId) return rejected(state);
        const nextExploration: ExplorationState = {
          ...explorationContext(exploration),
          status: 'moving',
          taskId: event.taskId,
          selected: exploration.selected,
        };
        return accepted({ ...state, navigation: next, exploration: nextExploration }, [{ type: 'SET_NAVIGATION_STATUS', message: '選択したfrontierへ自律走行中' }]);
      }
      if (state.navigation.source === 'object-search') {
        if (state.objectSearch.status !== 'approaching' || state.objectSearch.taskId !== event.taskId) return rejected(state);
        return accepted({ ...state, navigation: next }, [{ type: 'SET_NAVIGATION_STATUS', message: `${state.objectSearch.displayName}の正面へNav2で接近中` }]);
      }
      return accepted({ ...state, navigation: next }, [{ type: 'SET_NAVIGATION_STATUS', message: '経路に沿って自律走行中' }]);
    }
    case 'NAVIGATION_GOAL_SUCCEEDED': {
      if (state.navigation.taskId !== event.taskId || (state.navigation.status !== 'sending' && state.navigation.status !== 'moving')) return rejected(state);
      if (state.navigation.source === 'object-search') {
        const mission = state.objectSearch;
        if (mission.status !== 'approaching' || mission.taskId !== event.taskId) return rejected(state);
        if (!Number.isFinite(event.completedAtMs)) return rejected(state, 'target接近goalの到着時刻を確認できません。');
        const navigation: NavigationTask = { status: 'succeeded', taskId: event.taskId, source: 'object-search' };
        const message = `${mission.displayName}の正面へ到着しました。停止後のCameraで位置と距離を再確認します。`;
        return beginObjectSearchStop(state, mission, event.completedAtMs as number, navigation, message);
      }
      if (state.navigation.source === 'exploration') {
        const exploration = state.exploration;
        if ((exploration.status !== 'sending' && exploration.status !== 'moving') || exploration.taskId !== event.taskId) return rejected(state);
        const afterMapGeneration = latestObservedExplorationMapGeneration(state, exploration);
        const context: ExplorationRunContext = {
          ...explorationContext(exploration),
          lastMapGeneration: afterMapGeneration,
          retryCount: 0,
          replanCount: exploration.replanCount + 1,
        };
        const nextExploration: ExplorationState = {
          ...context,
          status: 'replanning',
          reason: 'goal-succeeded',
          afterMapGeneration,
          requireFreshMap: true,
        };
        const next = withSafeCommandState({
          ...state,
          navigation: { status: 'succeeded', taskId: event.taskId, source: 'exploration' },
          exploration: nextExploration,
          command: { owner: 'manual' },
        });
        return accepted(next, [
          { type: 'SET_COMMAND_OWNER', owner: 'manual' },
          { type: 'ZERO_VELOCITY' },
          { type: 'SET_NAVIGATION_STATUS', message: 'frontierへ到着 / fresh mapを待って再計画します' },
          explorationWaitEffect(context, afterMapGeneration, true),
        ]);
      }
      const next = withSafeCommandState({ ...state, navigation: { status: 'succeeded', taskId: event.taskId, source: state.navigation.source }, command: { owner: 'manual' } });
      return accepted(next, [{ type: 'SET_COMMAND_OWNER', owner: 'manual' }, { type: 'ZERO_VELOCITY' }, { type: 'SET_NAVIGATION_STATUS', message: '目標へ到着しました' }]);
    }
    case 'NAVIGATION_GOAL_FAILED': {
      if (state.navigation.taskId !== event.taskId || (state.navigation.status !== 'sending' && state.navigation.status !== 'moving')) return rejected(state);
      if (state.navigation.source === 'object-search') {
        const mission = state.objectSearch;
        if (mission.status !== 'approaching' || mission.taskId !== event.taskId) return rejected(state);
        const outcome = event.canceled ? '取り消されました' : `失敗しました（${event.error}）`;
        return pauseObjectSearchDirect(
          state,
          'navigation-unavailable',
          `${mission.displayName}正面へのNav2接近goalが${outcome}。Robotを停止し、自動再開しません。`,
        );
      }
      if (state.navigation.source === 'exploration') {
        const exploration = state.exploration;
        if ((exploration.status !== 'sending' && exploration.status !== 'moving') || exploration.taskId !== event.taskId) return rejected(state);
        const afterMapGeneration = latestObservedExplorationMapGeneration(state, exploration);
        if (event.transient === 'stale-transform' || event.transient === 'navigation-recovery') {
          const context: ExplorationRunContext = {
            ...explorationContext(exploration),
            lastMapGeneration: afterMapGeneration,
            replanCount: exploration.replanCount + 1,
          };
          const recoveryReason: ExplorationReplanReason = event.transient === 'stale-transform'
            ? 'navigation-transform-stale'
            : 'navigation-recovery';
          const recoveryStatus = event.transient === 'stale-transform'
            ? 'SLAM TF同期待ち / goal失敗に数えず再計画'
            : 'SLAM map・TF・costmap同期待ち / goal失敗に数えず再計画';
          const navigation: NavigationTask = { status: 'failed', taskId: event.taskId, source: 'exploration', error: event.error };
          const next = withSafeCommandState({
            ...state,
            navigation,
            exploration: {
              ...context,
              status: 'replanning',
              reason: recoveryReason,
              afterMapGeneration,
              requireFreshMap: true,
            },
            command: { owner: 'manual' },
          });
          return accepted(next, [
            { type: 'CANCEL_NAVIGATION_GOAL' },
            { type: 'SET_COMMAND_OWNER', owner: 'manual' },
            { type: 'ZERO_VELOCITY' },
            { type: 'CLEAR_GOAL_DATA' },
            { type: 'SET_NAVIGATION_STATUS', message: recoveryStatus },
            explorationWaitEffect(context, afterMapGeneration, true),
          ]);
        }
        const retryCount = exploration.retryCount + 1;
        const blacklistedCandidateIds = appendExplorationBlacklist(exploration.blacklistedCandidateIds, exploration.selected.candidateId);
        const context: ExplorationRunContext = {
          ...explorationContext(exploration),
          lastMapGeneration: afterMapGeneration,
          retryCount,
          blacklistedCandidateIds,
        };
        const navigation: NavigationTask = event.canceled
          ? { status: 'canceled', taskId: event.taskId, source: 'exploration' }
          : { status: 'failed', taskId: event.taskId, source: 'exploration', error: event.error };
        if (retryCount >= MAX_EXPLORATION_RETRIES) {
          const next = withSafeCommandState({
            ...state,
            navigation,
            exploration: {
              ...context,
              status: 'error',
              message: `連続するgoal失敗が自動再試行上限（${MAX_EXPLORATION_RETRIES}回）に達しました。`,
              recoverable: true,
              resumeAfterMapGeneration: afterMapGeneration,
            },
            command: { owner: 'manual' },
          });
          return accepted(next, [
            { type: 'CANCEL_NAVIGATION_GOAL' },
            { type: 'SET_COMMAND_OWNER', owner: 'manual' },
            { type: 'ZERO_VELOCITY' },
            { type: 'CLEAR_GOAL_DATA' },
            { type: 'SET_NAVIGATION_STATUS', message: '探索error / 再計画上限に到達' },
            { type: 'ANNOUNCE', message: `探索を停止しました。Nav2 goalの失敗または取消が${MAX_EXPLORATION_RETRIES}回続きました。` },
          ]);
        }
        const reason: ExplorationReplanReason = event.canceled ? 'goal-canceled' : 'goal-failed';
        const replanningContext: ExplorationRunContext = { ...context, replanCount: context.replanCount + 1 };
        const nextExploration: ExplorationState = {
          ...replanningContext,
          status: 'replanning',
          reason,
          afterMapGeneration,
          requireFreshMap: true,
        };
        const next = withSafeCommandState({ ...state, navigation, exploration: nextExploration, command: { owner: 'manual' } });
        return accepted(next, [
          { type: 'CANCEL_NAVIGATION_GOAL' },
          { type: 'SET_COMMAND_OWNER', owner: 'manual' },
          { type: 'ZERO_VELOCITY' },
          { type: 'CLEAR_GOAL_DATA' },
          { type: 'SET_NAVIGATION_STATUS', message: event.canceled ? '探索goal取消 / 候補を除外して再計画' : `探索goal失敗 / 再計画: ${event.error}` },
          explorationWaitEffect(replanningContext, afterMapGeneration, true),
        ]);
      }
      const navigation: NavigationTask = event.canceled
        ? { status: 'canceled', taskId: event.taskId, source: state.navigation.source }
        : { status: 'failed', taskId: event.taskId, source: state.navigation.source, error: event.error };
      const next = withSafeCommandState({ ...state, navigation, command: { owner: 'manual' } });
      return accepted(next, [{ type: 'SET_COMMAND_OWNER', owner: 'manual' }, { type: 'ZERO_VELOCITY' }, { type: 'SET_NAVIGATION_STATUS', message: event.canceled ? 'Nav2停止: 目標を取り消しました' : `Nav2停止: ${event.error}` }]);
    }
    case 'EXPLORATION_RECOVERY_DIVERSION_REQUESTED': {
      const navigation = state.navigation;
      const exploration = state.exploration;
      if (state.safety.stopped) return rejected(state, 'Safety stop解除後に遠方frontierへ変更します。');
      if ((navigation.status !== 'sending' && navigation.status !== 'moving')
        || navigation.source !== 'exploration'
        || navigation.taskId !== event.taskId
        || (exploration.status !== 'sending' && exploration.status !== 'moving')
        || exploration.taskId !== event.taskId) return rejected(state);
      const afterMapGeneration = latestObservedExplorationMapGeneration(state, exploration);
      const context: ExplorationRunContext = {
        ...explorationContext(exploration),
        lastMapGeneration: afterMapGeneration,
        replanCount: exploration.replanCount + 1,
        blacklistedCandidateIds: appendExplorationBlacklist(exploration.blacklistedCandidateIds, exploration.selected.candidateId),
      };
      const nextExploration: ExplorationState = {
        ...context,
        status: 'replanning',
        reason: 'recovery-diversion',
        afterMapGeneration,
        requireFreshMap: false,
      };
      const next = withSafeCommandState({
        ...state,
        navigation: { status: 'canceled', taskId: event.taskId, source: 'exploration' },
        exploration: nextExploration,
        command: { owner: 'manual' },
      });
      return accepted(next, [
        { type: 'CANCEL_NAVIGATION_GOAL' },
        { type: 'SET_COMMAND_OWNER', owner: 'manual' },
        { type: 'ZERO_VELOCITY' },
        { type: 'CLEAR_GOAL_DATA' },
        { type: 'SET_NAVIGATION_STATUS', message: 'BackUp成功 / 現在goalを取消して遠方frontierへ変更' },
        explorationWaitEffect(context, afterMapGeneration, false),
      ]);
    }
    case 'NAVIGATION_GOAL_CANCEL_REQUESTED': {
      const navigation = state.navigation.status === 'sending' || state.navigation.status === 'moving'
        ? { status: 'canceled', taskId: state.navigation.taskId, source: state.navigation.source } as NavigationTask
        : { status: 'idle', taskId: state.navigation.taskId } as NavigationTask;
      const next = withSafeCommandState({
        ...state,
        navigation,
        command: { owner: 'manual' },
        exploration: pausedExploration(state, 'user'),
      });
      return accepted(next, [...stoppedEffects(), { type: 'SET_NAVIGATION_STATUS', message: event.status }]);
    }
    case 'EXPLORATION_START_REQUESTED': {
      if (state.exploration.status === 'paused') return rejected(state, '一時停止中の探索は「再開」からfresh mapを確認してください。');
      if (state.exploration.status === 'error') return rejected(state, '探索エラーは「エラーから再開」または「エラー状態を終了」を選んでください。');
      const freshness = { mapGeneration: event.mapGeneration, nowMs: event.requestedAtMs };
      const unavailable = explorationUnavailableReason(state) ?? explorationFreshnessUnavailableReason(state, freshness);
      if (!canStartExploration(state, freshness)) return rejected(state, unavailable || '探索はすでに進行中です。');
      if (state.map.status !== 'ready' || state.map.mode !== 'exploration') return rejected(state);
      const context: ExplorationRunContext = {
        generation: state.exploration.generation + 1,
        goalPolicy: event.goalPolicy ?? 'coverage',
        mapCycle: state.map.cycle,
        lastMapGeneration: event.mapGeneration,
        retryCount: 0,
        replanCount: 0,
        noCandidateConfirmations: 0,
        blacklistedCandidateIds: [],
      };
      const exploration: ExplorationState = { ...context, status: 'evaluating', mapGeneration: event.mapGeneration };
      const next: AppState = {
        ...state,
        command: { owner: 'manual' },
        navigation: canceledNavigation(state.navigation),
        exploration,
      };
      return accepted(next, [
        ...stoppedEffects(),
        { type: 'CLEAR_EXPLORATION_DATA' },
        { type: 'SET_NAVIGATION_STATUS', message: 'frontier候補を評価中' },
        explorationEvaluationEffect(context, event.mapGeneration),
      ]);
    }
    case 'EXPLORATION_EVALUATION_REQUESTED': {
      const exploration = state.exploration;
      if ((exploration.status !== 'replanning' && exploration.status !== 'evaluating')
        || exploration.generation !== event.generation) return rejected(state);
      if (!Number.isInteger(event.mapGeneration) || event.mapGeneration < 0) return rejected(state);
      if (state.map.status !== 'ready' || state.map.mode !== 'exploration' || state.map.cycle !== exploration.mapCycle) return rejected(state, 'fresh exploration readinessが揃っていません。');
      if (explorationUnavailableReason(state) !== null) return rejected(state, explorationUnavailableReason(state) || undefined);
      if (state.explorationEvidence.cycle !== exploration.mapCycle
        || state.explorationEvidence.mapGeneration !== event.mapGeneration) return rejected(state, '未観測または古いmap generationは再評価に使用しません。');
      if (exploration.status === 'evaluating') {
        if (event.mapGeneration <= exploration.mapGeneration) return rejected(state, '古いmap generationは再評価に使用しません。');
        const context: ExplorationRunContext = {
          ...explorationContext(exploration),
          lastMapGeneration: event.mapGeneration,
        };
        const nextExploration: ExplorationState = { ...context, status: 'evaluating', mapGeneration: event.mapGeneration };
        return accepted({ ...state, exploration: nextExploration }, [
          { type: 'SET_NAVIGATION_STATUS', message: '最新mapへfrontier評価を更新中' },
          explorationEvaluationEffect(context, event.mapGeneration),
        ]);
      }
      const generationIsFresh = exploration.requireFreshMap
        ? event.mapGeneration > exploration.afterMapGeneration
        : event.mapGeneration >= exploration.afterMapGeneration;
      if (!generationIsFresh) return rejected(state, '古いmap generationは再評価に使用しません。');
      const context: ExplorationRunContext = {
        ...explorationContext(exploration),
        lastMapGeneration: event.mapGeneration,
      };
      const nextExploration: ExplorationState = { ...context, status: 'evaluating', mapGeneration: event.mapGeneration };
      return accepted({ ...state, exploration: nextExploration }, [
        { type: 'SET_NAVIGATION_STATUS', message: '更新されたmapからfrontier候補を評価中' },
        explorationEvaluationEffect(context, event.mapGeneration),
      ]);
    }
    case 'EXPLORATION_GOAL_REQUESTED': {
      if (!Number.isFinite(event.requestedAtMs)) return rejected(state, '探索goalの要求時刻を確認できません。');
      const exploration = state.exploration;
      if (exploration.status !== 'evaluating'
        || exploration.generation !== event.generation
        || exploration.mapGeneration !== event.mapGeneration) return rejected(state);
      if (state.explorationEvidence.cycle !== exploration.mapCycle
        || state.explorationEvidence.mapGeneration !== event.mapGeneration) return rejected(state, '最新の観測map以外から探索goalを送信しません。');
      if (exploration.blacklistedCandidateIds.includes(event.candidateId)) return rejected(state, 'blacklist中のfrontier候補は送信しません。');
      if (!canEnableNavigationControl(state)) return rejected(state, '探索goalにはlive map、SLAM pose、Nav2、Transportの準備が必要です。');
      if (navigationTaskIsActive(state.navigation)) return rejected(state, '別のNav2 taskが進行中です。');
      const taskId = state.nextTaskId + 1;
      const selected: ExplorationSelectedGoal = {
        candidateId: event.candidateId,
        mapGeneration: event.mapGeneration,
        goal: event.goal,
      };
      const context: ExplorationRunContext = { ...explorationContext(exploration), noCandidateConfirmations: 0 };
      const nextExploration: ExplorationState = { ...context, status: 'sending', taskId, selected };
      const next: AppState = {
        ...state,
        command: { owner: 'navigation' },
        pendingCommandOwner: pendingNavigationOwner(event.requestedAtMs),
        navigation: { status: 'sending', taskId, source: 'exploration', goalId: null },
        exploration: nextExploration,
        nextTaskId: taskId,
      };
      return accepted(next, [
        { type: 'SET_COMMAND_OWNER', owner: 'navigation' },
        { type: 'SET_NAVIGATION_STATUS', message: '選択したfrontier goalをNav2へ送信中' },
        { type: 'SEND_NAVIGATION_GOAL', goal: event.goal, taskId },
      ]);
    }
    case 'EXPLORATION_NO_CANDIDATES': {
      const exploration = state.exploration;
      if (exploration.status !== 'evaluating'
        || exploration.generation !== event.generation
        || exploration.mapGeneration !== event.mapGeneration) return rejected(state);
      if (state.explorationEvidence.cycle !== exploration.mapCycle
        || state.explorationEvidence.mapGeneration !== event.mapGeneration) return rejected(state, '最新の観測map以外を候補枯渇の確認に使用しません。');
      if (!Number.isFinite(event.exploredCoverageRatio) || event.exploredCoverageRatio < 0 || event.exploredCoverageRatio > 1) {
        return rejected(state, '探索完了判定の観測済み領域比率が不正です。');
      }
      const frontierExhausted = event.reason === 'no-frontiers';
      const safeGoalExhausted = frontierExhausted
        || event.reason === 'no-eligible-candidates';
      const coverageSufficient = explorationCoverageAllowsCompletion(event.exploredCoverageRatio);
      const objectSearchOwnsExploration = exploration.goalPolicy === 'object-search'
        && state.objectSearch.status === 'searching'
        && state.objectSearch.explorationGeneration === exploration.generation;
      // Object Search is a perception mission, not a map-coverage mission.
      // Never turn a temporarily empty frontier list into completed (which
      // would start the corner/coverage finalization path) while it is active.
      const terminalExhaustion = !objectSearchOwnsExploration && safeGoalExhausted && coverageSufficient;
      const noCandidateConfirmations = terminalExhaustion ? exploration.noCandidateConfirmations + 1 : 0;
      const context: ExplorationRunContext = {
        ...explorationContext(exploration),
        lastMapGeneration: event.mapGeneration,
        noCandidateConfirmations,
      };
      if (event.recoveryExhausted && !objectSearchOwnsExploration
        && event.reason !== 'robot-insufficient-clearance' && !terminalExhaustion) {
        const reason = '通常候補と到達可能な安全な四隅goalを現在のmapから作れません。';
        const message = `${reason} fresh mapとposeを確認して再開するか、手動で安全な位置へ退避してください。`;
        const next = withSafeCommandState({
          ...state,
          command: { owner: 'manual' },
          navigation: canceledNavigation(state.navigation),
          exploration: {
            ...context,
            status: 'error',
            message,
            recoverable: true,
            resumeAfterMapGeneration: event.mapGeneration,
          },
        });
        return accepted(next, [
          ...stoppedEffects(),
          { type: 'SET_NAVIGATION_STATUS', message: '探索エラー / 自動復帰できる安全goalなし' },
          { type: 'ANNOUNCE', message },
        ]);
      }
      if (terminalExhaustion && noCandidateConfirmations >= EXPLORATION_NO_CANDIDATE_CONFIRMATIONS_REQUIRED) {
        const next = withSafeCommandState({
          ...state,
          command: { owner: 'manual' },
          navigation: canceledNavigation(state.navigation),
          exploration: { ...context, status: 'completed', confirmedMapGeneration: event.mapGeneration },
        });
        return accepted(next, [
          { type: 'SET_COMMAND_OWNER', owner: 'manual' },
          { type: 'ZERO_VELOCITY' },
          { type: 'CLEAR_GOAL_DATA' },
          { type: 'SET_NAVIGATION_STATUS', message: `探索完了 / 観測済み領域${Math.round(event.exploredCoverageRatio * 100)}%・fresh mapで安全goalなしを確認` },
          { type: 'ANNOUNCE', message: `freeと障害物を合わせた観測済み領域が${Math.round(event.exploredCoverageRatio * 100)}%に達し、複数のfresh mapで到達可能な安全frontier goalがないことを確認しました。探索を終了できます。` },
        ]);
      }
      const coverageInsufficient = frontierExhausted && !coverageSufficient;
      const unresolvedFrontiers = event.reason === 'no-eligible-candidates';
      const transientEvidence = objectSearchOwnsExploration || !safeGoalExhausted || !coverageSufficient;
      const requireFreshMap = objectSearchOwnsExploration
        ? event.reason !== 'blacklist-cooldown'
        : !transientEvidence;
      const replanningContext: ExplorationRunContext = { ...context, replanCount: context.replanCount + 1 };
      const nextExploration: ExplorationState = {
        ...replanningContext,
        status: 'replanning',
        reason: coverageInsufficient
          ? 'coverage-insufficient'
          : unresolvedFrontiers
            ? 'frontiers-unresolved'
            : event.reason === 'blacklist-cooldown'
              ? 'candidate-cooldown'
              : transientEvidence
                ? 'candidate-evidence-unavailable'
                : 'no-candidates',
        afterMapGeneration: event.mapGeneration,
        requireFreshMap,
      };
      const status = objectSearchOwnsExploration
        ? 'Object Search継続 / 四隅掃引を使わず、fresh mapまたは既知領域の安全な巡回goalを待機'
        : coverageInsufficient
          ? `探索継続 / 観測済み領域${Math.round(event.exploredCoverageRatio * 100)}%（完了基準${Math.round(EXPLORATION_COMPLETION_MIN_EXPLORED_RATIO * 100)}%）`
          : unresolvedFrontiers
            ? 'frontier残存 / 安全なgoalまたは退避後のposeを再評価'
            : event.reason === 'blacklist-cooldown'
              ? '候補はcooldown中 / 時間またはmap更新後に再評価'
              : transientEvidence
                ? '自機位置とmapの同期を待って再評価'
                : '候補なし / 次のfresh mapで再確認';
      return accepted({ ...state, command: { owner: 'manual' }, exploration: nextExploration }, [
        { type: 'ZERO_VELOCITY' },
        { type: 'SET_NAVIGATION_STATUS', message: status },
        explorationWaitEffect(replanningContext, event.mapGeneration, requireFreshMap),
      ]);
    }
    case 'EXPLORATION_PAUSE_REQUESTED': {
      if (state.exploration.status === 'paused') return accepted(state);
      if (!explorationIsActive(state.exploration)) return rejected(state, '現在、進行中の探索はありません。');
      const next = withSafeCommandState({
        ...state,
        command: { owner: 'manual' },
        navigation: canceledNavigation(state.navigation),
        exploration: pausedExploration(state, 'user'),
      });
      const message = event.status || '探索を一時停止しました / fresh map確認後に再開できます';
      return accepted(next, [...stoppedEffects(), { type: 'SET_NAVIGATION_STATUS', message }, { type: 'ANNOUNCE', message }]);
    }
    case 'EXPLORATION_RESUME_REQUESTED': {
      const exploration = state.exploration;
      if (exploration.status !== 'paused' && exploration.status !== 'error') {
        return rejected(state, '一時停止中またはrecoverable errorの探索だけを再開できます。');
      }
      const freshness = { mapGeneration: event.mapGeneration, nowMs: event.requestedAtMs };
      const unavailable = explorationUnavailableReason(state)
        ?? explorationFreshnessUnavailableReason(state, freshness)
        ?? explorationErrorResumeUnavailableReason(state, freshness);
      if (!canResumeExploration(state, freshness)) {
        return rejected(state, unavailable || '探索を再開できません。');
      }
      if (state.map.status !== 'ready' || state.map.mode !== 'exploration') return rejected(state);
      const context: ExplorationRunContext = {
        ...explorationContext(exploration),
        generation: exploration.generation + 1,
        goalPolicy: event.goalPolicy ?? exploration.goalPolicy ?? 'coverage',
        mapCycle: state.map.cycle,
        lastMapGeneration: event.mapGeneration,
        retryCount: exploration.status === 'error' ? 0 : exploration.retryCount,
        noCandidateConfirmations: 0,
      };
      const nextExploration: ExplorationState = { ...context, status: 'evaluating', mapGeneration: event.mapGeneration };
      const next: AppState = {
        ...state,
        command: { owner: 'manual' },
        navigation: canceledNavigation(state.navigation),
        exploration: nextExploration,
      };
      return accepted(next, [
        ...stoppedEffects(),
        { type: 'SET_NAVIGATION_STATUS', message: exploration.status === 'error'
          ? '探索エラーから再開 / blacklistを保持してfresh mapからfrontier評価中'
          : '現在のfresh live mapから探索を再開 / frontier評価中' },
        explorationEvaluationEffect(context, event.mapGeneration),
      ]);
    }
    case 'EXPLORATION_STOP_REQUESTED': {
      if (state.exploration.status === 'idle') return accepted(state);
      const next = withSafeCommandState({
        ...state,
        command: { owner: 'manual' },
        navigation: canceledNavigation(state.navigation),
        exploration: clearedExploration(state.exploration),
      });
      const message = event.status || '探索を終了しました';
      return accepted(next, [
        ...stoppedEffects(),
        { type: 'CLEAR_EXPLORATION_DATA' },
        { type: 'SET_NAVIGATION_STATUS', message },
        { type: 'ANNOUNCE', message },
      ]);
    }
    case 'EXPLORATION_ERROR_REPORTED': {
      const exploration = state.exploration;
      if (!explorationIsActive(exploration) || exploration.generation !== event.generation) return rejected(state);
      const context = explorationContext(exploration);
      const next = withSafeCommandState({
        ...state,
        command: { owner: 'manual' },
        navigation: canceledNavigation(state.navigation),
        exploration: {
          ...context,
          status: 'error',
          message: event.error,
          recoverable: true,
          resumeAfterMapGeneration: latestObservedExplorationMapGeneration(state, exploration),
        },
      });
      return accepted(next, [
        ...stoppedEffects(),
        { type: 'SET_NAVIGATION_STATUS', message: `探索error: ${event.error}` },
        { type: 'ANNOUNCE', message: event.error },
      ]);
    }
    case 'CONTROL_LEASE_CHANGED': {
      if (!Number.isFinite(event.changedAtMs)) return rejected(state, '操作権の変更時刻を確認できません。');
      if (state.controlLease.owner === event.owner) return accepted(state);
      const nextControl: ControlLeaseState = { owner: event.owner, generation: state.controlLease.generation + 1 };
      const nextState = { ...state, controlLease: nextControl };
      if (event.owner || (state.objectSearch.status === 'preparing' && state.objectSearch.runtimePreparationPending)) {
        return accepted(invalidateObjectSearchEvidence(nextState));
      }
      if (objectSearchCanBePaused(state.objectSearch)) return pauseObjectSearchDirect(nextState, 'control-lease');
      const invalidated = invalidateObjectSearchEvidence(nextState);
      if (!event.owner && (navigationTaskIsActive(state.navigation) || explorationIsActive(state.exploration))) {
        const next = withSafeCommandState({
          ...invalidated,
          command: { owner: 'manual' },
          pendingCommandOwner: null,
          navigation: canceledNavigation(state.navigation),
          exploration: pausedExploration(state, 'control-lease'),
        });
        return accepted(next, [
          ...stoppedEffects(),
          { type: 'SET_NAVIGATION_STATUS', message: '別の画面へ操作権が移ったため停止しました' },
        ]);
      }
      return accepted(invalidated);
    }
    case 'VISION_STATUS_OBSERVED': {
      if (event.cycle !== state.vision.cycle) return rejected(state, '古いVision cycleのstatusは使用しません。');
      if (!Number.isFinite(event.observedAtMs)) return rejected(state, 'Vision statusの観測時刻を確認できません。');
      if (state.vision.statusObservedAtMs !== null && event.observedAtMs < state.vision.statusObservedAtMs) {
        return rejected(state, '古いVision statusは使用しません。');
      }
      if (event.status === 'error') {
        const message = event.error || 'YOLOX Visionでエラーが発生しました。';
        const vision: VisionReadinessState = {
          ...state.vision,
          status: 'error',
          modelReady: false,
          statusObservedAtMs: event.observedAtMs,
          message,
        };
        if (!objectSearchCanBePaused(state.objectSearch)) return accepted({ ...state, vision });
        const displayName = state.objectSearch.displayName;
        const paused = pauseObjectSearchDirect({ ...state, vision }, 'vision', `Vision errorのため、${displayName}探索を一時停止しました。${message}`);
        const errorVision: VisionReadinessState = {
          ...blankVisionState(paused.state.vision.cycle),
          status: 'error',
          statusObservedAtMs: event.observedAtMs,
          message,
        };
        const mission = paused.state.objectSearch;
        return accepted({
          ...paused.state,
          vision: errorVision,
          objectSearch: mission.status === 'paused' ? { ...mission, visionCycle: errorVision.cycle } : mission,
        }, paused.effects);
      }
      const vision = event.status === 'unavailable'
        ? { ...state.vision, status: 'unavailable' as const, modelReady: false, statusObservedAtMs: event.observedAtMs, message: '' }
        : visionWithDerivedReadiness({
            ...state.vision,
            status: 'initializing',
            modelReady: event.status === 'ready',
            statusObservedAtMs: event.observedAtMs,
            message: '',
          });
      return accepted({ ...state, vision });
    }
    case 'VISION_FRAME_OBSERVED': {
      if (event.cycle !== state.vision.cycle) return rejected(state, '古いVision cycleのCamera frameは使用しません。');
      if (!Number.isFinite(event.observedAtMs)) return rejected(state, 'Camera frameの観測時刻を確認できません。');
      if (state.vision.frameObservedAtMs !== null && event.observedAtMs < state.vision.frameObservedAtMs) {
        return rejected(state, '古いCamera frameは使用しません。');
      }
      return accepted({ ...state, vision: visionWithDerivedReadiness({ ...state.vision, frameObservedAtMs: event.observedAtMs }) });
    }
    case 'VISION_DETECTOR_OBSERVED': {
      if (event.cycle !== state.vision.cycle) return rejected(state, '古いVision cycleのDetectionは使用しません。');
      if (!Number.isFinite(event.observedAtMs) || !Number.isFinite(event.frameObservedAtMs)) {
        return rejected(state, 'Detectionの観測時刻を確認できません。');
      }
      if (state.vision.detectorObservedAtMs !== null && event.observedAtMs < state.vision.detectorObservedAtMs) {
        return rejected(state, '古いDetection応答は使用しません。');
      }
      return accepted({
        ...state,
        vision: visionWithDerivedReadiness({
          ...state.vision,
          detectorObservedAtMs: event.observedAtMs,
          detectorFrameObservedAtMs: event.frameObservedAtMs,
        }),
      });
    }
    case 'OBJECT_SEARCH_COMMAND_REQUESTED': {
      if (!Number.isFinite(event.requestedAtMs)) return rejected(state, '物体探索の要求時刻を確認できません。');
      if (!event.normalizedCommand || event.normalizedCommand.length > 200) return rejected(state, '正規化済みの探索命令を確認できません。');
      if (event.displayName !== getObjectSearchTarget(event.targetClass).displayName) return rejected(state, '探索対象の表示名がYOLOX registryと一致しません。');
      if (objectSearchHasMission(state.objectSearch) && state.objectSearch.status !== 'not_found') {
        return rejected(state, 'すでに物体探索missionが存在します。重複開始しません。');
      }
      if (state.view.mode !== 'sim') return rejected(state, 'STAGE編集中は物体探索を受け付けません。SIMへ戻ってください。');
      if (state.safety.stopped) return rejected(state, 'Safety stop解除後に物体探索を開始してください。');
      if (state.map.status === 'resetting') return rejected(state, 'map reset完了後に物体探索を開始してください。');

      let preparation = accepted(state);
      const runtimePreparationPending = !(state.runtime.status === 'stable' && state.runtime.mode === 'exploration');
      if (runtimePreparationPending) {
        preparation = transitionAppStateCore(state, { type: 'RUNTIME_SWITCH_REQUESTED', target: 'exploration' });
        if (!preparation.accepted) return preparation;
      }
      const vision = invalidateVisionEvidence(preparation.state.vision);
      const missionId = preparation.state.nextObjectSearchMissionId + 1;
      const generation = state.objectSearch.generation + 1;
      const message = `${event.displayName}を探します。探索構成を準備します。`;
      const objectSearch: ObjectSearchState = {
        status: 'preparing',
        missionId,
        generation,
        targetClass: event.targetClass,
        displayName: event.displayName,
        normalizedCommand: event.normalizedCommand,
        requestedAtMs: event.requestedAtMs,
        mapCycle: preparation.state.map.cycle,
        explorationGeneration: explorationIsActive(preparation.state.exploration) ? preparation.state.exploration.generation : null,
        visionCycle: vision.cycle,
        transportCycle: preparation.state.transportCycle,
        controlLeaseGeneration: preparation.state.controlLease.generation,
        runtimePreparationPending,
        lostCount: 0,
        detectionTracker: createAppleDetectionTracker({
          phase: 'prestop',
          targetClass: event.targetClass,
          missionGeneration: generation,
          visionCycle: vision.cycle,
          transportCycle: preparation.state.transportCycle,
          notBeforeFrameStampMs: event.requestedAtMs,
        }),
        lastChatStatus: message,
      };
      return accepted({
        ...preparation.state,
        vision,
        objectSearch,
        nextObjectSearchMissionId: missionId,
      }, [
        ...preparation.effects,
        { type: 'SYNC_OBJECT_SEARCH_CHAT', status: 'accepted', targetClass: event.targetClass, role: 'robot', message },
      ]);
    }
    case 'OBJECT_SEARCH_ADVANCE_REQUESTED':
      return startOrAttachObjectSearch(state, {
        generation: event.generation,
        visionCycle: event.visionCycle,
        mapCycle: event.mapCycle,
        mapGeneration: event.mapGeneration,
        explorationGeneration: event.explorationGeneration,
        nowMs: event.requestedAtMs,
      }, false);
    case 'OBJECT_SEARCH_RESUME_REQUESTED':
      return startOrAttachObjectSearch(state, {
        generation: event.generation,
        visionCycle: event.visionCycle,
        mapCycle: event.mapCycle,
        mapGeneration: event.mapGeneration,
        explorationGeneration: event.explorationGeneration,
        nowMs: event.requestedAtMs,
      }, true);
    case 'OBJECT_SEARCH_CANCEL_REQUESTED': {
      if (!Number.isFinite(event.requestedAtMs)) return rejected(state, '物体探索中止の要求時刻を確認できません。');
      const mission = state.objectSearch;
      if (mission.status === 'idle' || mission.status === 'canceled') return rejected(state, '中止できる物体探索はありません。');
      if (mission.generation !== event.generation) return rejected(state, '古いObject Search mission callbackは使用しません。');
      const vision = invalidateVisionEvidence(state.vision);
      const message = `${mission.displayName}探索を中止しました。Robotは停止状態です。`;
      const generation = mission.generation + 1;
      const context: ObjectSearchRunContext = {
        ...objectSearchContext(mission),
        generation,
        mapCycle: state.map.cycle,
        explorationGeneration: state.exploration.generation + 1,
        visionCycle: vision.cycle,
        transportCycle: state.transportCycle,
        controlLeaseGeneration: state.controlLease.generation,
        detectionTracker: createAppleDetectionTracker({
          phase: 'prestop',
          targetClass: mission.targetClass,
          missionGeneration: generation,
          visionCycle: vision.cycle,
          transportCycle: state.transportCycle,
          notBeforeFrameStampMs: event.requestedAtMs,
        }),
        lastChatStatus: message,
      };
      const next = withSafeCommandState({
        ...state,
        vision,
        command: { owner: 'manual' },
        pendingCommandOwner: null,
        navigation: canceledNavigation(state.navigation),
        exploration: clearedExploration(state.exploration),
        objectSearch: { ...context, status: 'canceled', canceledAtMs: event.requestedAtMs },
      });
      return accepted(next, [
        ...stoppedEffects(),
        { type: 'CLEAR_EXPLORATION_DATA' },
        { type: 'SET_NAVIGATION_STATUS', message: 'Object Searchを中止 / goal取消・manual owner・速度0' },
        { type: 'SYNC_OBJECT_SEARCH_CHAT', status: 'idle', targetClass: null, role: 'robot', message },
      ]);
    }
    case 'OBJECT_SEARCH_HEALTH_CHECK_REQUESTED': {
      if (!Number.isFinite(event.requestedAtMs)) return rejected(state, 'Object Search health checkの時刻を確認できません。');
      if ((state.objectSearch.status !== 'searching'
        && state.objectSearch.status !== 'candidate'
        && state.objectSearch.status !== 'approaching'
        && state.objectSearch.status !== 'stopping'
        && state.objectSearch.status !== 'confirming'
        && state.objectSearch.status !== 'finalizing')
        || state.objectSearch.generation !== event.generation) {
        return rejected(state, '古いObject Search health checkは使用しません。');
      }
      const unavailable = objectSearchReadinessUnavailableReason(state, {
        generation: event.generation,
        visionCycle: state.vision.cycle,
        mapCycle: state.map.cycle,
        mapGeneration: state.explorationEvidence.mapGeneration,
        explorationGeneration: state.exploration.generation,
        nowMs: event.requestedAtMs,
      });
      if (!unavailable) return accepted(state);
      return pauseObjectSearchDirect(state, objectSearchPauseReasonForUnavailable(state, unavailable));
    }
    case 'OBJECT_SEARCH_DETECTION_OBSERVED':
      return observeObjectSearchDetection(state, event);
    case 'OBJECT_SEARCH_APPROACH_REQUESTED':
      return requestObjectSearchApproach(state, event);
    case 'OBJECT_SEARCH_APPROACH_UNAVAILABLE':
      return rejectObjectSearchApproach(state, event);
    case 'OBJECT_SEARCH_SAFE_STOP_REQUESTED':
      return requestObjectSearchSafeStop(state, event);
    case 'ROBOT_MOTION_OBSERVED':
      return observeObjectSearchMotion(state, event);
    case 'SAFETY_CHANGED': {
      if (state.safety.stopped === event.stopped) return accepted(state);
      if (!event.stopped) {
        const recoveringSource = navigationTaskIsActive(state.navigation) && state.command.owner === 'navigation'
          ? state.navigation.source
          : null;
        const next = withSafeCommandState({ ...state, safety: { stopped: false } });
        return accepted(next, recoveringSource
          ? [{ type: 'SET_NAVIGATION_STATUS', message: recoveringSource === 'exploration'
            ? '安全距離を回復 / frontierへの走行を継続中'
            : '安全距離を回復 / Nav2 goalへの走行を継続中' }]
          : []);
      }
      if (navigationTaskIsActive(state.navigation) && state.command.owner === 'navigation') {
        return accepted({ ...state, safety: { stopped: true } }, [
          { type: 'SET_NAVIGATION_STATUS', message: '前方Safety limiter作動 / 自動後退・自動旋回なし' },
        ]);
      }
      const next = withSafeCommandState({
        ...state,
        safety: { stopped: true },
        navigation: canceledNavigation(state.navigation),
        exploration: pausedExploration(state, 'safety-stop'),
      });
      return accepted(next, [
        ...stoppedEffects(),
        { type: 'SET_NAVIGATION_STATUS', message: event.status || 'Safety stop / 速度0' },
      ]);
    }
    case 'WINDOW_FOCUS_LOST':
      return accepted(state, [{ type: 'RELEASE_USER_INPUT' }, { type: 'ZERO_VELOCITY' }]);
    case 'SAFE_STOP_REQUESTED': {
      const next = withSafeCommandState({
        ...state,
        navigation: canceledNavigation(state.navigation),
        command: { owner: 'manual' },
        exploration: pausedExploration(state, 'safety-stop'),
      });
      return accepted(next, [...stoppedEffects(), { type: 'SET_NAVIGATION_STATUS', message: event.status }]);
    }
  }
}

function objectSearchPauseReasonFromExploration(reason: ExplorationPauseReason): ObjectSearchPauseReason {
  switch (reason) {
    case 'operator-conflict':
    case 'manual-override': return 'manual-override';
    case 'object-found-candidate': return 'target-lost';
    case 'user': return 'user';
    default: return reason;
  }
}

function cancelObjectSearchAfterTransition(result: TransitionResult, canceledAtMs: number, message: string): TransitionResult {
  if (!result.accepted || result.state.objectSearch.status === 'idle' || result.state.objectSearch.status === 'canceled') return result;
  const objectSearch = result.state.objectSearch;
  const vision = invalidateVisionEvidence(result.state.vision);
  const context = refreshedObjectSearchContext(result.state, objectSearch, vision, message);
  return accepted({
    ...result.state,
    vision,
    objectSearch: { ...context, status: 'canceled', canceledAtMs },
  }, [
    ...result.effects,
    { type: 'SYNC_OBJECT_SEARCH_CHAT', status: 'idle', targetClass: null, role: 'robot', message },
  ]);
}

function errorObjectSearchAfterTransition(result: TransitionResult, message: string): TransitionResult {
  if (!result.accepted || !objectSearchHasMission(result.state.objectSearch)) return result;
  const objectSearch = result.state.objectSearch;
  const vision = invalidateVisionEvidence(result.state.vision);
  const context = refreshedObjectSearchContext(result.state, objectSearch, vision, message);
  return accepted({
    ...result.state,
    vision,
    objectSearch: { ...context, status: 'error', message, recoverable: true },
  }, [
    ...result.effects,
    { type: 'SYNC_OBJECT_SEARCH_CHAT', status: 'paused', targetClass: objectSearch.targetClass, role: 'error', message },
  ]);
}

function synchronizeObjectSearchTransition(previous: AppState, event: AppEvent, result: TransitionResult): TransitionResult {
  if (!result.accepted) return result;

  if (event.type === 'COMMAND_OWNER_OBSERVED'
    && (previous.objectSearch.status === 'stopping'
      || previous.objectSearch.status === 'confirming'
      || previous.objectSearch.status === 'finalizing')) {
    return observeObjectSearchManualOwner(result, event);
  }

  if (event.type === 'MAP_RESET_REQUESTED') {
    const canceledAtMs = result.state.objectSearch.status === 'idle' ? 0 : result.state.objectSearch.requestedAtMs;
    const displayName = previous.objectSearch.status === 'idle' ? '物体' : previous.objectSearch.displayName;
    return cancelObjectSearchAfterTransition(result, canceledAtMs, `現在マップをリセットしたため、${displayName}探索を中止しました。`);
  }

  if (event.type === 'TRANSPORT_CHANGED' && previous.transport !== event.connection) {
    if (event.connection === 'CONNECTED') {
      return accepted(invalidateObjectSearchEvidence(result.state), result.effects);
    }
    const plannedExplorationConnection = previous.objectSearch.status === 'preparing'
      && previous.objectSearch.runtimePreparationPending
      && event.connection !== 'ERROR';
    if (plannedExplorationConnection) return accepted(invalidateObjectSearchEvidence(result.state), result.effects);
    return pauseObjectSearchAfterTransition(result, 'transport');
  }

  if (event.type === 'RUNTIME_SWITCH_REQUESTED'
    && !(previous.runtime.status === 'stable' && previous.runtime.mode === event.target)) {
    if (previous.objectSearch.status === 'preparing'
      && previous.objectSearch.runtimePreparationPending
      && event.target === 'exploration') return accepted(invalidateObjectSearchEvidence(result.state), result.effects);
    return pauseObjectSearchAfterTransition(result, 'runtime-change');
  }
  if (event.type === 'RUNTIME_MANAGER_OBSERVED') {
    const plannedExplorationRuntime = previous.objectSearch.status === 'preparing'
      && previous.objectSearch.runtimePreparationPending
      && !event.snapshot.error
      && (event.snapshot.target === 'exploration' || event.snapshot.mode === 'exploration');
    if (plannedExplorationRuntime) return result;
    const externalProcessing = event.snapshot.processing && previous.runtime.status !== 'switching';
    const externalStableChange = !event.snapshot.processing
      && !event.snapshot.error
      && previous.runtime.status !== 'switching'
      && currentRuntimeMode(previous) !== event.snapshot.mode;
    if (event.snapshot.error || externalProcessing || externalStableChange) {
      return pauseObjectSearchAfterTransition(result, 'runtime-change');
    }
  }
  if (event.type === 'VIEW_REQUESTED' && event.view === 'stage' && previous.view.mode !== 'stage') {
    return pauseObjectSearchAfterTransition(result, 'stage');
  }
  if (event.type === 'ROBOT_ORIGIN_RESET_REQUESTED') return pauseObjectSearchAfterTransition(result, 'origin-reset');
  if (event.type === 'NAVIGATION_UNAVAILABLE') return pauseObjectSearchAfterTransition(result, 'navigation-unavailable');
  if (event.type === 'COMMAND_OWNER_REQUESTED' && event.owner === 'manual') return pauseObjectSearchAfterTransition(result, 'manual-override');
  if (event.type === 'COMMAND_OWNER_OBSERVED'
    && event.owner === 'manual'
    && result.state.exploration.status === 'paused'
    && result.state.exploration.reason === 'manual-override') return pauseObjectSearchAfterTransition(result, 'manual-override');
  if (event.type === 'EXPLORATION_PAUSE_REQUESTED' || event.type === 'EXPLORATION_STOP_REQUESTED') {
    return pauseObjectSearchAfterTransition(result, 'user');
  }
  if (event.type === 'SAFETY_CHANGED' && event.stopped) {
    if (previous.objectSearch.status === 'preparing' && previous.objectSearch.runtimePreparationPending) return result;
    return pauseObjectSearchAfterTransition(result, 'safety-stop');
  }
  if (event.type === 'SAFE_STOP_REQUESTED') return pauseObjectSearchAfterTransition(result, 'safety-stop');

  const mission = result.state.objectSearch;
  if (mission.status === 'searching') {
    if (result.state.exploration.status === 'completed') {
      const message = '探索可能範囲の走行を完了しました。停止後のfresh Vision確認待ちです。';
      const finalizationStartedAtMs = result.state.vision.synchronizedFrameObservedAtMs
        ?? mission.detectionTracker.lastFrameStampMs
        ?? mission.requestedAtMs;
      return accepted({
        ...result.state,
        objectSearch: {
          ...objectSearchContext(mission),
          detectionTracker: resetAppleDetectionTrackerForPostStop(mission.detectionTracker, finalizationStartedAtMs),
          lastChatStatus: message,
          status: 'finalizing',
          reason: 'exploration-completed',
          finalizationStartedAtMs,
          stopEvidence: emptyObjectSearchStopEvidence(),
        },
      }, [
        ...result.effects,
        { type: 'SYNC_OBJECT_SEARCH_CHAT', status: 'accepted', targetClass: mission.targetClass, role: 'robot', message },
      ]);
    }
    if (result.state.exploration.status === 'error') {
      return errorObjectSearchAfterTransition(result, `移動経路を確保できず、${mission.displayName}探索を停止しました。${result.state.exploration.message}`);
    }
    if (result.state.exploration.status === 'paused') {
      return pauseObjectSearchAfterTransition(result, objectSearchPauseReasonFromExploration(result.state.exploration.reason));
    }
  }
  return result;
}

export function transitionAppState(state: AppState, event: AppEvent): TransitionResult {
  const result = transitionAppStateCore(state, event);
  if (event.type === 'OBJECT_SEARCH_COMMAND_REQUESTED'
    || event.type === 'OBJECT_SEARCH_ADVANCE_REQUESTED'
    || event.type === 'OBJECT_SEARCH_RESUME_REQUESTED'
    || event.type === 'OBJECT_SEARCH_CANCEL_REQUESTED'
    || event.type === 'OBJECT_SEARCH_HEALTH_CHECK_REQUESTED'
    || event.type === 'OBJECT_SEARCH_DETECTION_OBSERVED'
    || event.type === 'OBJECT_SEARCH_APPROACH_REQUESTED'
    || event.type === 'OBJECT_SEARCH_APPROACH_UNAVAILABLE'
    || event.type === 'OBJECT_SEARCH_SAFE_STOP_REQUESTED'
    || event.type === 'ROBOT_MOTION_OBSERVED'
    || event.type === 'CONTROL_LEASE_CHANGED'
    || event.type === 'VISION_STATUS_OBSERVED'
    || event.type === 'VISION_FRAME_OBSERVED'
    || event.type === 'VISION_DETECTOR_OBSERVED') return result;
  return synchronizeObjectSearchTransition(state, event, result);
}

export function navigationStatus(state: AppState): NavigationState {
  return state.navigation.status;
}

export function explorationStatus(state: AppState): ExplorationState['status'] {
  return state.exploration.status;
}
