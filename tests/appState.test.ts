import { describe, expect, it } from 'vitest';
import {
  COMMAND_OWNER_ACK_TIMEOUT_MS,
  EXPLORATION_MAP_FRESHNESS_MS,
  EXPLORATION_NO_CANDIDATE_CONFIRMATIONS_REQUIRED,
  EXPLORATION_POSE_FRESHNESS_MS,
  MAX_EXPLORATION_RETRIES,
  canAcceptManualMotion,
  canEnableNavigationControl,
  canPauseExploration,
  canQueryRosGraph,
  canResumeExploration,
  canSaveCurrentMap,
  canStartExploration,
  canStopExploration,
  createInitialAppState,
  explorationIsActive,
  explorationUnavailableReason,
  isInteractionLocked,
  mapSaveUnavailableReason,
  processingModalModel,
  transitionAppState,
  type AppEvent,
  type AppState,
  type RuntimeManagerState,
} from '../src/appState';
import { makePose } from '../src/navigationMap';
import type { PoseStampedMessage, RuntimeMode } from '../src/types';

const NOW_MS = 100_000;

function dispatch(state: AppState, event: AppEvent): AppState {
  const result = transitionAppState(state, event);
  expect(result.accepted, result.rejection).toBe(true);
  return result.state;
}

function receiveMap(state: AppState, cycle = state.map.cycle): AppState {
  return dispatch(state, { type: 'MAP_RECEIVED', cycle });
}

function receivePose(state: AppState, cycle = state.map.cycle): AppState {
  return dispatch(state, { type: 'POSE_READY', cycle });
}

function observeExplorationMap(state: AppState, mapGeneration: number, observedAtMs = NOW_MS, cycle = state.map.cycle): AppState {
  return dispatch(state, { type: 'EXPLORATION_MAP_OBSERVED', cycle, mapGeneration, observedAtMs });
}

function observeExplorationPose(state: AppState, observedAtMs = NOW_MS, cycle = state.map.cycle): AppState {
  return dispatch(state, { type: 'EXPLORATION_POSE_OBSERVED', cycle, observedAtMs });
}

function freshness(mapGeneration: number, nowMs = NOW_MS): { mapGeneration: number; nowMs: number } {
  return { mapGeneration, nowMs };
}

function runtimeSnapshot(mode: RuntimeMode, overrides: Partial<RuntimeManagerState> = {}): RuntimeManagerState {
  return { mode, target: mode, processing: false, phase: '', error: '', backendAlive: mode !== 'sim', ...overrides };
}

function navigationReadyState(): AppState {
  let state = createInitialAppState();
  state = dispatch(state, { type: 'RUNTIME_SWITCH_REQUESTED', target: 'navigation' });
  state = dispatch(state, { type: 'RUNTIME_MANAGER_OBSERVED', snapshot: runtimeSnapshot('navigation') });
  state = dispatch(state, { type: 'TRANSPORT_CHANGED', connection: 'CONNECTED' });
  state = receiveMap(state);
  state = receivePose(state);
  return state;
}

function mappingReadyState(): AppState {
  let state = createInitialAppState();
  state = dispatch(state, { type: 'RUNTIME_SWITCH_REQUESTED', target: 'mapping' });
  state = dispatch(state, { type: 'RUNTIME_MANAGER_OBSERVED', snapshot: runtimeSnapshot('mapping') });
  state = dispatch(state, { type: 'TRANSPORT_CHANGED', connection: 'CONNECTED' });
  return receiveMap(state);
}

function explorationReadyState(mapGeneration = 1, observedAtMs = NOW_MS): AppState {
  let state = createInitialAppState();
  state = dispatch(state, { type: 'RUNTIME_SWITCH_REQUESTED', target: 'exploration' });
  state = dispatch(state, { type: 'RUNTIME_MANAGER_OBSERVED', snapshot: runtimeSnapshot('exploration') });
  state = dispatch(state, { type: 'TRANSPORT_CHANGED', connection: 'CONNECTED' });
  state = receiveMap(state);
  state = observeExplorationMap(state, mapGeneration, observedAtMs);
  state = receivePose(state);
  state = observeExplorationPose(state, observedAtMs);
  state = dispatch(state, { type: 'NAVIGATION_READY', cycle: state.map.cycle });
  return state;
}

function explorationStarted(mapGeneration = 1): AppState {
  return dispatch(explorationReadyState(mapGeneration), { type: 'EXPLORATION_START_REQUESTED', mapGeneration, requestedAtMs: NOW_MS });
}

function requestExplorationGoal(state: AppState, candidateId = 'frontier-1', mapGeneration = 1): AppState {
  if (state.exploration.status === 'evaluating') mapGeneration = state.exploration.mapGeneration;
  return dispatch(state, {
    type: 'EXPLORATION_GOAL_REQUESTED',
    generation: state.exploration.generation,
    mapGeneration,
    candidateId,
    goal: testGoal(),
    requestedAtMs: NOW_MS,
  });
}

function testGoal(): PoseStampedMessage {
  return { header: { frame_id: 'map', stamp: { sec: 1, nanosec: 0 } }, pose: makePose(1, 2) };
}

describe('application state transitions', () => {
  it('marks every automatic exploration phase active for the thinking indicator', () => {
    expect(explorationIsActive(createInitialAppState().exploration)).toBe(false);

    let state = explorationStarted(1);
    expect(state.exploration.status).toBe('evaluating');
    expect(explorationIsActive(state.exploration)).toBe(true);

    state = requestExplorationGoal(state, 'frontier-thinking', 1);
    expect(state.exploration.status).toBe('sending');
    expect(explorationIsActive(state.exploration)).toBe(true);

    state = dispatch(state, { type: 'NAVIGATION_GOAL_FEEDBACK', taskId: state.navigation.taskId });
    expect(state.exploration.status).toBe('moving');
    expect(explorationIsActive(state.exploration)).toBe(true);

    state = dispatch(state, { type: 'NAVIGATION_GOAL_FAILED', taskId: state.navigation.taskId, error: 'blocked', canceled: false });
    expect(state.exploration.status).toBe('replanning');
    expect(explorationIsActive(state.exploration)).toBe(true);

    state = dispatch(state, { type: 'EXPLORATION_PAUSE_REQUESTED' });
    expect(state.exploration.status).toBe('paused');
    expect(explorationIsActive(state.exploration)).toBe(false);
  });

  it('starts as an independent SIM with manual command ownership', () => {
    const state = createInitialAppState();
    expect(state.runtime).toEqual({ status: 'stable', mode: 'sim' });
    expect(state.map.status).toBe('unavailable');
    expect(state.command).toEqual({ owner: 'manual' });
    expect(state.transport).toBe('SIMULATED');
    expect(state.view).toEqual({ mode: 'sim' });
    expect(state.safety).toEqual({ stopped: false });
    expect(isInteractionLocked(state)).toBe(false);
    expect(canAcceptManualMotion(state)).toBe(true);
  });

  it('resets the robot origin through the safety effect boundary in SIM and STAGE', () => {
    let state = requestExplorationGoal(explorationStarted(2), 'frontier-reset-origin', 2);
    const taskId = state.navigation.taskId;
    const reset = transitionAppState(state, { type: 'ROBOT_ORIGIN_RESET_REQUESTED' });
    expect(reset.accepted).toBe(true);
    expect(reset.state.navigation).toMatchObject({ status: 'canceled', taskId });
    expect(reset.state.exploration).toMatchObject({ status: 'paused', reason: 'origin-reset' });
    expect(reset.state.command).toEqual({ owner: 'manual' });
    expect(reset.effects.map((effect) => effect.type)).toEqual([
      'RELEASE_USER_INPUT',
      'CANCEL_NAVIGATION_GOAL',
      'SET_COMMAND_OWNER',
      'ZERO_VELOCITY',
      'CLEAR_GOAL_DATA',
      'RESET_ROBOT_ORIGIN',
      'SET_NAVIGATION_STATUS',
      'ANNOUNCE',
    ]);

    state = dispatch(createInitialAppState(), { type: 'VIEW_REQUESTED', view: 'stage' });
    const stageReset = transitionAppState(state, { type: 'ROBOT_ORIGIN_RESET_REQUESTED' });
    expect(stageReset.accepted).toBe(true);
    expect(stageReset.state.view.mode).toBe('stage');
    expect(stageReset.state.command).toEqual({ owner: 'stopped', reason: 'stage' });
    expect(stageReset.effects.map((effect) => effect.type)).toContain('RESET_ROBOT_ORIGIN');

    const switching = dispatch(createInitialAppState(), { type: 'RUNTIME_SWITCH_REQUESTED', target: 'mapping' });
    expect(transitionAppState(switching, { type: 'ROBOT_ORIGIN_RESET_REQUESTED' }).accepted).toBe(false);
  });

  it('centralizes a runtime switch safety boundary and makes duplicate requests idempotent', () => {
    const initial = createInitialAppState();
    const result = transitionAppState(initial, { type: 'RUNTIME_SWITCH_REQUESTED', target: 'navigation' });
    expect(result.accepted).toBe(true);
    expect(result.state.runtime).toEqual({ status: 'switching', mode: 'sim', target: 'navigation', phase: 'processing' });
    expect(result.state.map).toMatchObject({ status: 'initializing', target: 'navigation', mapReceived: false, poseReceived: false });
    expect(result.state.command.owner).toBe('stopped');
    expect(result.effects.map((effect) => effect.type)).toEqual([
      'RELEASE_USER_INPUT',
      'CANCEL_NAVIGATION_GOAL',
      'SET_COMMAND_OWNER',
      'ZERO_VELOCITY',
      'CLEAR_RUNTIME_DATA',
      'RESET_NAVIGATION_ORIGIN',
      'REQUEST_RUNTIME',
    ]);
    expect(isInteractionLocked(result.state)).toBe(true);

    const duplicate = transitionAppState(result.state, { type: 'RUNTIME_SWITCH_REQUESTED', target: 'navigation' });
    expect(duplicate.accepted).toBe(true);
    expect(duplicate.state).toBe(result.state);
    expect(duplicate.effects).toEqual([]);

    const conflicting = transitionAppState(result.state, { type: 'RUNTIME_SWITCH_REQUESTED', target: 'mapping' });
    expect(conflicting.accepted).toBe(false);
    expect(conflicting.rejection).toContain('切替');
  });

  it('ignores an old stable runtime observation while a newer target is switching', () => {
    let state = createInitialAppState();
    state = dispatch(state, { type: 'RUNTIME_SWITCH_REQUESTED', target: 'navigation' });
    const stale = transitionAppState(state, { type: 'RUNTIME_MANAGER_OBSERVED', snapshot: runtimeSnapshot('sim') });
    expect(stale.accepted).toBe(false);
    expect(stale.state.runtime).toEqual({ status: 'switching', mode: 'sim', target: 'navigation', phase: 'processing' });
  });

  it('keeps navigation locked until runtime, connection, map, and pose are all ready', () => {
    let state = createInitialAppState();
    state = dispatch(state, { type: 'RUNTIME_SWITCH_REQUESTED', target: 'navigation' });
    expect(processingModalModel(state)?.title).toBe('NAV2初期化中');
    state = dispatch(state, { type: 'RUNTIME_MANAGER_OBSERVED', snapshot: runtimeSnapshot('navigation') });
    state = dispatch(state, { type: 'TRANSPORT_CHANGED', connection: 'CONNECTED' });
    state = receivePose(state);
    expect(state.map).toMatchObject({ status: 'initializing', poseReceived: true, mapReceived: false });
    expect(canEnableNavigationControl(state)).toBe(false);
    expect(isInteractionLocked(state)).toBe(true);

    state = receiveMap(state);
    expect(state.map).toMatchObject({ status: 'ready', mode: 'navigation' });
    expect(state.command).toEqual({ owner: 'manual' });
    expect(canEnableNavigationControl(state)).toBe(true);
    expect(isInteractionLocked(state)).toBe(false);
  });

  it('saves a live map in mapping or only after exploration has safely paused', () => {
    const mapping = mappingReadyState();
    expect(canSaveCurrentMap(mapping)).toBe(true);
    expect(mapSaveUnavailableReason(mapping)).toBeNull();

    const navigation = navigationReadyState();
    expect(canSaveCurrentMap(navigation)).toBe(false);
    expect(mapSaveUnavailableReason(navigation)).toContain('MAPPINGまたは探索構成');

    let exploration = explorationStarted(4);
    expect(canSaveCurrentMap(exploration)).toBe(false);
    expect(mapSaveUnavailableReason(exploration)).toContain('一時停止');

    exploration = requestExplorationGoal(exploration, 'frontier-save', 4);
    const paused = dispatch(exploration, { type: 'EXPLORATION_PAUSE_REQUESTED' });
    expect(paused.exploration).toMatchObject({ status: 'paused', reason: 'user' });
    expect(paused.navigation.status).toBe('canceled');
    expect(paused.command).toEqual({ owner: 'manual' });
    expect(canSaveCurrentMap(paused)).toBe(true);

    const stopped = dispatch(paused, { type: 'EXPLORATION_STOP_REQUESTED' });
    expect(stopped.exploration.status).toBe('idle');
    expect(stopped.map).toMatchObject({ status: 'ready', mode: 'exploration' });
    expect(canSaveCurrentMap(stopped)).toBe(true);
  });

  it('rejects command ownership and goals before readiness', () => {
    let state = createInitialAppState();
    state = dispatch(state, { type: 'RUNTIME_SWITCH_REQUESTED', target: 'navigation' });
    const command = transitionAppState(state, { type: 'COMMAND_OWNER_REQUESTED', owner: 'navigation', requestedAtMs: NOW_MS });
    expect(command.accepted).toBe(false);
    expect(command.rejection).toContain('同期');
    const goal = transitionAppState(state, { type: 'NAVIGATION_GOAL_REQUESTED', goal: testGoal(), requestedAtMs: NOW_MS });
    expect(goal.accepted).toBe(false);
    expect(goal.rejection).toContain('同期');
  });

  it('tracks goal sending, moving, success, failure, cancel, and ignores stale callbacks', () => {
    let state = navigationReadyState();
    const requested = transitionAppState(state, { type: 'NAVIGATION_GOAL_REQUESTED', goal: testGoal(), requestedAtMs: NOW_MS });
    expect(requested.accepted).toBe(true);
    state = requested.state;
    expect(state.navigation).toMatchObject({ status: 'sending', taskId: 1 });
    expect(state.command.owner).toBe('navigation');

    state = dispatch(state, { type: 'NAVIGATION_GOAL_ACCEPTED', taskId: 1, goalId: 'goal-1' });
    state = dispatch(state, { type: 'NAVIGATION_GOAL_FEEDBACK', taskId: 1 });
    expect(state.navigation).toMatchObject({ status: 'moving', goalId: 'goal-1' });
    state = dispatch(state, { type: 'NAVIGATION_GOAL_SUCCEEDED', taskId: 1 });
    expect(state.navigation.status).toBe('succeeded');
    expect(state.command.owner).toBe('manual');

    state = dispatch(state, { type: 'NAVIGATION_GOAL_REQUESTED', goal: testGoal(), requestedAtMs: NOW_MS });
    expect(state.navigation).toMatchObject({ status: 'sending', taskId: 2 });
    const stale = transitionAppState(state, { type: 'NAVIGATION_GOAL_FAILED', taskId: 1, error: 'old failure', canceled: false });
    expect(stale.accepted).toBe(false);
    expect(stale.state.navigation).toMatchObject({ status: 'sending', taskId: 2 });

    state = dispatch(state, { type: 'NAVIGATION_GOAL_FAILED', taskId: 2, error: '経路を作れませんでした', canceled: false });
    expect(state.navigation).toMatchObject({ status: 'failed', error: '経路を作れませんでした' });
    state = dispatch(state, { type: 'NAVIGATION_GOAL_CANCEL_REQUESTED', status: '目標を取り消しました / 停止中' });
    expect(state.navigation.status).toBe('idle');
    expect(state.command.owner).toBe('manual');
  });

  it('stops and requires fresh map/pose evidence after disconnect and reconnect', () => {
    let state = navigationReadyState();
    state = dispatch(state, { type: 'NAVIGATION_GOAL_REQUESTED', goal: testGoal(), requestedAtMs: NOW_MS });
    const disconnected = transitionAppState(state, { type: 'TRANSPORT_CHANGED', connection: 'RECONNECTING' });
    expect(disconnected.state.command).toEqual({ owner: 'stopped', reason: 'transport' });
    expect(disconnected.state.navigation.status).toBe('canceled');
    expect(disconnected.state.map).toMatchObject({ status: 'initializing', target: 'navigation', reason: 'reconnect', mapReceived: false, poseReceived: false });
    expect(disconnected.effects.map((effect) => effect.type)).toEqual([
      'RELEASE_USER_INPUT',
      'CANCEL_NAVIGATION_GOAL',
      'SET_COMMAND_OWNER',
      'ZERO_VELOCITY',
      'CLEAR_RUNTIME_DATA',
      'SET_NAVIGATION_STATUS',
      'ANNOUNCE',
    ]);

    state = dispatch(disconnected.state, { type: 'TRANSPORT_CHANGED', connection: 'CONNECTED' });
    expect(canEnableNavigationControl(state)).toBe(false);
    state = receiveMap(state);
    expect(canEnableNavigationControl(state)).toBe(false);
    state = receivePose(state);
    expect(canEnableNavigationControl(state)).toBe(true);
  });

  it('preserves the requested target when transport loss arrives during a runtime switch', () => {
    let state = createInitialAppState();
    state = dispatch(state, { type: 'RUNTIME_SWITCH_REQUESTED', target: 'navigation' });
    const cycle = state.map.cycle;
    const disconnected = transitionAppState(state, { type: 'TRANSPORT_CHANGED', connection: 'DISCONNECTED' });
    expect(disconnected.accepted).toBe(true);
    expect(disconnected.state.runtime).toEqual({ status: 'switching', mode: 'sim', target: 'navigation', phase: 'processing' });
    expect(disconnected.state.map).toMatchObject({
      status: 'initializing',
      target: 'navigation',
      reason: 'reconnect',
      mapReceived: false,
      poseReceived: false,
      cycle: cycle + 1,
    });

    const reconnecting = transitionAppState(disconnected.state, { type: 'TRANSPORT_CHANGED', connection: 'RECONNECTING' });
    expect(reconnecting.state.map).toMatchObject({ status: 'initializing', target: 'navigation', cycle: cycle + 1 });
  });

  it('rotates a partial exploration readiness session and rejects old map/pose callbacks after reconnect', () => {
    let state = createInitialAppState();
    state = dispatch(state, { type: 'RUNTIME_SWITCH_REQUESTED', target: 'exploration' });
    state = dispatch(state, { type: 'RUNTIME_MANAGER_OBSERVED', snapshot: runtimeSnapshot('exploration') });
    state = dispatch(state, { type: 'TRANSPORT_CHANGED', connection: 'CONNECTED' });
    state = receiveMap(state);
    state = observeExplorationMap(state, 1);
    state = receivePose(state);
    state = observeExplorationPose(state);
    const oldCycle = state.map.cycle;
    expect(state.map).toMatchObject({
      status: 'initializing',
      mapReceived: true,
      poseReceived: true,
      navigationReceived: false,
      cycle: oldCycle,
    });

    state = dispatch(state, { type: 'TRANSPORT_CHANGED', connection: 'RECONNECTING' });
    const reconnectCycle = state.map.cycle;
    expect(reconnectCycle).toBe(oldCycle + 1);
    expect(state.map).toMatchObject({
      status: 'initializing',
      target: 'exploration',
      reason: 'reconnect',
      mapReceived: false,
      poseReceived: false,
      navigationReceived: false,
      cycle: reconnectCycle,
    });
    expect(transitionAppState(state, { type: 'MAP_RECEIVED', cycle: oldCycle }).accepted).toBe(false);
    expect(transitionAppState(state, { type: 'POSE_READY', cycle: oldCycle }).accepted).toBe(false);
    expect(transitionAppState(state, { type: 'NAVIGATION_READY', cycle: oldCycle }).accepted).toBe(false);
    expect(transitionAppState(state, { type: 'MAP_RECEIVED', cycle: reconnectCycle }).accepted).toBe(false);
    expect(transitionAppState(state, { type: 'POSE_READY', cycle: reconnectCycle }).accepted).toBe(false);

    state = dispatch(state, { type: 'TRANSPORT_CHANGED', connection: 'CONNECTED' });
    state = receiveMap(state);
    state = receivePose(state);
    state = dispatch(state, { type: 'NAVIGATION_READY', cycle: reconnectCycle });
    expect(state.map).toMatchObject({ status: 'ready', mode: 'exploration', cycle: reconnectCycle });
  });

  it('requires a fresh readiness cycle when a transport error reconnects', () => {
    let state = navigationReadyState();
    state = dispatch(state, { type: 'TRANSPORT_CHANGED', connection: 'ERROR', detail: 'socket error' });
    const reconnectCycle = state.map.cycle;
    expect(state.map).toMatchObject({ status: 'initializing', target: 'navigation', reason: 'reconnect', mapReceived: false, poseReceived: false });
    expect(isInteractionLocked(state)).toBe(true);
    expect(processingModalModel(state)?.status).toContain('再接続');

    state = dispatch(state, { type: 'TRANSPORT_CHANGED', connection: 'CONNECTED' });
    expect(state.map).toMatchObject({ status: 'initializing', target: 'navigation', reason: 'reconnect', mapReceived: false, poseReceived: false });
    expect(state.map.cycle).toBe(reconnectCycle);
    expect(state.command.owner).toBe('stopped');
    expect(isInteractionLocked(state)).toBe(true);
    state = receiveMap(state);
    state = receivePose(state);
    expect(canEnableNavigationControl(state)).toBe(true);
  });

  it('makes STAGE entry a safe boundary and rejects it during initialization', () => {
    let state = navigationReadyState();
    state = dispatch(state, { type: 'NAVIGATION_GOAL_REQUESTED', goal: testGoal(), requestedAtMs: NOW_MS });
    const stage = transitionAppState(state, { type: 'VIEW_REQUESTED', view: 'stage' });
    expect(stage.accepted).toBe(true);
    expect(stage.state.view).toEqual({ mode: 'stage', surface: 'plan', gesture: 'idle' });
    expect(stage.state.command).toEqual({ owner: 'stopped', reason: 'stage' });
    expect(stage.state.navigation.status).toBe('canceled');
    expect(stage.effects.map((effect) => effect.type)).toContain('ENTER_STAGE');
    expect(stage.effects.map((effect) => effect.type)).toContain('CANCEL_NAVIGATION_GOAL');

    const sim = dispatch(stage.state, { type: 'VIEW_REQUESTED', view: 'sim' });
    expect(sim.view).toEqual({ mode: 'sim' });
    expect(sim.command).toEqual({ owner: 'manual' });

    let switching = createInitialAppState();
    switching = dispatch(switching, { type: 'RUNTIME_SWITCH_REQUESTED', target: 'mapping' });
    const rejectedStage = transitionAppState(switching, { type: 'VIEW_REQUESTED', view: 'stage' });
    expect(rejectedStage.accepted).toBe(false);
  });

  it('sequences navigation reset through mapping and waits for the new map', () => {
    let state = navigationReadyState();
    const reset = transitionAppState(state, { type: 'MAP_RESET_REQUESTED' });
    expect(reset.accepted).toBe(true);
    state = reset.state;
    expect(state.runtime).toEqual({ status: 'switching', mode: 'navigation', target: 'mapping', phase: 'processing' });
    expect(state.map).toMatchObject({ status: 'resetting', phase: 'switching-to-mapping' });
    expect(reset.effects.at(-1)).toEqual({ type: 'REQUEST_RUNTIME', mode: 'mapping' });

    const mapping = transitionAppState(state, { type: 'RUNTIME_MANAGER_OBSERVED', snapshot: runtimeSnapshot('mapping') });
    expect(mapping.accepted).toBe(true);
    state = mapping.state;
    expect(state.map).toMatchObject({ status: 'resetting', phase: 'requesting-reset' });
    expect(mapping.effects).toContainEqual({ type: 'REQUEST_MAP_RESET' });
    expect(transitionAppState(state, { type: 'MAP_RECEIVED', cycle: state.map.cycle }).accepted).toBe(false);

    const failed = transitionAppState(state, { type: 'MAP_RESET_COMPLETED', success: false, error: 'reset service error' });
    expect(failed.state.map).toMatchObject({ status: 'error', target: 'mapping' });
    expect(failed.state.command).toEqual({ owner: 'stopped', reason: 'map-error' });
    expect(isInteractionLocked(failed.state)).toBe(false);
    expect(transitionAppState(failed.state, { type: 'MAP_RESET_REQUESTED' }).accepted).toBe(true);

    const completed = transitionAppState(state, { type: 'MAP_RESET_COMPLETED', success: true });
    expect(completed.effects.at(0)).toEqual({ type: 'CLEAR_RUNTIME_DATA' });
    state = completed.state;
    expect(state.map).toMatchObject({ status: 'initializing', target: 'mapping', reason: 'map-reset', mapReceived: false });
    expect(isInteractionLocked(state)).toBe(true);
    state = receiveMap(state);
    expect(state.map).toMatchObject({ status: 'ready', mode: 'mapping' });
    expect(isInteractionLocked(state)).toBe(false);

    const duplicate = transitionAppState(state, { type: 'MAP_RECEIVED', cycle: state.map.cycle });
    expect(duplicate.accepted).toBe(true);
    expect(duplicate.state).toBe(state);
    expect(duplicate.effects).toEqual([]);
  });

  it('suspends ROS graph service queries during runtime replacement and map reset', () => {
    const ready = mappingReadyState();
    expect(canQueryRosGraph(ready)).toBe(true);

    const switching = dispatch(ready, { type: 'RUNTIME_SWITCH_REQUESTED', target: 'exploration' });
    expect(canQueryRosGraph(switching)).toBe(false);

    const resetting = dispatch(ready, { type: 'MAP_RESET_REQUESTED' });
    expect(canQueryRosGraph(resetting)).toBe(false);

    const resetComplete = dispatch(resetting, { type: 'MAP_RESET_COMPLETED', success: true });
    expect(canQueryRosGraph(resetComplete)).toBe(false);
  });

  it('waits for map and pose evidence before querying rosapi during cold exploration initialization', () => {
    let state = createInitialAppState();
    state = dispatch(state, { type: 'RUNTIME_MANAGER_OBSERVED', snapshot: runtimeSnapshot('exploration') });
    state = dispatch(state, { type: 'TRANSPORT_CHANGED', connection: 'CONNECTED' });
    expect(state.map).toMatchObject({ status: 'initializing', mapReceived: false, poseReceived: false });
    expect(canQueryRosGraph(state)).toBe(false);

    state = dispatch(state, { type: 'MAP_RECEIVED', cycle: state.map.cycle });
    expect(canQueryRosGraph(state)).toBe(false);
    state = dispatch(state, { type: 'POSE_READY', cycle: state.map.cycle });
    expect(canQueryRosGraph(state)).toBe(true);

    state = dispatch(state, { type: 'NAVIGATION_READY', cycle: state.map.cycle });
    state = dispatch(state, { type: 'NAVIGATION_UNAVAILABLE', cycle: state.map.cycle, status: 'health check' });
    expect(state.map).toMatchObject({ status: 'initializing', reason: 'navigation-health' });
    expect(canQueryRosGraph(state)).toBe(true);
  });

  it('rejects delayed maps outside the active mapping or navigation readiness', () => {
    const sim = createInitialAppState();
    expect(transitionAppState(sim, { type: 'MAP_RECEIVED', cycle: sim.map.cycle }).accepted).toBe(false);

    let base = dispatch(sim, { type: 'RUNTIME_SWITCH_REQUESTED', target: 'base' });
    base = dispatch(base, { type: 'RUNTIME_MANAGER_OBSERVED', snapshot: runtimeSnapshot('base') });
    expect(transitionAppState(base, { type: 'MAP_RECEIVED', cycle: base.map.cycle }).accepted).toBe(false);
  });

  it('unlocks an explicit initialization error while keeping command ownership stopped', () => {
    let state = createInitialAppState();
    state = dispatch(state, { type: 'RUNTIME_SWITCH_REQUESTED', target: 'mapping' });
    state = dispatch(state, {
      type: 'RUNTIME_MANAGER_OBSERVED',
      snapshot: runtimeSnapshot('sim', { target: 'mapping', error: 'SLAM Toolboxを起動できませんでした。' }),
    });
    expect(state.runtime.status).toBe('error');
    expect(state.map.status).toBe('error');
    expect(state.command.owner).toBe('stopped');
    expect(isInteractionLocked(state)).toBe(false);
    expect(canAcceptManualMotion(state)).toBe(false);
    expect(processingModalModel(state)).toBeNull();

    const retry = transitionAppState(state, { type: 'RUNTIME_SWITCH_REQUESTED', target: 'mapping' });
    expect(retry.accepted).toBe(true);
    expect(retry.state.runtime).toEqual({ status: 'switching', mode: 'sim', target: 'mapping', phase: 'processing' });
    expect(retry.state.map).toMatchObject({ status: 'initializing', target: 'mapping', reason: 'runtime-switch' });
    expect(isInteractionLocked(retry.state)).toBe(true);
  });

  it('applies the stop boundary when an external runtime observation leaves navigation', () => {
    let state = navigationReadyState();
    state = dispatch(state, { type: 'NAVIGATION_GOAL_REQUESTED', goal: testGoal(), requestedAtMs: NOW_MS });
    state = dispatch(state, { type: 'NAVIGATION_GOAL_ACCEPTED', taskId: 1, goalId: 'goal-1' });
    state = dispatch(state, { type: 'NAVIGATION_GOAL_FEEDBACK', taskId: 1 });

    const observed = transitionAppState(state, { type: 'RUNTIME_MANAGER_OBSERVED', snapshot: runtimeSnapshot('base') });
    expect(observed.accepted).toBe(true);
    expect(observed.state.runtime).toEqual({ status: 'stable', mode: 'base' });
    expect(observed.state.map.status).toBe('unavailable');
    expect(observed.state.navigation.status).toBe('canceled');
    expect(observed.state.command.owner).toBe('manual');
    expect(observed.effects.map((effect) => effect.type)).toEqual([
      'RELEASE_USER_INPUT',
      'CANCEL_NAVIGATION_GOAL',
      'SET_COMMAND_OWNER',
      'ZERO_VELOCITY',
      'CLEAR_RUNTIME_DATA',
    ]);
  });

  it('requires live map, SLAM pose, and Nav2 readiness before exploration starts', () => {
    let state = createInitialAppState();
    state = dispatch(state, { type: 'RUNTIME_SWITCH_REQUESTED', target: 'exploration' });
    expect(processingModalModel(state)?.title).toBe('探索構成初期化中');
    state = dispatch(state, { type: 'RUNTIME_MANAGER_OBSERVED', snapshot: runtimeSnapshot('exploration') });
    state = dispatch(state, { type: 'TRANSPORT_CHANGED', connection: 'CONNECTED' });
    state = receiveMap(state);
    state = observeExplorationMap(state, 1);
    state = receivePose(state);
    state = observeExplorationPose(state);
    expect(state.map).toMatchObject({
      status: 'initializing',
      target: 'exploration',
      mapReceived: true,
      poseReceived: true,
      navigationReceived: false,
    });
    expect(canStartExploration(state, freshness(1))).toBe(false);
    expect(explorationUnavailableReason(state)).toContain('Nav2');
    expect(transitionAppState(state, { type: 'EXPLORATION_START_REQUESTED', mapGeneration: 1, requestedAtMs: NOW_MS }).accepted).toBe(false);

    state = dispatch(state, { type: 'NAVIGATION_READY', cycle: state.map.cycle });
    expect(state.map).toMatchObject({ status: 'ready', mode: 'exploration' });
    expect(canEnableNavigationControl(state)).toBe(true);
    expect(canStartExploration(state, freshness(1))).toBe(true);
    expect(explorationUnavailableReason(state)).toBeNull();
  });

  it('binds Nav2 readiness evidence to the current readiness cycle', () => {
    let state = createInitialAppState();
    state = dispatch(state, { type: 'RUNTIME_SWITCH_REQUESTED', target: 'exploration' });
    state = dispatch(state, { type: 'RUNTIME_MANAGER_OBSERVED', snapshot: runtimeSnapshot('exploration') });
    state = dispatch(state, { type: 'TRANSPORT_CHANGED', connection: 'CONNECTED' });
    state = receiveMap(state);
    state = receivePose(state);
    const cycle = state.map.cycle;

    const stale = transitionAppState(state, { type: 'NAVIGATION_READY', cycle: cycle - 1 });
    expect(stale.accepted).toBe(false);
    expect(stale.state).toBe(state);
    expect(state.map).toMatchObject({ status: 'initializing', navigationReceived: false, cycle });

    const current = transitionAppState(state, { type: 'NAVIGATION_READY', cycle });
    expect(current.accepted).toBe(true);
    expect(current.state.map).toMatchObject({ status: 'ready', mode: 'exploration', cycle });
  });

  it('rejects start and resume with expired map or pose evidence before entering evaluating', () => {
    const ready = explorationReadyState(2);
    const stalePoseAt = NOW_MS + EXPLORATION_POSE_FRESHNESS_MS + 1;
    const stalePoseStart = transitionAppState(ready, {
      type: 'EXPLORATION_START_REQUESTED',
      mapGeneration: 2,
      requestedAtMs: stalePoseAt,
    });
    expect(stalePoseStart.accepted).toBe(false);
    expect(stalePoseStart.rejection).toContain('SLAM poseが古い');
    expect(stalePoseStart.state.exploration.status).toBe('idle');
    expect(canStartExploration(ready, freshness(2, stalePoseAt))).toBe(false);

    const staleMapStart = transitionAppState(ready, {
      type: 'EXPLORATION_START_REQUESTED',
      mapGeneration: 2,
      requestedAtMs: NOW_MS + EXPLORATION_MAP_FRESHNESS_MS + 1,
    });
    expect(staleMapStart.accepted).toBe(false);
    expect(staleMapStart.rejection).toContain('live mapが古い');

    let paused = dispatch(explorationStarted(3), { type: 'EXPLORATION_PAUSE_REQUESTED' });
    paused = observeExplorationMap(paused, 4);
    const staleResume = transitionAppState(paused, {
      type: 'EXPLORATION_RESUME_REQUESTED',
      mapGeneration: 4,
      requestedAtMs: stalePoseAt,
    });
    expect(staleResume.accepted).toBe(false);
    expect(staleResume.rejection).toContain('SLAM poseが古い');
    expect(staleResume.state.exploration.status).toBe('paused');

    paused = observeExplorationPose(paused, stalePoseAt);
    const resumed = transitionAppState(paused, {
      type: 'EXPLORATION_RESUME_REQUESTED',
      mapGeneration: 4,
      requestedAtMs: stalePoseAt,
    });
    expect(resumed.accepted).toBe(true);
    expect(resumed.state.exploration).toMatchObject({ status: 'evaluating', mapGeneration: 4 });
  });

  it('rejects direct manual motion throughout active exploration and requires an explicit manual-owner pause', () => {
    let state = explorationStarted(5);
    expect(state.exploration.status).toBe('evaluating');
    expect(state.command).toEqual({ owner: 'manual' });
    expect(canAcceptManualMotion(state)).toBe(false);

    const manual = transitionAppState(state, { type: 'COMMAND_OWNER_REQUESTED', owner: 'manual', requestedAtMs: NOW_MS });
    expect(manual.accepted).toBe(true);
    state = manual.state;
    expect(state.exploration).toMatchObject({ status: 'paused', reason: 'manual-override' });
    expect(canAcceptManualMotion(state)).toBe(true);
    expect(manual.effects.map((effect) => effect.type)).toEqual(expect.arrayContaining([
      'CANCEL_NAVIGATION_GOAL',
      'SET_COMMAND_OWNER',
      'ZERO_VELOCITY',
    ]));

    state = observeExplorationMap(state, 6);
    state = dispatch(state, { type: 'EXPLORATION_RESUME_REQUESTED', mapGeneration: 6, requestedAtMs: NOW_MS });
    expect(canAcceptManualMotion(state)).toBe(false);
    state = requestExplorationGoal(state, 'frontier-manual-guard', 6);
    expect(canAcceptManualMotion(state)).toBe(false);
    state = dispatch(state, { type: 'NAVIGATION_GOAL_FEEDBACK', taskId: state.navigation.taskId });
    expect(state.exploration.status).toBe('moving');
    expect(canAcceptManualMotion(state)).toBe(false);
    state = dispatch(state, { type: 'NAVIGATION_GOAL_FAILED', taskId: state.navigation.taskId, error: 'blocked', canceled: false });
    expect(state.exploration.status).toBe('replanning');
    expect(state.command).toEqual({ owner: 'manual' });
    expect(canAcceptManualMotion(state)).toBe(false);
  });

  it('coalesces an in-flight evaluation onto a newer map generation and rejects the stale result', () => {
    let state = explorationStarted(8);
    const generation = state.exploration.generation;
    state = observeExplorationMap(state, 9);
    const latest = transitionAppState(state, { type: 'EXPLORATION_EVALUATION_REQUESTED', generation, mapGeneration: 9 });
    expect(latest.accepted).toBe(true);
    state = latest.state;
    expect(state.exploration).toMatchObject({ status: 'evaluating', mapGeneration: 9, lastMapGeneration: 9 });
    expect(latest.effects.at(-1)).toMatchObject({ type: 'EVALUATE_EXPLORATION_MAP', generation, mapGeneration: 9 });

    expect(transitionAppState(state, {
      type: 'EXPLORATION_GOAL_REQUESTED',
      generation,
      mapGeneration: 8,
      candidateId: 'stale-frontier',
      goal: testGoal(),
      requestedAtMs: NOW_MS,
    }).accepted).toBe(false);
    expect(transitionAppState(state, { type: 'EXPLORATION_EVALUATION_REQUESTED', generation, mapGeneration: 9 }).accepted).toBe(false);
    expect(transitionAppState(state, { type: 'EXPLORATION_NO_CANDIDATES', generation, mapGeneration: 8, reason: 'no-frontiers', exploredCoverageRatio: .7 }).accepted).toBe(false);
  });

  it('routes exploration goals through the existing navigation task and replans only from a fresh map after success', () => {
    let state = explorationReadyState(10);
    const started = transitionAppState(state, { type: 'EXPLORATION_START_REQUESTED', mapGeneration: 10, requestedAtMs: NOW_MS });
    expect(started.accepted).toBe(true);
    state = started.state;
    expect(state.exploration).toMatchObject({
      status: 'evaluating',
      generation: 1,
      goalPolicy: 'coverage',
      mapGeneration: 10,
      retryCount: 0,
      replanCount: 0,
      noCandidateConfirmations: 0,
      blacklistedCandidateIds: [],
    });
    expect(started.effects.at(-1)).toMatchObject({ type: 'EVALUATE_EXPLORATION_MAP', generation: 1, mapGeneration: 10 });

    const goal = transitionAppState(state, {
      type: 'EXPLORATION_GOAL_REQUESTED',
      generation: 1,
      mapGeneration: 10,
      candidateId: 'frontier-a',
      goal: testGoal(),
      requestedAtMs: NOW_MS,
    });
    expect(goal.accepted).toBe(true);
    state = goal.state;
    expect(state.navigation).toMatchObject({ status: 'sending', source: 'exploration', taskId: 1 });
    expect(state.exploration).toMatchObject({ status: 'sending', taskId: 1, selected: { candidateId: 'frontier-a', mapGeneration: 10 } });
    expect(explorationUnavailableReason(state)).toBeNull();
    expect(goal.effects).toContainEqual({ type: 'SEND_NAVIGATION_GOAL', goal: testGoal(), taskId: 1 });

    state = dispatch(state, { type: 'NAVIGATION_GOAL_ACCEPTED', taskId: 1, goalId: 'explore-goal-1' });
    state = dispatch(state, { type: 'NAVIGATION_GOAL_FEEDBACK', taskId: 1 });
    expect(state.navigation).toMatchObject({ status: 'moving', source: 'exploration' });
    expect(state.exploration).toMatchObject({ status: 'moving', taskId: 1 });

    state = observeExplorationMap(state, 12);

    const succeeded = transitionAppState(state, { type: 'NAVIGATION_GOAL_SUCCEEDED', taskId: 1 });
    expect(succeeded.accepted).toBe(true);
    state = succeeded.state;
    expect(state.navigation).toMatchObject({ status: 'succeeded', source: 'exploration' });
    expect(state.exploration).toMatchObject({
      status: 'replanning',
      reason: 'goal-succeeded',
      afterMapGeneration: 12,
      requireFreshMap: true,
      replanCount: 1,
    });
    expect(state.command).toEqual({ owner: 'manual' });
    expect(succeeded.effects.map((effect) => effect.type)).toContain('ZERO_VELOCITY');
    expect(succeeded.effects.at(-1)).toEqual({
      type: 'WAIT_FOR_EXPLORATION_MAP',
      generation: 1,
      afterMapGeneration: 12,
      requireFreshMap: true,
    });

    const delayedNavigationEcho = transitionAppState(state, {
      type: 'COMMAND_OWNER_OBSERVED',
      owner: 'navigation',
      observedAtMs: NOW_MS + COMMAND_OWNER_ACK_TIMEOUT_MS + 1,
    });
    expect(delayedNavigationEcho.accepted).toBe(true);
    expect(delayedNavigationEcho.state.exploration).toMatchObject({ status: 'replanning', reason: 'goal-succeeded' });
    expect(delayedNavigationEcho.state.navigation.status).toBe('succeeded');
    expect(delayedNavigationEcho.state.command).toEqual({ owner: 'manual' });
    expect(delayedNavigationEcho.effects.map((effect) => effect.type)).toEqual([
      'SET_COMMAND_OWNER',
      'ZERO_VELOCITY',
      'SET_NAVIGATION_STATUS',
    ]);

    const stale = transitionAppState(state, { type: 'EXPLORATION_EVALUATION_REQUESTED', generation: 1, mapGeneration: 12 });
    expect(stale.accepted).toBe(false);
    expect(stale.rejection).toContain('古いmap generation');
    state = observeExplorationMap(state, 13);
    const fresh = transitionAppState(state, { type: 'EXPLORATION_EVALUATION_REQUESTED', generation: 1, mapGeneration: 13 });
    expect(fresh.accepted).toBe(true);
    expect(fresh.state.exploration).toMatchObject({ status: 'evaluating', mapGeneration: 13 });
  });

  it('keeps the bounded owner session after ack so duplicate manual echoes cannot pause exploration', () => {
    const pending = requestExplorationGoal(explorationStarted(13), 'frontier-owner-race', 13);
    expect(pending.pendingCommandOwner).toEqual({
      owner: 'navigation',
      requestedAtMs: NOW_MS,
      expiresAtMs: NOW_MS + COMMAND_OWNER_ACK_TIMEOUT_MS,
      acknowledged: false,
    });

    const staleManual = transitionAppState(pending, {
      type: 'COMMAND_OWNER_OBSERVED',
      owner: 'manual',
      observedAtMs: NOW_MS + 10,
    });
    expect(staleManual.accepted).toBe(true);
    expect(staleManual.state).toBe(pending);
    expect(staleManual.effects).toEqual([]);
    expect(staleManual.state.navigation.status).toBe('sending');
    expect(staleManual.state.exploration.status).toBe('sending');

    const acknowledged = transitionAppState(staleManual.state, {
      type: 'COMMAND_OWNER_OBSERVED',
      owner: 'navigation',
      observedAtMs: NOW_MS + 20,
    });
    expect(acknowledged.accepted).toBe(true);
    expect(acknowledged.state.pendingCommandOwner).toEqual({
      owner: 'navigation',
      requestedAtMs: NOW_MS,
      expiresAtMs: NOW_MS + COMMAND_OWNER_ACK_TIMEOUT_MS,
      acknowledged: true,
    });
    expect(acknowledged.state.exploration.status).toBe('sending');

    const duplicateManual = transitionAppState(acknowledged.state, {
      type: 'COMMAND_OWNER_OBSERVED',
      owner: 'manual',
      observedAtMs: NOW_MS + 30,
    });
    expect(duplicateManual.state).toBe(acknowledged.state);
    expect(duplicateManual.effects).toEqual([]);
    expect(duplicateManual.state.exploration.status).toBe('sending');

    const realManualOverride = transitionAppState(duplicateManual.state, {
      type: 'COMMAND_OWNER_OBSERVED',
      owner: 'manual',
      observedAtMs: NOW_MS + COMMAND_OWNER_ACK_TIMEOUT_MS + 1,
    });
    expect(realManualOverride.state.pendingCommandOwner).toBeNull();
    expect(realManualOverride.state.exploration).toMatchObject({ status: 'paused', reason: 'manual-override' });
    expect(realManualOverride.state.navigation.status).toBe('canceled');
    expect(realManualOverride.effects.map((effect) => effect.type)).toEqual([
      'CANCEL_NAVIGATION_GOAL',
      'ZERO_VELOCITY',
      'CLEAR_GOAL_DATA',
    ]);

    const cleanupPending = requestExplorationGoal(explorationStarted(14), 'frontier-owner-cleanup', 14);
    const cleanupAcknowledged = transitionAppState(cleanupPending, {
      type: 'COMMAND_OWNER_OBSERVED',
      owner: 'navigation',
      observedAtMs: NOW_MS + 20,
    });
    const cleaned = transitionAppState(cleanupAcknowledged.state, {
      type: 'COMMAND_OWNER_OBSERVED',
      owner: 'navigation',
      observedAtMs: NOW_MS + COMMAND_OWNER_ACK_TIMEOUT_MS + 1,
    });
    expect(cleaned.state.pendingCommandOwner).toBeNull();
    expect(cleaned.state.exploration.status).toBe('sending');
    expect(cleaned.state.navigation.status).toBe('sending');
  });

  it('captures the latest observed map as the unexpected-cancel barrier', () => {
    let state = requestExplorationGoal(explorationStarted(14), 'frontier-cancel', 14);
    state = dispatch(state, { type: 'NAVIGATION_GOAL_FEEDBACK', taskId: state.navigation.taskId });
    state = observeExplorationMap(state, 16);
    const taskId = state.navigation.taskId;

    const canceled = transitionAppState(state, {
      type: 'NAVIGATION_GOAL_FAILED',
      taskId,
      error: 'goal canceled',
      canceled: true,
    });
    expect(canceled.accepted).toBe(true);
    expect(canceled.state.exploration).toMatchObject({
      status: 'replanning',
      reason: 'goal-canceled',
      afterMapGeneration: 16,
      lastMapGeneration: 16,
      requireFreshMap: true,
    });
    expect(canceled.effects.at(-1)).toMatchObject({
      type: 'WAIT_FOR_EXPLORATION_MAP',
      afterMapGeneration: 16,
      requireFreshMap: true,
    });
    expect(transitionAppState(canceled.state, {
      type: 'EXPLORATION_EVALUATION_REQUESTED',
      generation: canceled.state.exploration.generation,
      mapGeneration: 16,
    }).accepted).toBe(false);

    state = observeExplorationMap(canceled.state, 17);
    const fresh = transitionAppState(state, {
      type: 'EXPLORATION_EVALUATION_REQUESTED',
      generation: state.exploration.generation,
      mapGeneration: 17,
    });
    expect(fresh.accepted).toBe(true);
    expect(fresh.state.exploration).toMatchObject({ status: 'evaluating', mapGeneration: 17 });
  });

  it('cancels the current exploration goal and replans elsewhere after a successful BackUp without counting a failure', () => {
    let state = requestExplorationGoal(explorationStarted(18), 'frontier-narrow', 18);
    state = dispatch(state, { type: 'NAVIGATION_GOAL_FEEDBACK', taskId: state.navigation.taskId });
    state = observeExplorationMap(state, 19);
    const taskId = state.navigation.taskId;

    const diverted = transitionAppState(state, { type: 'EXPLORATION_RECOVERY_DIVERSION_REQUESTED', taskId });

    expect(diverted.accepted).toBe(true);
    expect(diverted.state.navigation).toEqual({ status: 'canceled', taskId, source: 'exploration' });
    expect(diverted.state.command).toEqual({ owner: 'manual' });
    expect(diverted.state.exploration).toMatchObject({
      status: 'replanning',
      reason: 'recovery-diversion',
      retryCount: 0,
      replanCount: 1,
      afterMapGeneration: 19,
      requireFreshMap: false,
      blacklistedCandidateIds: ['frontier-narrow'],
    });
    expect(diverted.effects.map((effect) => effect.type)).toEqual([
      'CANCEL_NAVIGATION_GOAL',
      'SET_COMMAND_OWNER',
      'ZERO_VELOCITY',
      'CLEAR_GOAL_DATA',
      'SET_NAVIGATION_STATUS',
      'WAIT_FOR_EXPLORATION_MAP',
    ]);
    expect(diverted.effects.at(-1)).toMatchObject({
      type: 'WAIT_FOR_EXPLORATION_MAP',
      afterMapGeneration: 19,
      requireFreshMap: false,
    });

    expect(transitionAppState(diverted.state, { type: 'NAVIGATION_GOAL_FAILED', taskId, error: 'late cancel', canceled: true }).accepted).toBe(false);
    expect(transitionAppState(state, { type: 'EXPLORATION_RECOVERY_DIVERSION_REQUESTED', taskId: taskId + 1 }).accepted).toBe(false);

    const safetyStopped = dispatch(state, { type: 'SAFETY_CHANGED', stopped: true });
    expect(transitionAppState(safetyStopped, { type: 'EXPLORATION_RECOVERY_DIVERSION_REQUESTED', taskId }).accepted).toBe(false);

    const operatorState = dispatch(navigationReadyState(), { type: 'COMMAND_OWNER_REQUESTED', owner: 'navigation', requestedAtMs: NOW_MS });
    const operatorGoal = dispatch(operatorState, { type: 'NAVIGATION_GOAL_REQUESTED', goal: testGoal(), requestedAtMs: NOW_MS });
    expect(transitionAppState(operatorGoal, { type: 'EXPLORATION_RECOVERY_DIVERSION_REQUESTED', taskId: operatorGoal.navigation.taskId }).accepted).toBe(false);
  });

  it('confirms candidate exhaustion only after sufficient observed coverage and three fresh maps', () => {
    let state = explorationStarted(20);
    const generation = state.exploration.generation;
    const first = transitionAppState(state, { type: 'EXPLORATION_NO_CANDIDATES', generation, mapGeneration: 20, reason: 'no-frontiers', exploredCoverageRatio: .92 });
    expect(first.accepted).toBe(true);
    state = first.state;
    expect(state.exploration).toMatchObject({
      status: 'replanning',
      reason: 'no-candidates',
      noCandidateConfirmations: 1,
      requireFreshMap: true,
      replanCount: 1,
    });
    expect(EXPLORATION_NO_CANDIDATE_CONFIRMATIONS_REQUIRED).toBe(3);
    expect(transitionAppState(state, { type: 'EXPLORATION_EVALUATION_REQUESTED', generation, mapGeneration: 20 }).accepted).toBe(false);

    state = observeExplorationMap(state, 21);
    state = dispatch(state, { type: 'EXPLORATION_EVALUATION_REQUESTED', generation, mapGeneration: 21 });
    const second = transitionAppState(state, { type: 'EXPLORATION_NO_CANDIDATES', generation, mapGeneration: 21, reason: 'no-frontiers', exploredCoverageRatio: .91 });
    expect(second.state.exploration).toMatchObject({ status: 'replanning', noCandidateConfirmations: 2 });

    state = observeExplorationMap(second.state, 22);
    state = dispatch(state, { type: 'EXPLORATION_EVALUATION_REQUESTED', generation, mapGeneration: 22 });
    const completed = transitionAppState(state, { type: 'EXPLORATION_NO_CANDIDATES', generation, mapGeneration: 22, reason: 'no-frontiers', exploredCoverageRatio: .9 });
    expect(completed.accepted).toBe(true);
    expect(completed.state.exploration).toMatchObject({
      status: 'completed',
      confirmedMapGeneration: 22,
      noCandidateConfirmations: 3,
      replanCount: 2,
    });
    expect(completed.state.command).toEqual({ owner: 'manual' });
    expect(completed.effects.map((effect) => effect.type)).toContain('ZERO_VELOCITY');
    expect(canStopExploration(completed.state)).toBe(true);
  });

  it('completes after three fresh maps when sufficient coverage leaves no reachable safe frontier goal', () => {
    let state = explorationStarted(23);
    const generation = state.exploration.generation;

    for (let confirmation = 1; confirmation <= EXPLORATION_NO_CANDIDATE_CONFIRMATIONS_REQUIRED; confirmation += 1) {
      const mapGeneration = 22 + confirmation;
      if (confirmation > 1) {
        state = observeExplorationMap(state, mapGeneration);
        state = dispatch(state, { type: 'EXPLORATION_EVALUATION_REQUESTED', generation, mapGeneration });
      }
      const result = transitionAppState(state, {
        type: 'EXPLORATION_NO_CANDIDATES',
        generation,
        mapGeneration,
        reason: 'no-eligible-candidates',
        exploredCoverageRatio: .91,
      });

      expect(result.accepted).toBe(true);
      expect(result.state.exploration).toMatchObject({ noCandidateConfirmations: confirmation });
      if (confirmation < EXPLORATION_NO_CANDIDATE_CONFIRMATIONS_REQUIRED) {
        expect(result.state.exploration).toMatchObject({
          status: 'replanning',
          reason: 'frontiers-unresolved',
          requireFreshMap: true,
        });
        expect(result.effects.at(-1)).toMatchObject({
          type: 'WAIT_FOR_EXPLORATION_MAP',
          requireFreshMap: true,
        });
      } else {
        expect(result.state.exploration).toMatchObject({ status: 'completed', confirmedMapGeneration: 25 });
        expect(result.effects).toContainEqual({ type: 'ZERO_VELOCITY' });
      }
      state = result.state;
    }
  });

  it('keeps evaluating when a transient robot clearance gap is reported', () => {
    let state = explorationStarted(26);
    const generation = state.exploration.generation;

    for (let attempt = 1; attempt <= EXPLORATION_NO_CANDIDATE_CONFIRMATIONS_REQUIRED + 1; attempt += 1) {
      const waiting = transitionAppState(state, {
        type: 'EXPLORATION_NO_CANDIDATES',
        generation,
        mapGeneration: 26,
        reason: 'robot-insufficient-clearance',
        exploredCoverageRatio: .95,
      });
      expect(waiting.accepted).toBe(true);
      expect(waiting.state.exploration).toMatchObject({
        status: 'replanning',
        reason: 'candidate-evidence-unavailable',
        noCandidateConfirmations: 0,
        requireFreshMap: false,
      });
      state = dispatch(waiting.state, { type: 'EXPLORATION_EVALUATION_REQUESTED', generation, mapGeneration: 26 });
    }

    expect(state.exploration).toMatchObject({ status: 'evaluating', noCandidateConfirmations: 0 });

    const recoveryBlocked = explorationStarted(27);
    const recoverableError = transitionAppState(recoveryBlocked, {
      type: 'EXPLORATION_NO_CANDIDATES',
      generation: recoveryBlocked.exploration.generation,
      mapGeneration: 27,
      reason: 'robot-insufficient-clearance',
      exploredCoverageRatio: .95,
      recoveryExhausted: true,
    });
    expect(recoverableError.state.exploration).toMatchObject({
      status: 'replanning',
      reason: 'candidate-evidence-unavailable',
      noCandidateConfirmations: 0,
      requireFreshMap: false,
    });
    expect(recoverableError.state.exploration.status).not.toBe('completed');
  });

  it('keeps exploring when candidate exhaustion occurs below the observed-area threshold', () => {
    let state = explorationStarted(24);
    const generation = state.exploration.generation;
    for (let attempt = 1; attempt <= EXPLORATION_NO_CANDIDATE_CONFIRMATIONS_REQUIRED + 1; attempt += 1) {
      const waiting = transitionAppState(state, {
        type: 'EXPLORATION_NO_CANDIDATES',
        generation,
        mapGeneration: 24,
        reason: 'no-frontiers',
        exploredCoverageRatio: .84,
      });
      expect(waiting.accepted).toBe(true);
      expect(waiting.state.exploration).toMatchObject({
        status: 'replanning',
        reason: 'coverage-insufficient',
        noCandidateConfirmations: 0,
        requireFreshMap: false,
        replanCount: attempt,
      });
      expect(waiting.effects).toContainEqual({
        type: 'SET_NAVIGATION_STATUS',
        message: '探索継続 / 観測済み領域84%（完了基準90%）',
      });
      state = dispatch(waiting.state, { type: 'EXPLORATION_EVALUATION_REQUESTED', generation, mapGeneration: 24 });
    }
    expect(state.exploration).toMatchObject({ status: 'evaluating', noCandidateConfirmations: 0 });

    expect(transitionAppState(state, {
      type: 'EXPLORATION_NO_CANDIDATES',
      generation,
      mapGeneration: 24,
      reason: 'no-frontiers',
      exploredCoverageRatio: Number.NaN,
    }).accepted).toBe(false);
  });

  it('does not complete below the coverage threshold while frontier cells remain without a currently eligible goal', () => {
    let state = explorationStarted(25);
    const generation = state.exploration.generation;
    for (let attempt = 1; attempt <= EXPLORATION_NO_CANDIDATE_CONFIRMATIONS_REQUIRED + 1; attempt += 1) {
      const waiting = transitionAppState(state, {
        type: 'EXPLORATION_NO_CANDIDATES',
        generation,
        mapGeneration: 25,
        reason: 'no-eligible-candidates',
        exploredCoverageRatio: .67,
      });
      expect(waiting.accepted).toBe(true);
      expect(waiting.state.exploration).toMatchObject({
        status: 'replanning',
        reason: 'frontiers-unresolved',
        noCandidateConfirmations: 0,
        requireFreshMap: false,
        replanCount: attempt,
      });
      expect(waiting.effects).toContainEqual({
        type: 'SET_NAVIGATION_STATUS',
        message: 'frontier残存 / 安全なgoalまたは退避後のposeを再評価',
      });
      state = dispatch(waiting.state, { type: 'EXPLORATION_EVALUATION_REQUESTED', generation, mapGeneration: 25 });
    }
    expect(state.exploration).toMatchObject({ status: 'evaluating', noCandidateConfirmations: 0 });
  });

  it('enters a recoverable error instead of looping or completing when normal and safe corner recovery are exhausted', () => {
    const state = explorationStarted(27);
    const failed = transitionAppState(state, {
      type: 'EXPLORATION_NO_CANDIDATES',
      generation: state.exploration.generation,
      mapGeneration: 27,
      reason: 'no-eligible-candidates',
      exploredCoverageRatio: .8,
      recoveryExhausted: true,
    });

    expect(failed.accepted).toBe(true);
    expect(failed.state.exploration).toMatchObject({
      status: 'error',
      recoverable: true,
      noCandidateConfirmations: 0,
    });
    expect(failed.state.exploration.status).not.toBe('completed');
    expect(failed.effects.map((effect) => effect.type)).toEqual([
      'RELEASE_USER_INPUT',
      'CANCEL_NAVIGATION_GOAL',
      'SET_COMMAND_OWNER',
      'ZERO_VELOCITY',
      'CLEAR_GOAL_DATA',
      'SET_NAVIGATION_STATUS',
      'ANNOUNCE',
    ]);
    expect(canResumeExploration(failed.state, freshness(27))).toBe(false);
    const sameMapResume = transitionAppState(failed.state, {
      type: 'EXPLORATION_RESUME_REQUESTED',
      mapGeneration: 27,
      requestedAtMs: NOW_MS,
    });
    expect(sameMapResume.accepted).toBe(false);
    expect(sameMapResume.rejection).toContain('探索エラー後のfresh live map');

    const freshEvidence = observeExplorationMap(failed.state, 28);
    expect(canResumeExploration(freshEvidence, freshness(28))).toBe(true);
    expect(transitionAppState(freshEvidence, {
      type: 'EXPLORATION_RESUME_REQUESTED',
      mapGeneration: 28,
      requestedAtMs: NOW_MS,
    }).accepted).toBe(true);
  });

  it('releases manual input on window blur without canceling an active exploration goal', () => {
    let state = requestExplorationGoal(explorationStarted(26), 'frontier-focus', 26);
    state = dispatch(state, { type: 'NAVIGATION_GOAL_FEEDBACK', taskId: state.navigation.taskId });

    const blurred = transitionAppState(state, { type: 'WINDOW_FOCUS_LOST' });

    expect(blurred.accepted).toBe(true);
    expect(blurred.state).toEqual(state);
    expect(blurred.state.navigation).toMatchObject({ status: 'moving', source: 'exploration' });
    expect(blurred.state.exploration).toMatchObject({ status: 'moving' });
    expect(blurred.state.command).toEqual({ owner: 'navigation' });
    expect(blurred.effects).toEqual([{ type: 'RELEASE_USER_INPUT' }, { type: 'ZERO_VELOCITY' }]);
  });

  it('retries transient pose and blacklist-only candidate gaps without counting completion confirmations', () => {
    const reasons = ['robot-out-of-bounds', 'robot-not-free', 'robot-insufficient-clearance', 'blacklist-cooldown'] as const;
    for (const reason of reasons) {
      let state = explorationStarted(22);
      const generation = state.exploration.generation;
      for (let attempt = 1; attempt <= EXPLORATION_NO_CANDIDATE_CONFIRMATIONS_REQUIRED + 1; attempt += 1) {
        const waiting = transitionAppState(state, {
          type: 'EXPLORATION_NO_CANDIDATES',
          generation,
          mapGeneration: 22,
          reason,
          exploredCoverageRatio: .7,
        });
        expect(waiting.accepted).toBe(true);
        expect(waiting.state.exploration).toMatchObject({
          status: 'replanning',
          reason: reason === 'blacklist-cooldown' ? 'candidate-cooldown' : 'candidate-evidence-unavailable',
          noCandidateConfirmations: 0,
          requireFreshMap: false,
          replanCount: attempt,
        });
        expect(waiting.effects.at(-1)).toMatchObject({ type: 'WAIT_FOR_EXPLORATION_MAP', requireFreshMap: false });
        state = dispatch(waiting.state, { type: 'EXPLORATION_EVALUATION_REQUESTED', generation, mapGeneration: 22 });
      }
      expect(state.exploration).toMatchObject({ status: 'evaluating', noCandidateConfirmations: 0 });
    }
  });

  it('blacklists failed candidates, replans deterministically, and enters a recoverable error at the retry limit', () => {
    let state = explorationStarted(30);
    const generation = state.exploration.generation;
    let mapGeneration = 30;

    for (let attempt = 1; attempt <= MAX_EXPLORATION_RETRIES; attempt += 1) {
      state = requestExplorationGoal(state, `frontier-${attempt}`, mapGeneration);
      const taskId = state.navigation.taskId;
      const failed = transitionAppState(state, {
        type: 'NAVIGATION_GOAL_FAILED',
        taskId,
        error: attempt === 1 ? 'goal rejected' : 'path failed',
        canceled: false,
      });
      expect(failed.accepted).toBe(true);
      state = failed.state;
      if (attempt < MAX_EXPLORATION_RETRIES) {
        expect(state.exploration).toMatchObject({
          status: 'replanning',
          reason: 'goal-failed',
          retryCount: attempt,
          replanCount: attempt,
          requireFreshMap: true,
        });
        expect(state.navigation).toMatchObject({ source: 'exploration' });
        mapGeneration += 1;
        state = observeExplorationMap(state, mapGeneration);
        state = dispatch(state, { type: 'EXPLORATION_EVALUATION_REQUESTED', generation, mapGeneration });
      } else {
        expect(failed.effects.map((effect) => effect.type)).toEqual([
          'CANCEL_NAVIGATION_GOAL',
          'SET_COMMAND_OWNER',
          'ZERO_VELOCITY',
          'CLEAR_GOAL_DATA',
          'SET_NAVIGATION_STATUS',
          'ANNOUNCE',
        ]);
      }
    }

    expect(state.exploration).toMatchObject({
      status: 'error',
      recoverable: true,
      retryCount: MAX_EXPLORATION_RETRIES,
      replanCount: MAX_EXPLORATION_RETRIES - 1,
    });
    expect(state.exploration.status).not.toBe('completed');
    if (state.exploration.status !== 'idle') {
      expect(state.exploration.blacklistedCandidateIds).toHaveLength(MAX_EXPLORATION_RETRIES);
      expect(state.exploration.blacklistedCandidateIds).toContain('frontier-1');
      expect(state.exploration.blacklistedCandidateIds).toContain(`frontier-${MAX_EXPLORATION_RETRIES}`);
    }
    expect(state.command).toEqual({ owner: 'manual' });
    expect(canStartExploration(state, freshness(mapGeneration))).toBe(false);
    expect(canResumeExploration(state, freshness(mapGeneration))).toBe(false);

    mapGeneration += 1;
    state = observeExplorationMap(state, mapGeneration);
    expect(canResumeExploration(state, freshness(mapGeneration))).toBe(true);
    state = dispatch(state, { type: 'EXPLORATION_RESUME_REQUESTED', mapGeneration, requestedAtMs: NOW_MS });
    expect(state.exploration).toMatchObject({
      status: 'evaluating',
      retryCount: 0,
      noCandidateConfirmations: 0,
      blacklistedCandidateIds: expect.arrayContaining(['frontier-1', `frontier-${MAX_EXPLORATION_RETRIES}`]),
    });
  });

  it('never completes at 80 percent after a Nav2 goal failure and uses the existing cancel, owner, and zero-velocity effects', () => {
    let state = requestExplorationGoal(explorationStarted(31), 'frontier-blocked', 31);
    const failed = transitionAppState(state, {
      type: 'NAVIGATION_GOAL_FAILED',
      taskId: state.navigation.taskId,
      error: 'Failed to make progress',
      canceled: false,
    });

    expect(failed.accepted).toBe(true);
    expect(failed.state.exploration).toMatchObject({ status: 'replanning', reason: 'goal-failed' });
    expect(failed.state.exploration.status).not.toBe('completed');
    expect(failed.effects.map((effect) => effect.type)).toEqual([
      'CANCEL_NAVIGATION_GOAL',
      'SET_COMMAND_OWNER',
      'ZERO_VELOCITY',
      'CLEAR_GOAL_DATA',
      'SET_NAVIGATION_STATUS',
      'WAIT_FOR_EXPLORATION_MAP',
    ]);
    expect(failed.effects.at(-1)).toMatchObject({
      type: 'WAIT_FOR_EXPLORATION_MAP',
      requireFreshMap: true,
    });

    state = failed.state;
    expect(state.command).toEqual({ owner: 'manual' });
  });

  it('waits for a stale navigation transform without consuming the retry limit or blacklisting the candidate', () => {
    const state = requestExplorationGoal(explorationStarted(32), 'frontier-tf-wait', 32);
    const failed = transitionAppState(state, {
      type: 'NAVIGATION_GOAL_FAILED',
      taskId: state.navigation.taskId,
      error: 'SLAMのmap→odom TFが遅れています',
      canceled: false,
      transient: 'stale-transform',
    });

    expect(failed.accepted).toBe(true);
    expect(failed.state.exploration).toMatchObject({
      status: 'replanning',
      reason: 'navigation-transform-stale',
      retryCount: 0,
      replanCount: 1,
      blacklistedCandidateIds: [],
      requireFreshMap: true,
    });
    expect(failed.state.command).toEqual({ owner: 'manual' });
    expect(failed.effects.map((effect) => effect.type)).toEqual([
      'CANCEL_NAVIGATION_GOAL',
      'SET_COMMAND_OWNER',
      'ZERO_VELOCITY',
      'CLEAR_GOAL_DATA',
      'SET_NAVIGATION_STATUS',
      'WAIT_FOR_EXPLORATION_MAP',
    ]);
    expect(failed.effects.at(-1)).toMatchObject({ type: 'WAIT_FOR_EXPLORATION_MAP', requireFreshMap: true });
  });

  it('holds an Object Search goal failure while the live map is changing without consuming retries', () => {
    let state = explorationStarted(32);
    state.objectSearch = {
      status: 'searching',
      generation: 1,
      explorationGeneration: state.exploration.generation,
    } as AppState['objectSearch'];
    if (state.exploration.status === 'evaluating') {
      state.exploration = { ...state.exploration, goalPolicy: 'object-search' };
    }
    state = requestExplorationGoal(state, 'frontier-map-recovery', 32);
    const failed = transitionAppState(state, {
      type: 'NAVIGATION_GOAL_FAILED',
      taskId: state.navigation.taskId,
      error: 'SLAM mapまたはcostmapが安定していません',
      canceled: false,
      transient: 'navigation-recovery',
    });

    expect(failed.accepted).toBe(true);
    expect(failed.state.exploration).toMatchObject({
      status: 'replanning',
      reason: 'navigation-recovery',
      goalPolicy: 'object-search',
      retryCount: 0,
      blacklistedCandidateIds: [],
      requireFreshMap: true,
    });
    expect(failed.effects.at(-1)).toMatchObject({
      type: 'WAIT_FOR_EXPLORATION_MAP',
      requireFreshMap: true,
      afterMapGeneration: 32,
    });
  });

  it('resets the automatic retry window after a successful exploration goal', () => {
    let state = requestExplorationGoal(explorationStarted(32), 'frontier-failed-first', 32);
    state = dispatch(state, {
      type: 'NAVIGATION_GOAL_FAILED',
      taskId: state.navigation.taskId,
      error: 'blocked',
      canceled: false,
    });
    state = observeExplorationMap(state, 33);
    state = dispatch(state, { type: 'EXPLORATION_EVALUATION_REQUESTED', generation: state.exploration.generation, mapGeneration: 33 });
    state = requestExplorationGoal(state, 'frontier-recovered', 33);
    state = dispatch(state, { type: 'NAVIGATION_GOAL_SUCCEEDED', taskId: state.navigation.taskId });

    expect(state.exploration).toMatchObject({
      status: 'replanning',
      reason: 'goal-succeeded',
      retryCount: 0,
    });
  });

  it('keeps exact failed candidate IDs blocked across fresh maps until the run is explicitly ended', () => {
    let state = requestExplorationGoal(explorationStarted(35), 'frontier-growth', 35);
    state = dispatch(state, { type: 'NAVIGATION_GOAL_FAILED', taskId: state.navigation.taskId, error: 'blocked', canceled: false });
    expect(state.exploration).toMatchObject({
      status: 'replanning',
      lastMapGeneration: 35,
      blacklistedCandidateIds: ['frontier-growth'],
    });

    const sameMap = transitionAppState(state, {
      type: 'EXPLORATION_EVALUATION_REQUESTED',
      generation: state.exploration.generation,
      mapGeneration: 35,
    });
    expect(sameMap.accepted).toBe(false);

    state = observeExplorationMap(state, 36);
    const newerMap = transitionAppState(state, {
      type: 'EXPLORATION_EVALUATION_REQUESTED',
      generation: state.exploration.generation,
      mapGeneration: 36,
    });
    expect(newerMap.accepted).toBe(true);
    expect(newerMap.state.exploration).toMatchObject({ status: 'evaluating', mapGeneration: 36, blacklistedCandidateIds: ['frontier-growth'] });
    expect(newerMap.effects.at(-1)).toMatchObject({ type: 'EVALUATE_EXPLORATION_MAP', blacklistedCandidateIds: ['frontier-growth'] });
    expect(transitionAppState(newerMap.state, {
      type: 'EXPLORATION_GOAL_REQUESTED',
      generation: newerMap.state.exploration.generation,
      mapGeneration: 36,
      candidateId: 'frontier-growth',
      goal: testGoal(),
      requestedAtMs: NOW_MS,
    }).accepted).toBe(false);

    state = dispatch(newerMap.state, { type: 'EXPLORATION_STOP_REQUESTED' });
    state = dispatch(state, { type: 'EXPLORATION_START_REQUESTED', mapGeneration: 36, requestedAtMs: NOW_MS });
    expect(state.exploration).toMatchObject({ status: 'evaluating', blacklistedCandidateIds: [] });
  });

  it('pauses on manual override, resumes from the current fresh map without directly resending the old goal, and stops safely', () => {
    let state = requestExplorationGoal(explorationStarted(40), 'frontier-manual', 40);
    const oldTaskId = state.navigation.taskId;
    const operatorConflict = transitionAppState(state, { type: 'NAVIGATION_GOAL_REQUESTED', goal: testGoal(), requestedAtMs: NOW_MS });
    expect(operatorConflict.accepted).toBe(false);
    expect(operatorConflict.rejection).toContain('一時停止');

    state = observeExplorationMap(state, 43);
    const manual = transitionAppState(state, { type: 'COMMAND_OWNER_REQUESTED', owner: 'manual', requestedAtMs: NOW_MS });
    expect(manual.accepted).toBe(true);
    state = manual.state;
    expect(state.exploration).toMatchObject({ status: 'paused', reason: 'manual-override', resumeAfterMapGeneration: 43, lastMapGeneration: 43 });
    expect(state.navigation.status).toBe('canceled');
    expect(manual.effects.map((effect) => effect.type)).toEqual(expect.arrayContaining([
      'CANCEL_NAVIGATION_GOAL',
      'SET_COMMAND_OWNER',
      'ZERO_VELOCITY',
    ]));
    expect(canPauseExploration(state)).toBe(false);
    expect(canResumeExploration(state, freshness(43))).toBe(true);
    expect(transitionAppState(state, { type: 'NAVIGATION_GOAL_SUCCEEDED', taskId: oldTaskId }).accepted).toBe(false);

    const resumed = transitionAppState(state, { type: 'EXPLORATION_RESUME_REQUESTED', mapGeneration: 43, requestedAtMs: NOW_MS });
    expect(resumed.accepted).toBe(true);
    state = resumed.state;
    expect(state.exploration).toMatchObject({ status: 'evaluating', generation: 2, mapGeneration: 43 });
    expect(state.navigation.status).toBe('idle');
    expect(resumed.effects.map((effect) => effect.type)).not.toContain('SEND_NAVIGATION_GOAL');

    const stopped = transitionAppState(state, { type: 'EXPLORATION_STOP_REQUESTED' });
    expect(stopped.accepted).toBe(true);
    expect(stopped.state.exploration).toEqual({ status: 'idle', generation: 3 });
    expect(stopped.effects.map((effect) => effect.type)).toEqual(expect.arrayContaining([
      'CANCEL_NAVIGATION_GOAL',
      'SET_COMMAND_OWNER',
      'ZERO_VELOCITY',
      'CLEAR_EXPLORATION_DATA',
    ]));
  });

  it('keeps an active Nav2 task under the limiter without starting a separate recovery effect', () => {
    const idleStopped = transitionAppState(explorationReadyState(), { type: 'SAFETY_CHANGED', stopped: true }).state;
    expect(canStartExploration(idleStopped, freshness(1))).toBe(false);
    expect(canAcceptManualMotion(idleStopped)).toBe(true);
    expect(transitionAppState(idleStopped, { type: 'EXPLORATION_START_REQUESTED', mapGeneration: 45, requestedAtMs: NOW_MS }).accepted).toBe(false);

    let state = requestExplorationGoal(explorationStarted(45), 'frontier-safety', 45);
    const taskId = state.navigation.taskId;
    state = dispatch(state, { type: 'NAVIGATION_GOAL_FEEDBACK', taskId });
    const stopped = transitionAppState(state, { type: 'SAFETY_CHANGED', stopped: true, status: 'Safety stop / 速度0' });
    expect(stopped.accepted).toBe(true);
    state = stopped.state;
    expect(state.safety).toEqual({ stopped: true });
    expect(state.exploration).toMatchObject({ status: 'moving', taskId });
    expect(state.navigation).toMatchObject({ status: 'moving', taskId });
    expect(state.command).toEqual({ owner: 'navigation' });
    expect(canAcceptManualMotion(state)).toBe(false);
    expect(canEnableNavigationControl(state)).toBe(false);
    expect(canResumeExploration(state, freshness(45))).toBe(false);
    expect(stopped.effects.map((effect) => effect.type)).toEqual(['SET_NAVIGATION_STATUS']);
    expect(transitionAppState(state, { type: 'COMMAND_OWNER_REQUESTED', owner: 'navigation', requestedAtMs: NOW_MS }).accepted).toBe(false);
    expect(transitionAppState(state, { type: 'NAVIGATION_GOAL_REQUESTED', goal: testGoal(), requestedAtMs: NOW_MS }).accepted).toBe(false);
    expect(transitionAppState(state, { type: 'EXPLORATION_RESUME_REQUESTED', mapGeneration: 46, requestedAtMs: NOW_MS }).accepted).toBe(false);
    const ownerObserved = transitionAppState(state, { type: 'COMMAND_OWNER_OBSERVED', owner: 'navigation', observedAtMs: NOW_MS });
    expect(ownerObserved.accepted).toBe(true);
    expect(ownerObserved.state.command).toEqual({ owner: 'navigation' });

    const cleared = transitionAppState(state, { type: 'SAFETY_CHANGED', stopped: false });
    expect(cleared.accepted).toBe(true);
    expect(cleared.effects.map((effect) => effect.type)).toEqual(['SET_NAVIGATION_STATUS']);
    expect(cleared.state.safety).toEqual({ stopped: false });
    expect(cleared.state.exploration).toMatchObject({ status: 'moving', taskId });
    expect(cleared.state.command).toEqual({ owner: 'navigation' });
    expect(canAcceptManualMotion(cleared.state)).toBe(false);
    expect(canResumeExploration(cleared.state, freshness(45))).toBe(false);
  });

  it('keeps an operator Nav2 goal and command ownership during a transient limiter stop', () => {
    let state = navigationReadyState();
    state = dispatch(state, { type: 'NAVIGATION_GOAL_REQUESTED', goal: testGoal(), requestedAtMs: NOW_MS });
    const taskId = state.navigation.taskId;
    state = dispatch(state, { type: 'NAVIGATION_GOAL_FEEDBACK', taskId });

    const limited = transitionAppState(state, { type: 'SAFETY_CHANGED', stopped: true });
    expect(limited.accepted).toBe(true);
    expect(limited.state.navigation).toMatchObject({ status: 'moving', source: 'operator', taskId });
    expect(limited.state.command).toEqual({ owner: 'navigation' });
    expect(limited.effects.map((effect) => effect.type)).toEqual(['SET_NAVIGATION_STATUS']);

    const emergency = transitionAppState(limited.state, { type: 'SAFE_STOP_REQUESTED', status: '緊急停止' });
    expect(emergency.state.navigation).toMatchObject({ status: 'canceled', source: 'operator', taskId });
    expect(emergency.state.command).toEqual({ owner: 'manual' });
    expect(emergency.effects.map((effect) => effect.type)).toEqual(expect.arrayContaining([
      'CANCEL_NAVIGATION_GOAL',
      'SET_COMMAND_OWNER',
      'ZERO_VELOCITY',
    ]));
  });

  it('invalidates only the current exploration readiness cycle when Nav2 becomes unavailable', () => {
    let state = requestExplorationGoal(explorationStarted(48), 'frontier-health', 48);
    state = dispatch(state, { type: 'NAVIGATION_GOAL_FEEDBACK', taskId: state.navigation.taskId });
    const cycle = state.map.cycle;
    const taskId = state.navigation.taskId;

    const stale = transitionAppState(state, { type: 'NAVIGATION_UNAVAILABLE', cycle: cycle - 1, status: 'old graph snapshot' });
    expect(stale.accepted).toBe(false);
    expect(stale.state).toBe(state);

    const unavailable = transitionAppState(state, { type: 'NAVIGATION_UNAVAILABLE', cycle, status: 'ROS構成Node停止 / 速度0' });
    expect(unavailable.accepted).toBe(true);
    state = unavailable.state;
    const recoveryCycle = state.map.cycle;
    expect(recoveryCycle).toBe(cycle + 1);
    expect(state.map).toMatchObject({
      status: 'initializing',
      target: 'exploration',
      reason: 'navigation-health',
      mapReceived: false,
      poseReceived: false,
      navigationReceived: false,
      cycle: recoveryCycle,
    });
    expect(state.navigation).toMatchObject({ status: 'canceled', taskId });
    expect(state.exploration).toMatchObject({ status: 'paused', reason: 'navigation-unavailable' });
    expect(state.command).toEqual({ owner: 'stopped', reason: 'map-initialization' });
    expect(isInteractionLocked(state)).toBe(false);
    expect(canAcceptManualMotion(state)).toBe(false);
    expect(transitionAppState(state, { type: 'COMMAND_OWNER_REQUESTED', owner: 'manual', requestedAtMs: NOW_MS }).accepted).toBe(false);
    expect(unavailable.effects.map((effect) => effect.type)).toEqual([
      'RELEASE_USER_INPUT',
      'CANCEL_NAVIGATION_GOAL',
      'SET_COMMAND_OWNER',
      'ZERO_VELOCITY',
      'CLEAR_GOAL_DATA',
      'SET_NAVIGATION_STATUS',
    ]);
    expect(transitionAppState(state, { type: 'EXPLORATION_RESUME_REQUESTED', mapGeneration: 49, requestedAtMs: NOW_MS }).accepted).toBe(false);
    expect(transitionAppState(state, { type: 'NAVIGATION_READY', cycle }).accepted).toBe(false);

    state = dispatch(state, { type: 'NAVIGATION_READY', cycle: recoveryCycle });
    expect(state.map).toMatchObject({ status: 'initializing', navigationReceived: true, cycle: recoveryCycle });
    state = receiveMap(state);
    const recovered = transitionAppState(state, { type: 'POSE_READY', cycle: state.map.cycle });
    expect(recovered.accepted).toBe(true);
    expect(recovered.state.map).toMatchObject({ status: 'ready', mode: 'exploration', cycle: recoveryCycle });
    expect(recovered.state.exploration).toMatchObject({ status: 'paused', reason: 'navigation-unavailable' });
    expect(recovered.state.navigation).toMatchObject({ status: 'canceled', taskId });
  });

  it('pauses exploration for Safety stop, STAGE, Transport loss, and runtime changes without auto-resume', () => {
    const safety = transitionAppState(explorationStarted(50), { type: 'SAFE_STOP_REQUESTED', status: 'Safety stop' });
    expect(safety.state.exploration).toMatchObject({ status: 'paused', reason: 'safety-stop' });
    expect(safety.effects.map((effect) => effect.type)).toContain('ZERO_VELOCITY');

    const stage = transitionAppState(explorationStarted(50), { type: 'VIEW_REQUESTED', view: 'stage' });
    expect(stage.state.exploration).toMatchObject({ status: 'paused', reason: 'stage' });
    expect(stage.effects.map((effect) => effect.type)).toContain('ENTER_STAGE');

    const disconnected = transitionAppState(explorationStarted(50), { type: 'TRANSPORT_CHANGED', connection: 'RECONNECTING' });
    expect(disconnected.state.exploration).toMatchObject({ status: 'paused', reason: 'transport' });
    expect(disconnected.state.map).toMatchObject({ status: 'initializing', target: 'exploration', reason: 'reconnect' });
    let reconnected = dispatch(disconnected.state, { type: 'TRANSPORT_CHANGED', connection: 'CONNECTED' });
    reconnected = receiveMap(reconnected);
    reconnected = receivePose(reconnected);
    reconnected = dispatch(reconnected, { type: 'NAVIGATION_READY', cycle: reconnected.map.cycle });
    expect(reconnected.exploration.status).toBe('paused');

    let switching = explorationStarted(50);
    switching = dispatch(switching, { type: 'RUNTIME_SWITCH_REQUESTED', target: 'navigation' });
    expect(switching.exploration).toMatchObject({ status: 'paused', reason: 'runtime-change' });
    switching = dispatch(switching, { type: 'RUNTIME_MANAGER_OBSERVED', snapshot: runtimeSnapshot('navigation') });
    expect(switching.exploration.status).toBe('paused');
    expect(canResumeExploration(switching, freshness(50))).toBe(false);
  });

  it('stops exploration and invalidates stale map work when the live map is reset', () => {
    let state = requestExplorationGoal(explorationStarted(60), 'frontier-failed', 60);
    state = dispatch(state, { type: 'NAVIGATION_GOAL_FAILED', taskId: state.navigation.taskId, error: 'blocked', canceled: false });
    state = observeExplorationMap(state, 61);
    state = dispatch(state, {
      type: 'EXPLORATION_EVALUATION_REQUESTED',
      generation: state.exploration.generation,
      mapGeneration: 61,
    });
    state = requestExplorationGoal(state, 'frontier-reset', 61);
    if (state.exploration.status !== 'idle') expect(state.exploration.blacklistedCandidateIds).toEqual(['frontier-failed']);
    const staleGeneration = state.exploration.generation;
    const staleTaskId = state.navigation.taskId;
    const reset = transitionAppState(state, { type: 'MAP_RESET_REQUESTED' });
    expect(reset.accepted).toBe(true);
    state = reset.state;
    expect(state.runtime).toEqual({ status: 'stable', mode: 'exploration' });
    expect(state.map).toMatchObject({ status: 'resetting', phase: 'requesting-reset' });
    expect(state.exploration).toEqual({ status: 'idle', generation: staleGeneration + 1 });
    expect(state.navigation.status).toBe('canceled');
    expect(reset.effects.map((effect) => effect.type)).toEqual(expect.arrayContaining([
      'CANCEL_NAVIGATION_GOAL',
      'ZERO_VELOCITY',
      'CLEAR_EXPLORATION_DATA',
      'REQUEST_MAP_RESET',
    ]));
    expect(transitionAppState(state, {
      type: 'EXPLORATION_GOAL_REQUESTED',
      generation: staleGeneration,
      mapGeneration: 60,
      candidateId: 'stale',
      goal: testGoal(),
      requestedAtMs: NOW_MS,
    }).accepted).toBe(false);
    expect(transitionAppState(state, { type: 'NAVIGATION_GOAL_SUCCEEDED', taskId: staleTaskId }).accepted).toBe(false);

    const completed = transitionAppState(state, { type: 'MAP_RESET_COMPLETED', success: true });
    expect(completed.effects.at(0)).toEqual({ type: 'CLEAR_RUNTIME_DATA' });
    state = completed.state;
    expect(state.map).toMatchObject({
      status: 'initializing',
      target: 'exploration',
      reason: 'map-reset',
      mapReceived: false,
      poseReceived: false,
      navigationReceived: false,
    });
    state = receiveMap(state);
    state = receivePose(state);
    expect(state.map.status).toBe('initializing');
    state = dispatch(state, { type: 'NAVIGATION_READY', cycle: state.map.cycle });
    expect(state.map).toMatchObject({ status: 'ready', mode: 'exploration' });
    expect(state.exploration.status).toBe('idle');
  });

  it('moves evaluator failures to the typed error state and ignores stale generations', () => {
    let state = explorationStarted(70);
    const generation = state.exploration.generation;
    const stale = transitionAppState(state, { type: 'EXPLORATION_ERROR_REPORTED', generation: generation - 1, error: 'old worker error' });
    expect(stale.accepted).toBe(false);

    const failed = transitionAppState(state, { type: 'EXPLORATION_ERROR_REPORTED', generation, error: 'OccupancyGridを評価できませんでした。' });
    expect(failed.accepted).toBe(true);
    state = failed.state;
    expect(state.exploration).toMatchObject({
      status: 'error',
      recoverable: true,
      message: 'OccupancyGridを評価できませんでした。',
    });
    expect(state.command).toEqual({ owner: 'manual' });
    expect(failed.effects.map((effect) => effect.type)).toContain('ZERO_VELOCITY');
    expect(canStartExploration(state, freshness(70))).toBe(false);
    expect(canResumeExploration(state, freshness(70))).toBe(false);
    state = observeExplorationMap(state, 71);
    expect(canResumeExploration(state, freshness(71))).toBe(true);
  });
});
