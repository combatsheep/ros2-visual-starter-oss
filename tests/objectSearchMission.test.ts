import { describe, expect, it } from 'vitest';
import {
  VISION_DETECTOR_FRESHNESS_MS,
  createInitialAppState,
  transitionAppState,
  type AppEvent,
  type AppState,
  type RuntimeManagerState,
} from '../src/appState';
import { makePose } from '../src/navigationMap';
import type { AppleDetectionInput } from '../src/objectSearchDetection';
import type { PoseStampedMessage, RuntimeMode } from '../src/types';

const NOW_MS = 100_000;

function dispatch(state: AppState, event: AppEvent): AppState {
  const result = transitionAppState(state, event);
  expect(result.accepted, result.rejection).toBe(true);
  return result.state;
}

function runtimeSnapshot(mode: RuntimeMode, overrides: Partial<RuntimeManagerState> = {}): RuntimeManagerState {
  return { mode, target: mode, processing: false, phase: '', error: '', backendAlive: mode !== 'sim', ...overrides };
}

function observeExplorationReadiness(state: AppState, mapGeneration = 1, observedAtMs = NOW_MS): AppState {
  state = dispatch(state, { type: 'MAP_RECEIVED', cycle: state.map.cycle });
  state = dispatch(state, { type: 'EXPLORATION_MAP_OBSERVED', cycle: state.map.cycle, mapGeneration, observedAtMs });
  state = dispatch(state, { type: 'POSE_READY', cycle: state.map.cycle });
  state = dispatch(state, { type: 'EXPLORATION_POSE_OBSERVED', cycle: state.map.cycle, observedAtMs });
  return dispatch(state, { type: 'NAVIGATION_READY', cycle: state.map.cycle });
}

function explorationReadyState(mapGeneration = 1): AppState {
  let state = createInitialAppState();
  state = dispatch(state, { type: 'RUNTIME_SWITCH_REQUESTED', target: 'exploration' });
  state = dispatch(state, { type: 'RUNTIME_MANAGER_OBSERVED', snapshot: runtimeSnapshot('exploration') });
  state = dispatch(state, { type: 'TRANSPORT_CHANGED', connection: 'CONNECTED' });
  return observeExplorationReadiness(state, mapGeneration);
}

function observeVisionReady(state: AppState, observedAtMs = NOW_MS): AppState {
  const cycle = state.vision.cycle;
  state = dispatch(state, { type: 'VISION_STATUS_OBSERVED', cycle, status: 'ready', observedAtMs });
  state = dispatch(state, { type: 'VISION_FRAME_OBSERVED', cycle, observedAtMs });
  return dispatch(state, {
    type: 'VISION_DETECTOR_OBSERVED',
    cycle,
    observedAtMs,
    frameObservedAtMs: observedAtMs,
  });
}

function requestAppleSearch(state: AppState, requestedAtMs = NOW_MS): AppState {
  return dispatch(state, {
    type: 'OBJECT_SEARCH_COMMAND_REQUESTED',
    targetClass: 'apple',
    displayName: 'りんご',
    normalizedCommand: 'りんごを探して',
    requestedAtMs,
  });
}

function advanceAppleSearch(state: AppState, requestedAtMs = NOW_MS): ReturnType<typeof transitionAppState> {
  return transitionAppState(state, {
    type: 'OBJECT_SEARCH_ADVANCE_REQUESTED',
    generation: state.objectSearch.generation,
    visionCycle: state.vision.cycle,
    mapCycle: state.map.cycle,
    mapGeneration: state.explorationEvidence.mapGeneration,
    explorationGeneration: state.exploration.generation,
    requestedAtMs,
  });
}

function startAppleSearch(state = explorationReadyState()): AppState {
  state = requestAppleSearch(state);
  state = observeVisionReady(state);
  const started = advanceAppleSearch(state);
  expect(started.accepted, started.rejection).toBe(true);
  expect(started.state.objectSearch.status).toBe('searching');
  return started.state;
}

function completeObjectSearchExploration(state: AppState): AppState {
  for (let mapGeneration = 1; mapGeneration <= 3; mapGeneration += 1) {
    if (mapGeneration > 1) {
      state = dispatch(state, {
        type: 'EXPLORATION_MAP_OBSERVED',
        cycle: state.map.cycle,
        mapGeneration,
        observedAtMs: NOW_MS + mapGeneration,
      });
      state = dispatch(state, {
        type: 'EXPLORATION_EVALUATION_REQUESTED',
        generation: state.exploration.generation,
        mapGeneration,
      });
    }
    state = dispatch(state, {
      type: 'EXPLORATION_NO_CANDIDATES',
      generation: state.exploration.generation,
      mapGeneration,
      reason: 'no-frontiers',
      exploredCoverageRatio: 0.95,
    });
  }
  return state;
}

function testGoal(): PoseStampedMessage {
  return { header: { frame_id: 'map', stamp: { sec: 1, nanosec: 0 } }, pose: makePose(1, 2) };
}

function requestExplorationGoal(state: AppState, candidateId = 'frontier-object-search'): AppState {
  if (state.exploration.status !== 'evaluating') throw new Error('exploration must be evaluating');
  return dispatch(state, {
    type: 'EXPLORATION_GOAL_REQUESTED',
    generation: state.exploration.generation,
    mapGeneration: state.exploration.mapGeneration,
    candidateId,
    goal: testGoal(),
    requestedAtMs: NOW_MS,
  });
}

function appleDetection(overrides: Partial<AppleDetectionInput> = {}): AppleDetectionInput {
  return {
    classId: 'apple',
    confidence: .82,
    bbox: { centerX: 160, centerY: 120, width: 64, height: 48 },
    distanceMeters: .9,
    index: 0,
    ...overrides,
  };
}

function observeAppleFrame(
  state: AppState,
  frameStampMs: number,
  detections: readonly AppleDetectionInput[],
): ReturnType<typeof transitionAppState> {
  return transitionAppState(state, {
    type: 'OBJECT_SEARCH_DETECTION_OBSERVED',
    generation: state.objectSearch.generation,
    visionCycle: state.vision.cycle,
    transportCycle: state.transportCycle,
    explorationGeneration: state.exploration.generation,
    frameStampMs,
    cameraFrameStampMs: frameStampMs,
    observedAtMs: frameStampMs + 10,
    imageWidth: 320,
    imageHeight: 240,
    detections,
  });
}

function advanceToAppleCandidate(detection: AppleDetectionInput = appleDetection()): AppState {
  let state = requestExplorationGoal(startAppleSearch());
  state = dispatch(state, { type: 'NAVIGATION_GOAL_FEEDBACK', taskId: state.navigation.taskId });
  const sequence = [[detection], [], [detection], [detection], [detection]];
  sequence.forEach((detections, index) => {
    const observed = observeAppleFrame(state, NOW_MS + 100 + index * 100, detections);
    expect(observed.accepted, observed.rejection).toBe(true);
    state = observed.state;
  });
  expect(state.objectSearch.status).toBe('candidate');
  return state;
}

function requestCandidateSafeStop(state: AppState): ReturnType<typeof transitionAppState> {
  if (state.objectSearch.status !== 'candidate') throw new Error('Object Search must have a candidate');
  return transitionAppState(state, {
    type: 'OBJECT_SEARCH_SAFE_STOP_REQUESTED',
    generation: state.objectSearch.generation,
    visionCycle: state.vision.cycle,
    transportCycle: state.transportCycle,
    explorationGeneration: state.exploration.generation,
    candidateFrameStampMs: state.objectSearch.candidate.frameStampMs,
    requestedAtMs: NOW_MS + 610,
  });
}

function observeMotion(
  state: AppState,
  observedAtMs: number,
  linearX = 0,
  angularZ = 0,
): ReturnType<typeof transitionAppState> {
  return transitionAppState(state, {
    type: 'ROBOT_MOTION_OBSERVED',
    generation: state.objectSearch.generation,
    transportCycle: state.transportCycle,
    observedAtMs,
    linearX,
    angularZ,
  });
}

function advanceToPostStopConfirmation(): AppState {
  const stopped = requestCandidateSafeStop(advanceToAppleCandidate());
  expect(stopped.accepted, stopped.rejection).toBe(true);
  let state = stopped.state;
  state = dispatch(state, { type: 'COMMAND_OWNER_OBSERVED', owner: 'manual', observedAtMs: NOW_MS + 620 });
  state = observeMotion(state, NOW_MS + 630).state;
  state = observeMotion(state, NOW_MS + 640).state;
  expect(state.objectSearch.status).toBe('confirming');
  return state;
}

describe('object search mission transitions', () => {
  it('prepares exploration through the existing runtime effect boundary and starts only after every fresh readiness guard passes', () => {
    const requested = transitionAppState(createInitialAppState(), {
      type: 'OBJECT_SEARCH_COMMAND_REQUESTED',
      targetClass: 'apple',
      displayName: 'りんご',
      normalizedCommand: 'りんごを探して',
      requestedAtMs: NOW_MS,
    });
    expect(requested.accepted).toBe(true);
    expect(requested.state.objectSearch).toMatchObject({ status: 'preparing', missionId: 1, targetClass: 'apple' });
    expect(requested.state.runtime).toMatchObject({ status: 'switching', target: 'exploration' });
    expect(requested.effects.map((effect) => effect.type)).toEqual([
      'RELEASE_USER_INPUT',
      'CANCEL_NAVIGATION_GOAL',
      'SET_COMMAND_OWNER',
      'ZERO_VELOCITY',
      'CLEAR_RUNTIME_DATA',
      'REQUEST_RUNTIME',
      'SYNC_OBJECT_SEARCH_CHAT',
    ]);

    let state = requested.state;
    expect(advanceAppleSearch(state).accepted).toBe(false);
    state = dispatch(state, { type: 'RUNTIME_MANAGER_OBSERVED', snapshot: runtimeSnapshot('exploration') });
    state = dispatch(state, { type: 'TRANSPORT_CHANGED', connection: 'CONNECTING' });
    expect(state.objectSearch.status).toBe('preparing');
    state = dispatch(state, { type: 'TRANSPORT_CHANGED', connection: 'CONNECTED' });
    state = observeExplorationReadiness(state);
    expect(advanceAppleSearch(state).accepted).toBe(false);
    state = observeVisionReady(state);

    const started = advanceAppleSearch(state);
    expect(started.accepted, started.rejection).toBe(true);
    expect(started.state.objectSearch).toMatchObject({
      status: 'searching',
      missionId: 1,
      explorationGeneration: 1,
      mapCycle: state.map.cycle,
      visionCycle: state.vision.cycle,
    });
    expect(started.state.exploration).toMatchObject({ status: 'evaluating', generation: 1, goalPolicy: 'object-search' });
    expect(started.effects.map((effect) => effect.type)).toEqual([
      'RELEASE_USER_INPUT',
      'CANCEL_NAVIGATION_GOAL',
      'SET_COMMAND_OWNER',
      'ZERO_VELOCITY',
      'CLEAR_GOAL_DATA',
      'CLEAR_EXPLORATION_DATA',
      'SET_NAVIGATION_STATUS',
      'EVALUATE_EXPLORATION_MAP',
      'SYNC_OBJECT_SEARCH_CHAT',
    ]);
  });

  it('keeps the mission preparing across the real SIM to exploration handoff sequence', () => {
    let state = requestAppleSearch(createInitialAppState());

    // A runtime poll that was already in flight may still report SIM before
    // the runtime POST becomes visible. The following processing,
    // transport, and lease changes all belong to this mission-owned handoff.
    const staleRuntime = transitionAppState(state, { type: 'RUNTIME_MANAGER_OBSERVED', snapshot: runtimeSnapshot('sim') });
    expect(staleRuntime.accepted).toBe(false);
    state = staleRuntime.state;
    expect(state.objectSearch).toMatchObject({ status: 'preparing', runtimePreparationPending: true });
    state = dispatch(state, {
      type: 'RUNTIME_MANAGER_OBSERVED',
      snapshot: runtimeSnapshot('sim', { target: 'exploration', processing: true, phase: 'processing' }),
    });
    state = dispatch(state, { type: 'TRANSPORT_CHANGED', connection: 'DISCONNECTED' });
    state = dispatch(state, { type: 'CONTROL_LEASE_CHANGED', owner: false, changedAtMs: NOW_MS + 1 });
    state = dispatch(state, { type: 'SAFETY_CHANGED', stopped: true });
    state = dispatch(state, { type: 'SAFETY_CHANGED', stopped: false });
    expect(state.objectSearch).toMatchObject({ status: 'preparing', runtimePreparationPending: true });

    state = dispatch(state, { type: 'RUNTIME_MANAGER_OBSERVED', snapshot: runtimeSnapshot('exploration') });
    state = dispatch(state, { type: 'TRANSPORT_CHANGED', connection: 'CONNECTING' });
    state = dispatch(state, { type: 'TRANSPORT_CHANGED', connection: 'CONNECTED' });
    state = dispatch(state, { type: 'CONTROL_LEASE_CHANGED', owner: true, changedAtMs: NOW_MS + 2 });
    expect(state.objectSearch).toMatchObject({ status: 'preparing', runtimePreparationPending: true });

    const generationAfterHandoff = state.objectSearch.generation;
    state = dispatch(state, { type: 'RUNTIME_MANAGER_OBSERVED', snapshot: runtimeSnapshot('exploration') });
    expect(state.objectSearch.generation).toBe(generationAfterHandoff);

    state = observeExplorationReadiness(state);
    state = observeVisionReady(state);
    const started = advanceAppleSearch(state);
    expect(started.accepted, started.rejection).toBe(true);
    expect(started.state.objectSearch).toMatchObject({ status: 'searching', runtimePreparationPending: false });
  });

  it('attaches to one current exploration run without restarting it or resending its goal', () => {
    let state = explorationReadyState();
    state = dispatch(state, { type: 'EXPLORATION_START_REQUESTED', mapGeneration: 1, requestedAtMs: NOW_MS });
    state = requestExplorationGoal(state);
    const explorationGeneration = state.exploration.generation;
    const taskId = state.navigation.taskId;
    state = requestAppleSearch(state);
    state = observeVisionReady(state);

    const attached = advanceAppleSearch(state);
    expect(attached.accepted, attached.rejection).toBe(true);
    expect(attached.state.objectSearch).toMatchObject({ status: 'searching', explorationGeneration });
    expect(attached.state.exploration).toMatchObject({ goalPolicy: 'object-search' });
    expect(attached.state.exploration.generation).toBe(explorationGeneration);
    expect(attached.state.navigation.taskId).toBe(taskId);
    expect(attached.effects.map((effect) => effect.type)).toEqual(['SYNC_OBJECT_SEARCH_CHAT']);
  });

  it('rejects duplicate commands and stale mission, Vision, map, and exploration callbacks', () => {
    let state = requestAppleSearch(explorationReadyState());
    const generation = state.objectSearch.generation;
    const visionCycle = state.vision.cycle;
    expect(transitionAppState(state, {
      type: 'OBJECT_SEARCH_COMMAND_REQUESTED',
      targetClass: 'apple',
      displayName: 'りんご',
      normalizedCommand: 'りんごを探して',
      requestedAtMs: NOW_MS,
    }).accepted).toBe(false);
    expect(transitionAppState(state, { type: 'VISION_FRAME_OBSERVED', cycle: visionCycle - 1, observedAtMs: NOW_MS }).accepted).toBe(false);
    state = observeVisionReady(state);
    expect(transitionAppState(state, {
      type: 'OBJECT_SEARCH_ADVANCE_REQUESTED',
      generation: generation - 1,
      visionCycle,
      mapCycle: state.map.cycle,
      mapGeneration: state.explorationEvidence.mapGeneration,
      explorationGeneration: state.exploration.generation,
      requestedAtMs: NOW_MS,
    }).accepted).toBe(false);
    expect(transitionAppState(state, {
      type: 'OBJECT_SEARCH_ADVANCE_REQUESTED',
      generation,
      visionCycle,
      mapCycle: state.map.cycle - 1,
      mapGeneration: state.explorationEvidence.mapGeneration,
      explorationGeneration: state.exploration.generation,
      requestedAtMs: NOW_MS,
    }).accepted).toBe(false);
    expect(transitionAppState(state, {
      type: 'OBJECT_SEARCH_ADVANCE_REQUESTED',
      generation,
      visionCycle,
      mapCycle: state.map.cycle,
      mapGeneration: state.explorationEvidence.mapGeneration,
      explorationGeneration: state.exploration.generation + 1,
      requestedAtMs: NOW_MS,
    }).accepted).toBe(false);
  });

  it('does not reuse Camera or Detection evidence captured before the mission request', () => {
    let state = requestAppleSearch(explorationReadyState());
    const cycle = state.vision.cycle;
    state = dispatch(state, { type: 'VISION_STATUS_OBSERVED', cycle, status: 'ready', observedAtMs: NOW_MS });
    state = dispatch(state, { type: 'VISION_FRAME_OBSERVED', cycle, observedAtMs: NOW_MS - 1 });
    state = dispatch(state, {
      type: 'VISION_DETECTOR_OBSERVED',
      cycle,
      observedAtMs: NOW_MS,
      frameObservedAtMs: NOW_MS - 1,
    });
    const stale = advanceAppleSearch(state);
    expect(stale.accepted).toBe(false);
    expect(stale.rejection).toContain('mission開始前');
    expect(stale.state.exploration.status).toBe('idle');
  });

  it('never starts exploration without the control lease and invalidates Vision on the initial acquisition', () => {
    let state = dispatch(createInitialAppState(), { type: 'CONTROL_LEASE_CHANGED', owner: false, changedAtMs: NOW_MS - 10 });
    state = requestAppleSearch(state);
    state = dispatch(state, { type: 'RUNTIME_MANAGER_OBSERVED', snapshot: runtimeSnapshot('exploration') });
    state = dispatch(state, { type: 'TRANSPORT_CHANGED', connection: 'CONNECTED' });
    state = observeExplorationReadiness(state);
    state = observeVisionReady(state);
    const blocked = advanceAppleSearch(state);
    expect(blocked.accepted).toBe(false);
    expect(blocked.rejection).toContain('操作権');
    expect(blocked.state.exploration.status).toBe('idle');

    const visionCycle = state.vision.cycle;
    state = dispatch(state, { type: 'CONTROL_LEASE_CHANGED', owner: true, changedAtMs: NOW_MS });
    expect(state.objectSearch.status).toBe('preparing');
    expect(state.vision.cycle).toBe(visionCycle + 1);
    expect(advanceAppleSearch(state).accepted).toBe(false);
    state = observeVisionReady(state);
    expect(advanceAppleSearch(state).accepted).toBe(true);
  });

  it('pauses an attached active goal on control lease loss in the established cancel, manual, zero order', () => {
    let state = requestExplorationGoal(startAppleSearch());
    state = dispatch(state, { type: 'NAVIGATION_GOAL_FEEDBACK', taskId: state.navigation.taskId });
    const generation = state.objectSearch.generation;
    const lost = transitionAppState(state, { type: 'CONTROL_LEASE_CHANGED', owner: false, changedAtMs: NOW_MS + 1 });
    expect(lost.accepted).toBe(true);
    expect(lost.state.objectSearch).toMatchObject({ status: 'paused', reason: 'control-lease', generation: generation + 1 });
    expect(lost.state.exploration).toMatchObject({ status: 'paused', reason: 'control-lease' });
    expect(lost.state.navigation.status).toBe('canceled');
    expect(lost.state.command).toEqual({ owner: 'manual' });
    expect(lost.effects.slice(0, 5).map((effect) => effect.type)).toEqual([
      'RELEASE_USER_INPUT',
      'CANCEL_NAVIGATION_GOAL',
      'SET_COMMAND_OWNER',
      'ZERO_VELOCITY',
      'CLEAR_GOAL_DATA',
    ]);
    expect(lost.effects.at(-1)?.type).toBe('SYNC_OBJECT_SEARCH_CHAT');

    const regained = transitionAppState(lost.state, { type: 'CONTROL_LEASE_CHANGED', owner: true, changedAtMs: NOW_MS + 2 });
    expect(regained.accepted).toBe(true);
    expect(regained.state.objectSearch).toMatchObject({ status: 'paused', reason: 'control-lease' });
    expect(regained.effects.some((effect) => effect.type === 'SYNC_OBJECT_SEARCH_CHAT')).toBe(false);
  });

  it('pauses Object Search on Safety while preserving the exploration-only limiter behavior', () => {
    let state = requestExplorationGoal(startAppleSearch());
    state = dispatch(state, { type: 'NAVIGATION_GOAL_FEEDBACK', taskId: state.navigation.taskId });
    const stopped = transitionAppState(state, { type: 'SAFETY_CHANGED', stopped: true });
    expect(stopped.accepted).toBe(true);
    expect(stopped.state.objectSearch).toMatchObject({ status: 'paused', reason: 'safety-stop' });
    expect(stopped.state.exploration).toMatchObject({ status: 'paused', reason: 'safety-stop' });
    expect(stopped.state.navigation.status).toBe('canceled');
    expect(stopped.effects.slice(0, 5).map((effect) => effect.type)).toEqual([
      'RELEASE_USER_INPUT',
      'CANCEL_NAVIGATION_GOAL',
      'SET_COMMAND_OWNER',
      'ZERO_VELOCITY',
      'CLEAR_GOAL_DATA',
    ]);
    expect(stopped.effects.at(-1)?.type).toBe('SYNC_OBJECT_SEARCH_CHAT');

    let explorationOnly = explorationReadyState();
    explorationOnly = dispatch(explorationOnly, { type: 'EXPLORATION_START_REQUESTED', mapGeneration: 1, requestedAtMs: NOW_MS });
    explorationOnly = requestExplorationGoal(explorationOnly, 'frontier-limiter');
    explorationOnly = dispatch(explorationOnly, { type: 'NAVIGATION_GOAL_FEEDBACK', taskId: explorationOnly.navigation.taskId });
    const limited = transitionAppState(explorationOnly, { type: 'SAFETY_CHANGED', stopped: true });
    expect(limited.state.exploration.status).toBe('moving');
    expect(limited.effects.map((effect) => effect.type)).toEqual(['SET_NAVIGATION_STATUS']);
  });

  it.each([
    ['Transport切断', { type: 'TRANSPORT_CHANGED', connection: 'DISCONNECTED' } as const, 'transport'],
    ['TransportのSIM退避', { type: 'TRANSPORT_CHANGED', connection: 'SIMULATED' } as const, 'transport'],
    ['runtime change', { type: 'RUNTIME_SWITCH_REQUESTED', target: 'sim' } as const, 'runtime-change'],
    ['STAGE', { type: 'VIEW_REQUESTED', view: 'stage' } as const, 'stage'],
  ])('pauses safely on %s and never auto-resumes', (_label, event, reason) => {
    const state = startAppleSearch();
    const paused = transitionAppState(state, event);
    expect(paused.accepted).toBe(true);
    expect(paused.state.objectSearch).toMatchObject({ status: 'paused', reason });
    expect(paused.state.exploration.status).toBe('paused');
    expect(paused.state.navigation.status === 'idle' || paused.state.navigation.status === 'canceled').toBe(true);
  });

  it('cancels the mission and exploration with the existing goal cancel, manual owner, zero effect order', () => {
    let state = requestExplorationGoal(startAppleSearch());
    state = dispatch(state, { type: 'NAVIGATION_GOAL_FEEDBACK', taskId: state.navigation.taskId });
    const generation = state.objectSearch.generation;
    const canceled = transitionAppState(state, { type: 'OBJECT_SEARCH_CANCEL_REQUESTED', generation, requestedAtMs: NOW_MS + 1 });
    expect(canceled.accepted).toBe(true);
    expect(canceled.state.objectSearch).toMatchObject({ status: 'canceled', generation: generation + 1 });
    if (canceled.state.objectSearch.status !== 'canceled') throw new Error('expected canceled state');
    expect(canceled.state.objectSearch.detectionTracker).toMatchObject({
      phase: 'prestop',
      missionGeneration: generation + 1,
      frames: [],
    });
    expect(canceled.state.exploration.status).toBe('idle');
    expect(canceled.state.navigation.status).toBe('canceled');
    expect(canceled.state.command).toEqual({ owner: 'manual' });
    expect(canceled.effects.slice(0, 5).map((effect) => effect.type)).toEqual([
      'RELEASE_USER_INPUT',
      'CANCEL_NAVIGATION_GOAL',
      'SET_COMMAND_OWNER',
      'ZERO_VELOCITY',
      'CLEAR_GOAL_DATA',
    ]);
    expect(canceled.effects.map((effect) => effect.type)).toContain('CLEAR_EXPLORATION_DATA');
    expect(canceled.effects.at(-1)?.type).toBe('SYNC_OBJECT_SEARCH_CHAT');
  });

  it('rejects old resume callbacks and resumes from current fresh evidence only after explicit user intent', () => {
    let state = startAppleSearch();
    state = dispatch(state, { type: 'SAFETY_CHANGED', stopped: true });
    const staleGeneration = state.objectSearch.generation;
    state = dispatch(state, { type: 'SAFETY_CHANGED', stopped: false });
    state = dispatch(state, {
      type: 'EXPLORATION_MAP_OBSERVED',
      cycle: state.map.cycle,
      mapGeneration: 2,
      observedAtMs: NOW_MS + 20,
    });
    state = dispatch(state, { type: 'EXPLORATION_POSE_OBSERVED', cycle: state.map.cycle, observedAtMs: NOW_MS + 20 });
    state = observeVisionReady(state, NOW_MS + 20);
    expect(transitionAppState(state, {
      type: 'OBJECT_SEARCH_RESUME_REQUESTED',
      generation: staleGeneration - 1,
      visionCycle: state.vision.cycle,
      mapCycle: state.map.cycle,
      mapGeneration: 2,
      explorationGeneration: state.exploration.generation,
      requestedAtMs: NOW_MS + 20,
    }).accepted).toBe(false);

    const resumed = transitionAppState(state, {
      type: 'OBJECT_SEARCH_RESUME_REQUESTED',
      generation: state.objectSearch.generation,
      visionCycle: state.vision.cycle,
      mapCycle: state.map.cycle,
      mapGeneration: 2,
      explorationGeneration: state.exploration.generation,
      requestedAtMs: NOW_MS + 20,
    });
    expect(resumed.accepted, resumed.rejection).toBe(true);
    expect(resumed.state.objectSearch).toMatchObject({ status: 'searching', explorationGeneration: 2 });
    expect(resumed.state.exploration).toMatchObject({ status: 'evaluating', generation: 2, mapGeneration: 2 });
  });

  it('pauses when Vision freshness expires instead of reusing stale evidence', () => {
    const state = startAppleSearch();
    const checked = transitionAppState(state, {
      type: 'OBJECT_SEARCH_HEALTH_CHECK_REQUESTED',
      generation: state.objectSearch.generation,
      requestedAtMs: NOW_MS + VISION_DETECTOR_FRESHNESS_MS + 1,
    });
    expect(checked.accepted).toBe(true);
    expect(checked.state.objectSearch).toMatchObject({ status: 'paused', reason: 'vision' });
    expect(checked.state.exploration.status).toBe('paused');
    expect(checked.effects.map((effect) => effect.type)).toContain('ZERO_VELOCITY');
  });

  it('keeps searching while a newer Camera frame is awaiting its matching inference', () => {
    let state = startAppleSearch();
    state = dispatch(state, {
      type: 'VISION_FRAME_OBSERVED',
      cycle: state.vision.cycle,
      observedAtMs: NOW_MS + 600,
    });
    expect(state.vision.status).toBe('ready');

    const checked = transitionAppState(state, {
      type: 'OBJECT_SEARCH_HEALTH_CHECK_REQUESTED',
      generation: state.objectSearch.generation,
      requestedAtMs: NOW_MS + 700,
    });
    expect(checked.accepted, checked.rejection).toBe(true);
    expect(checked.state.objectSearch.status).toBe('searching');
  });

  it('pauses on origin reset, manual override, and Nav2 readiness loss with a visible reason', () => {
    const origin = transitionAppState(startAppleSearch(), { type: 'ROBOT_ORIGIN_RESET_REQUESTED' });
    expect(origin.state.objectSearch).toMatchObject({ status: 'paused', reason: 'origin-reset' });
    expect(origin.effects.map((effect) => effect.type)).toContain('RESET_ROBOT_ORIGIN');

    const manual = transitionAppState(startAppleSearch(), { type: 'COMMAND_OWNER_REQUESTED', owner: 'manual', requestedAtMs: NOW_MS });
    expect(manual.state.objectSearch).toMatchObject({ status: 'paused', reason: 'manual-override' });

    const state = startAppleSearch();
    const unavailable = transitionAppState(state, {
      type: 'NAVIGATION_UNAVAILABLE',
      cycle: state.map.cycle,
      status: 'Nav2 Action停止 / 速度0',
    });
    expect(unavailable.state.objectSearch).toMatchObject({ status: 'paused', reason: 'navigation-unavailable' });
    expect(unavailable.state.exploration).toMatchObject({ status: 'paused', reason: 'navigation-unavailable' });
  });

  it('cancels on map reset and rejects operator Nav2 while the mission owns the exploration workflow', () => {
    let state = startAppleSearch();
    const visionCycle = state.vision.cycle;
    const reset = transitionAppState(state, { type: 'MAP_RESET_REQUESTED' });
    expect(reset.accepted).toBe(true);
    expect(reset.state.objectSearch.status).toBe('canceled');
    expect(reset.state.vision.cycle).toBe(visionCycle + 1);
    expect(reset.state.exploration.status).toBe('idle');

    state = requestAppleSearch(explorationReadyState());
    const operatorGoal = transitionAppState(state, { type: 'NAVIGATION_GOAL_REQUESTED', goal: testGoal(), requestedAtMs: NOW_MS });
    expect(operatorGoal.accepted).toBe(false);
    expect(operatorGoal.rejection).toContain('Object Search Mission');
  });

  it('turns a YOLOX error into a recoverable Vision pause and invalidates that evidence cycle', () => {
    const state = startAppleSearch();
    const visionCycle = state.vision.cycle;
    const failed = transitionAppState(state, {
      type: 'VISION_STATUS_OBSERVED',
      cycle: visionCycle,
      status: 'error',
      observedAtMs: NOW_MS + 1,
      error: 'model inference failed',
    });
    expect(failed.accepted).toBe(true);
    expect(failed.state.objectSearch).toMatchObject({ status: 'paused', reason: 'vision' });
    expect(failed.state.vision).toMatchObject({ status: 'error', cycle: visionCycle + 1, message: 'model inference failed' });
    expect(failed.effects.map((effect) => effect.type)).toContain('ZERO_VELOCITY');
  });

  it('keeps Object Search running when coverage exploration would otherwise complete', () => {
    const state = completeObjectSearchExploration(startAppleSearch());
    expect(state.exploration).toMatchObject({ status: 'replanning', goalPolicy: 'object-search' });
    expect(state.objectSearch).toMatchObject({ status: 'searching', targetClass: 'apple' });
    expect(state.exploration).toMatchObject({ noCandidateConfirmations: 0 });

    let failed = startAppleSearch(explorationReadyState(10));
    const generation = failed.exploration.generation;
    failed = dispatch(failed, { type: 'EXPLORATION_ERROR_REPORTED', generation, error: '経路を確保できません。' });
    expect(failed.exploration.status).toBe('error');
    expect(failed.objectSearch).toMatchObject({ status: 'error', recoverable: true });
    expect(failed.objectSearch.status).not.toBe('finalizing');
  });

  it('keeps a banana mission searching after repeated completed-mapping signals', () => {
    let state = explorationReadyState();
    state = dispatch(state, {
      type: 'OBJECT_SEARCH_COMMAND_REQUESTED',
      targetClass: 'banana',
      displayName: 'バナナ',
      normalizedCommand: 'バナナを探して',
      requestedAtMs: NOW_MS,
    });
    state = observeVisionReady(state);
    state = advanceAppleSearch(state).state;
    expect(state.objectSearch).toMatchObject({ status: 'searching', targetClass: 'banana', displayName: 'バナナ' });

    state = completeObjectSearchExploration(state);
    expect(state.objectSearch).toMatchObject({ status: 'searching', targetClass: 'banana', displayName: 'バナナ' });
    expect(state.exploration).toMatchObject({ status: 'replanning', goalPolicy: 'object-search' });
    expect(state.objectSearch).toMatchObject({ lastChatStatus: expect.stringContaining('バナナ') });
  });
});

describe('stable detection, safe stop, and post-stop confirmation', () => {
  it('does not stop on one-frame noise and enters candidate only after the bounded tracker confirms stability', () => {
    let state = requestExplorationGoal(startAppleSearch());
    state = dispatch(state, { type: 'NAVIGATION_GOAL_FEEDBACK', taskId: state.navigation.taskId });
    const taskId = state.navigation.taskId;

    let observed = observeAppleFrame(state, NOW_MS + 100, [appleDetection({ confidence: .99 })]);
    expect(observed.accepted, observed.rejection).toBe(true);
    expect(observed.state.objectSearch.status).toBe('searching');
    expect(observed.state.navigation.taskId).toBe(taskId);
    expect(observed.effects).toHaveLength(0);
    state = observed.state;

    for (const [index, detections] of [[], [], [], []].entries()) {
      observed = observeAppleFrame(state, NOW_MS + 200 + index * 100, detections);
      expect(observed.accepted, observed.rejection).toBe(true);
      state = observed.state;
    }
    expect(state.objectSearch.status).toBe('searching');
    expect(state.navigation.status).toBe('moving');

    state = advanceToAppleCandidate();
    expect(state.objectSearch).toMatchObject({ status: 'candidate', targetClass: 'apple' });
    expect(state.navigation.status).toBe('moving');
    expect(state.exploration.status).toBe('moving');
  });

  it('routes a confirmed candidate through the existing exploration pause and exact safe-stop effect order', () => {
    const candidate = advanceToAppleCandidate();
    const stopped = requestCandidateSafeStop(candidate);

    expect(stopped.accepted, stopped.rejection).toBe(true);
    expect(stopped.state.objectSearch).toMatchObject({ status: 'stopping', stopRequestedAtMs: NOW_MS + 610 });
    expect(stopped.state.exploration).toMatchObject({ status: 'paused', reason: 'object-found-candidate' });
    expect(stopped.state.navigation.status).toBe('canceled');
    expect(stopped.state.command).toEqual({ owner: 'manual' });
    expect(stopped.effects.slice(0, 5).map((effect) => effect.type)).toEqual([
      'RELEASE_USER_INPUT',
      'CANCEL_NAVIGATION_GOAL',
      'SET_COMMAND_OWNER',
      'ZERO_VELOCITY',
      'CLEAR_GOAL_DATA',
    ]);
    expect(stopped.effects.some((effect) => effect.type === 'SEND_NAVIGATION_GOAL')).toBe(false);

    const stale = transitionAppState(candidate, {
      type: 'OBJECT_SEARCH_SAFE_STOP_REQUESTED',
      generation: candidate.objectSearch.generation - 1,
      visionCycle: candidate.vision.cycle,
      transportCycle: candidate.transportCycle,
      explorationGeneration: candidate.exploration.generation,
      candidateFrameStampMs: candidate.objectSearch.status === 'candidate' ? candidate.objectSearch.candidate.frameStampMs : 0,
      requestedAtMs: NOW_MS + 610,
    });
    expect(stale.accepted).toBe(false);
    expect(stale.effects).toHaveLength(0);
  });

  it('stops a visible stable apple within 5m without requiring camera centering or an approach goal', () => {
    const candidate = advanceToAppleCandidate(appleDetection({
      bbox: { centerX: 48, centerY: 120, width: 64, height: 48 },
      distanceMeters: 4.99,
    }));
    expect(candidate.objectSearch).toMatchObject({ status: 'candidate', positionConfirmed: true });

    const stopped = requestCandidateSafeStop(candidate);
    expect(stopped.accepted, stopped.rejection).toBe(true);
    expect(stopped.state.objectSearch.status).toBe('stopping');
    expect(stopped.effects.some((effect) => effect.type === 'SEND_NAVIGATION_GOAL')).toBe(false);
  });

  it('continues exploration when a stable visible apple is farther than 5m', () => {
    const farApple = appleDetection({
      bbox: { centerX: 48, centerY: 120, width: 64, height: 48 },
      distanceMeters: 5.01,
    });
    let state = requestExplorationGoal(startAppleSearch());
    state = dispatch(state, { type: 'NAVIGATION_GOAL_FEEDBACK', taskId: state.navigation.taskId });
    for (const [index, detections] of [[farApple], [], [farApple], [farApple], [farApple]].entries()) {
      const observed = observeAppleFrame(state, NOW_MS + 100 + index * 100, detections);
      expect(observed.accepted, observed.rejection).toBe(true);
      state = observed.state;
    }
    expect(state.objectSearch.status).toBe('searching');
    expect(state.navigation.status).toBe('moving');
    expect(state.exploration.status).toBe('moving');
  });

  it('requires acknowledged manual ownership and two consecutive fresh zero-velocity samples', () => {
    let state = requestCandidateSafeStop(advanceToAppleCandidate()).state;

    state = observeMotion(state, NOW_MS + 620).state;
    state = observeMotion(state, NOW_MS + 630).state;
    expect(state.objectSearch.status).toBe('stopping');

    state = dispatch(state, { type: 'COMMAND_OWNER_OBSERVED', owner: 'manual', observedAtMs: NOW_MS + 640 });
    expect(state.objectSearch.status).toBe('confirming');
    if (state.objectSearch.status !== 'confirming') throw new Error('expected confirming state');
    expect(state.objectSearch.stoppedAtMs).toBe(NOW_MS + 640);

    let interrupted = requestCandidateSafeStop(advanceToAppleCandidate()).state;
    interrupted = dispatch(interrupted, { type: 'COMMAND_OWNER_OBSERVED', owner: 'manual', observedAtMs: NOW_MS + 620 });
    interrupted = observeMotion(interrupted, NOW_MS + 630).state;
    interrupted = observeMotion(interrupted, NOW_MS + 640, .03, 0).state;
    interrupted = observeMotion(interrupted, NOW_MS + 650).state;
    expect(interrupted.objectSearch.status).toBe('stopping');
    interrupted = observeMotion(interrupted, NOW_MS + 660, .019, .029).state;
    expect(interrupted.objectSearch.status).toBe('confirming');
  });

  it('uses only post-stop fresh frames and succeeds when the latest visible apple is within 5m', () => {
    let state = advanceToPostStopConfirmation();
    if (state.objectSearch.status !== 'confirming') throw new Error('expected confirming state');
    const stoppedAtMs = state.objectSearch.stoppedAtMs;

    const preStop = observeAppleFrame(state, stoppedAtMs, [appleDetection()]);
    expect(preStop.accepted).toBe(false);
    expect(preStop.state.objectSearch.status).toBe('confirming');
    state = preStop.state;

    const visibleWithinRange = appleDetection({
      bbox: { centerX: 60, centerY: 120, width: 64, height: 48 },
      distanceMeters: 4.5,
    });
    state = observeAppleFrame(state, stoppedAtMs + 100, [visibleWithinRange]).state;
    state = observeAppleFrame(state, stoppedAtMs + 200, []).state;
    const succeeded = observeAppleFrame(state, stoppedAtMs + 300, [visibleWithinRange]);

    expect(succeeded.accepted, succeeded.rejection).toBe(true);
    expect(succeeded.state.objectSearch).toMatchObject({ status: 'succeeded', stoppedAtMs });
    if (succeeded.state.objectSearch.status !== 'succeeded') throw new Error('expected succeeded state');
    expect(succeeded.state.objectSearch.evidence.distanceMeters).toBe(4.5);
    expect(succeeded.state.exploration.status).toBe('paused');
    expect(succeeded.state.navigation.status).toBe('canceled');
    expect(succeeded.state.command).toEqual({ owner: 'manual' });
    expect(succeeded.effects).toContainEqual({
      type: 'SYNC_OBJECT_SEARCH_CHAT',
      status: 'accepted',
      targetClass: 'apple',
      role: 'robot',
      message: 'りんごを見つけました',
    });
    expect(succeeded.effects.some((effect) => effect.type === 'SEND_NAVIGATION_GOAL')).toBe(false);
    expect(succeeded.effects.some((effect) => effect.type === 'EVALUATE_EXPLORATION_MAP')).toBe(false);
  });

  it('does not succeed when post-stop apple lacks valid within-5m distance, or when stop evidence is lost', () => {
    let state = advanceToPostStopConfirmation();
    if (state.objectSearch.status !== 'confirming') throw new Error('expected confirming state');
    const stoppedAtMs = state.objectSearch.stoppedAtMs;
    const offCenter = { bbox: { centerX: 60, centerY: 120, width: 64, height: 48 } };
    state = observeAppleFrame(state, stoppedAtMs + 100, [appleDetection({ ...offCenter, distanceMeters: null })]).state;
    state = observeAppleFrame(state, stoppedAtMs + 200, []).state;
    state = observeAppleFrame(state, stoppedAtMs + 300, [appleDetection({ ...offCenter, distanceMeters: 6.1 })]).state;
    expect(state.objectSearch.status).toBe('confirming');

    let moving = advanceToPostStopConfirmation();
    moving = observeMotion(moving, NOW_MS + 700, .021, 0).state;
    expect(moving.objectSearch).toMatchObject({ status: 'paused', reason: 'navigation-unavailable' });
    const blocked = observeAppleFrame(moving, NOW_MS + 800, [appleDetection()]);
    expect(blocked.accepted).toBe(false);
    expect(blocked.state.objectSearch.status).not.toBe('succeeded');
  });

  it('clears detection evidence and resumes from fresh map evaluation without resending the old goal', () => {
    let state = advanceToPostStopConfirmation();
    if (state.exploration.status !== 'paused') throw new Error('expected paused exploration');
    state = {
      ...state,
      exploration: { ...state.exploration, blacklistedCandidateIds: ['failed-frontier'] },
    };
    if (state.objectSearch.status !== 'confirming') throw new Error('expected confirming state');
    const stoppedAtMs = state.objectSearch.stoppedAtMs;
    let result = observeAppleFrame(state, stoppedAtMs + 100, []);
    for (let index = 1; index < 5; index += 1) {
      result = observeAppleFrame(result.state, stoppedAtMs + 100 + index * 100, []);
    }

    expect(result.accepted, result.rejection).toBe(true);
    expect(result.state.objectSearch).toMatchObject({ status: 'searching', lostCount: 1 });
    expect(result.state.exploration).toMatchObject({ status: 'evaluating', blacklistedCandidateIds: ['failed-frontier'] });
    expect(result.effects.some((effect) => effect.type === 'EVALUATE_EXPLORATION_MAP')).toBe(true);
    expect(result.effects.some((effect) => effect.type === 'SEND_NAVIGATION_GOAL')).toBe(false);
    expect(result.effects).toContainEqual({
      type: 'SYNC_OBJECT_SEARCH_CHAT',
      status: 'accepted',
      targetClass: 'apple',
      role: 'robot',
      message: 'りんごを見失いました。探索を再開します。',
    });
  });

  it('bounds lost-target retries and rejects stale cycle callbacks from stopping or confirming', () => {
    let state = advanceToPostStopConfirmation();
    if (state.objectSearch.status !== 'confirming') throw new Error('expected confirming state');
    state = { ...state, objectSearch: { ...state.objectSearch, lostCount: 2 } };
    if (state.objectSearch.status !== 'confirming') throw new Error('expected confirming state');
    const stoppedAtMs = state.objectSearch.stoppedAtMs;
    let result = observeAppleFrame(state, stoppedAtMs + 100, []);
    for (let index = 1; index < 5; index += 1) {
      result = observeAppleFrame(result.state, stoppedAtMs + 100 + index * 100, []);
    }
    expect(result.state.objectSearch).toMatchObject({ status: 'error', recoverable: true, lostCount: 3 });
    expect(result.state.exploration.status).toBe('paused');
    expect(result.effects.some((effect) => effect.type === 'SEND_NAVIGATION_GOAL')).toBe(false);

    const confirming = advanceToPostStopConfirmation();
    const stale = transitionAppState(confirming, {
      type: 'OBJECT_SEARCH_DETECTION_OBSERVED',
      generation: confirming.objectSearch.generation,
      visionCycle: confirming.vision.cycle - 1,
      transportCycle: confirming.transportCycle,
      explorationGeneration: confirming.exploration.generation,
      frameStampMs: NOW_MS + 900,
      cameraFrameStampMs: NOW_MS + 900,
      observedAtMs: NOW_MS + 910,
      imageWidth: 320,
      imageHeight: 240,
      detections: [appleDetection()],
    });
    expect(stale.accepted).toBe(false);
    expect(stale.state.objectSearch.status).toBe('confirming');
  });
});
