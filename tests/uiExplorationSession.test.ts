import { describe, expect, it, vi } from 'vitest';
import { NAVIGATION_GOAL_CANCEL_SETTLE_MS, createInitialAppState, type AppEffect, type AppEvent, type AppState } from '../src/appState';
import { createExplorationGoalVisitHistory, createFrontierHistory, type ExplorationGoalVisitHistory, type FrontierCandidate } from '../src/frontierExploration';
import { createExplorationSweepProgress, type ExplorationSweepProgress } from '../src/explorationCompletion';
import { createAppleDetectionTracker } from '../src/objectSearchDetection';
import { rosGraphRuleForMode } from '../src/rosGraphHealth';
import type { OccupancyGridMessage, PoseStampedMessage, RosGraphSnapshot, TopicMessage, TopicName, TransportEvent } from '../src/types';
import { LearningUI, classifyExplorationNoCandidateResult, clampTabletControlDockPosition, commandOwnerAwaitingAcknowledgement, explorationControlCopy } from '../src/ui';

interface ExplorationSessionHarness {
  runAppEffect(effect: AppEffect): void;
  explorationMapSnapshots: Map<number, unknown>;
  explorationMapGeneration: number;
  latestMapReceivedAt: number;
  latestExplorationPoseAt: number;
  explorationEvidenceNotBeforeMs: number;
  latestSlamPose: unknown;
  explorationGraphFailureChecks: number;
  clearNavigationTracking: () => void;
  clearCurrentMap: () => void;
  clearExplorationVisuals: () => void;
}

describe('exploration UI runtime session isolation', () => {
  it('uses distinct actions and labels for recoverable errors and verified completion', () => {
    expect(explorationControlCopy('error')).toEqual({
      chipLabel: '探索エラー',
      resumeLabel: 'エラーから再開',
      stopLabel: 'エラー状態を終了',
      stopTitle: '探索エラーを完了扱いにせず、安全停止済みのrunを終了します',
    });
    expect(explorationControlCopy('completed')).toEqual({
      chipLabel: 'COMPLETED',
      resumeLabel: '再開',
      stopLabel: '終了',
      stopTitle: '完了条件を確認した探索を終了します',
    });
    expect(explorationControlCopy('moving', false).stopLabel).toBe('探索を中止');
    expect(explorationControlCopy('moving', true)).toEqual({
      chipLabel: 'MOVING',
      resumeLabel: '再開',
      stopLabel: '終了',
      stopTitle: '観測済み領域が90%以上に達したため、goalを取消して探索を終了できます',
    });
    expect(explorationControlCopy('moving', true, true).stopLabel).toBe('探索を中止');
  });

  it('keeps the touch palette inside the viewport while it is dragged', () => {
    expect(clampTabletControlDockPosition(
      { left: -40, top: 900 },
      { width: 390, height: 844 },
      { width: 180, height: 260 },
    )).toEqual({ left: 8, top: 576 });
    expect(clampTabletControlDockPosition(
      { left: 120, top: 240 },
      { width: 390, height: 844 },
      { width: 180, height: 260 },
    )).toEqual({ left: 120, top: 240 });
  });

  it('records an accepted exploration goal success into the spatial visit history', () => {
    interface GoalResultCallbacks { onResult(): void }
    interface GoalResultHarness {
      runAppEffect(effect: AppEffect): void;
      explorationGoalVisitHistory: ExplorationGoalVisitHistory;
      explorationSweepProgress: ExplorationSweepProgress;
      explorationCandidateByTask: Map<number, unknown>;
    }
    const candidate: FrontierCandidate = {
      id: 'frontier-success-1',
      clusterId: 'frontier-1',
      clusterCellIndices: Int32Array.of(1),
      cell: { index: 1, x: 1, y: 0 },
      world: { x: 2, y: 3, yaw: 0 },
      metrics: { informationGain: 3, pathDistanceMeters: 2, clearanceMeters: 1, score: 3 },
    };
    const goal: PoseStampedMessage = {
      header: { frame_id: 'map', stamp: { sec: 1, nanosec: 0 } },
      pose: {
        position: { x: 2, y: 3, z: 0 },
        orientation: { x: 0, y: 0, z: 0, w: 1 },
      },
    };
    const appState = createInitialAppState();
    appState.navigation = { status: 'sending', taskId: 9, source: 'exploration', goalId: null };
    appState.exploration = {
      status: 'sending',
      taskId: 9,
      selected: { candidateId: candidate.id, mapGeneration: 7, goal },
      generation: 1,
      goalPolicy: 'coverage',
      mapCycle: 1,
      lastMapGeneration: 7,
      retryCount: 0,
      replanCount: 0,
      noCandidateConfirmations: 0,
      blacklistedCandidateIds: [],
    };
    const resultCallbacks: GoalResultCallbacks[] = [];
    const ui = Object.create(LearningUI.prototype) as GoalResultHarness & Record<string, unknown>;
    Object.assign(ui, {
      appState,
      frontierAnalysis: { candidates: [candidate], knownCellCount: 100 },
      frontierAnalysisMapGeneration: 7,
      explorationCandidateByTask: new Map<number, unknown>(),
      explorationTasksWithStaleTransform: new Set<number>(),
      explorationGoalVisitHistory: createExplorationGoalVisitHistory(),
      explorationSweepProgress: createExplorationSweepProgress(),
      transport: {
        sendNavigationGoal: (_goal: PoseStampedMessage, callbacks: GoalResultCallbacks) => {
          resultCallbacks.push(callbacks);
          return 'goal-9';
        },
      },
      find: vi.fn(() => ({ textContent: '' })),
      publishNavigationGoalDistance: vi.fn(),
      scheduleNavigationMap: vi.fn(),
      dispatchAppEvent: vi.fn(() => true),
    });

    ui.runAppEffect({ type: 'SEND_NAVIGATION_GOAL', goal, taskId: 9 });
    expect(resultCallbacks).toHaveLength(1);
    resultCallbacks[0].onResult();

    expect(ui.explorationSweepProgress.successfulGoalCount).toBe(1);
    expect(ui.explorationGoalVisitHistory.entries).toEqual([{
      candidateId: candidate.id,
      world: { x: 2, y: 3 },
      cornerIndex: null,
    }]);
  });

  it('treats an aborted goal during stale map-to-odom TF as a transient wait', () => {
    interface GoalResultCallbacks { onError(error: { status: 'aborted'; message: string }): void }
    const candidate: FrontierCandidate = {
      id: 'frontier-tf-wait',
      clusterId: 'frontier-tf',
      clusterCellIndices: Int32Array.of(1),
      cell: { index: 1, x: 1, y: 0 },
      world: { x: 2, y: 3, yaw: 0 },
      metrics: { informationGain: 3, pathDistanceMeters: 2, clearanceMeters: 1, score: 3 },
    };
    const goal: PoseStampedMessage = {
      header: { frame_id: 'map', stamp: { sec: 200, nanosec: 0 } },
      pose: {
        position: { x: 2, y: 3, z: 0 },
        orientation: { x: 0, y: 0, z: 0, w: 1 },
      },
    };
    const appState = createInitialAppState();
    appState.navigation = { status: 'sending', taskId: 10, source: 'exploration', goalId: null };
    appState.exploration = {
      status: 'sending',
      taskId: 10,
      selected: { candidateId: candidate.id, mapGeneration: 8, goal },
      generation: 1,
      goalPolicy: 'coverage',
      mapCycle: 1,
      lastMapGeneration: 8,
      retryCount: 0,
      replanCount: 0,
      noCandidateConfirmations: 0,
      blacklistedCandidateIds: [],
    };
    const callbacks: GoalResultCallbacks[] = [];
    const dispatchAppEvent = vi.fn(() => true);
    const ui = Object.create(LearningUI.prototype) as {
      runAppEffect(effect: AppEffect): void;
      frontierHistory: ReturnType<typeof createFrontierHistory>;
      explorationSweepProgress: ExplorationSweepProgress;
      explorationLastReason: string;
    } & Record<string, unknown>;
    Object.assign(ui, {
      appState,
      latestMapToOdom: {
        header: { frame_id: 'map', stamp: { sec: 200, nanosec: 0 } },
        child_frame_id: 'odom',
        transform: {
          translation: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
        },
      },
      frontierAnalysis: { candidates: [candidate], knownCellCount: 100 },
      frontierAnalysisMapGeneration: 8,
      frontierHistory: createFrontierHistory(),
      explorationCandidateByTask: new Map<number, unknown>(),
      explorationTasksWithStaleTransform: new Set<number>([10]),
      explorationGoalVisitHistory: createExplorationGoalVisitHistory(),
      explorationSweepProgress: createExplorationSweepProgress(),
      transport: {
        sendNavigationGoal: (_goal: PoseStampedMessage, resultCallbacks: GoalResultCallbacks) => {
          callbacks.push(resultCallbacks);
          return 'goal-10';
        },
      },
      find: vi.fn(() => ({ textContent: '' })),
      publishNavigationGoalDistance: vi.fn(),
      scheduleNavigationMap: vi.fn(),
      renderExplorationControls: vi.fn(),
      dispatchAppEvent,
    });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(200_000);

    ui.runAppEffect({ type: 'SEND_NAVIGATION_GOAL', goal, taskId: 10 });
    callbacks[0].onError({ status: 'aborted', message: 'The action was aborted' });

    expect(ui.frontierHistory.entries).toEqual([]);
    expect(ui.explorationSweepProgress.consecutiveGoalFailures).toBe(0);
    expect(dispatchAppEvent).toHaveBeenLastCalledWith({
      type: 'NAVIGATION_GOAL_FAILED',
      taskId: 10,
      error: 'SLAMのmap→odom TFが遅れています',
      canceled: false,
      transient: 'stale-transform',
    }, false);
    expect(ui.explorationLastReason).toContain('失敗回数やblacklistへ加算しません');
    clock.mockRestore();
  });

  it('treats an aborted Object Search goal during map churn as a transient wait', () => {
    interface GoalResultCallbacks { onError(error: { status: 'aborted'; message: string }): void }
    const candidate: FrontierCandidate = {
      id: 'object-search-map-recovery',
      clusterId: 'frontier-map-recovery',
      clusterCellIndices: Int32Array.of(1),
      cell: { index: 1, x: 1, y: 0 },
      world: { x: 2, y: 3, yaw: 0 },
      metrics: { informationGain: 3, pathDistanceMeters: 2, clearanceMeters: 1, score: 3 },
    };
    const goal: PoseStampedMessage = {
      header: { frame_id: 'map', stamp: { sec: 200, nanosec: 0 } },
      pose: {
        position: { x: 2, y: 3, z: 0 },
        orientation: { x: 0, y: 0, z: 0, w: 1 },
      },
    };
    const map = (data: number[], width = 4): OccupancyGridMessage => ({
      header: { frame_id: 'map', stamp: { sec: 200, nanosec: 0 } },
      info: {
        map_load_time: { sec: 200, nanosec: 0 },
        resolution: 0.05,
        width,
        height: 2,
        origin: {
          position: { x: 0, y: 0, z: 0 },
          orientation: { x: 0, y: 0, z: 0, w: 1 },
        },
      },
      data,
    });
    const appState = createInitialAppState();
    appState.navigation = { status: 'sending', taskId: 13, source: 'exploration', goalId: null };
    appState.objectSearch = {
      status: 'searching',
      missionId: 1,
      generation: 1,
      targetClass: 'apple',
      displayName: 'りんご',
      normalizedCommand: 'りんごを探して',
      requestedAtMs: 100_000,
      controlLeaseGeneration: 0,
      explorationGeneration: 1,
      mapCycle: 1,
      visionCycle: 1,
      transportCycle: 1,
      lostCount: 0,
      detectionTracker: createAppleDetectionTracker({
        phase: 'prestop',
        missionGeneration: 1,
        visionCycle: 1,
        transportCycle: 1,
        targetClass: 'apple',
        notBeforeFrameStampMs: 0,
      }),
      runtimePreparationPending: false,
      lastChatStatus: '',
    };
    appState.exploration = {
      status: 'sending',
      taskId: 13,
      selected: { candidateId: candidate.id, mapGeneration: 8, goal },
      generation: 1,
      goalPolicy: 'object-search',
      mapCycle: 1,
      lastMapGeneration: 8,
      retryCount: 0,
      replanCount: 0,
      noCandidateConfirmations: 0,
      blacklistedCandidateIds: [],
    };
    const callbacks: GoalResultCallbacks[] = [];
    const dispatchAppEvent = vi.fn(() => true);
    const ui = Object.create(LearningUI.prototype) as {
      runAppEffect(effect: AppEffect): void;
      frontierHistory: ReturnType<typeof createFrontierHistory>;
      explorationSweepProgress: ExplorationSweepProgress;
      explorationLastReason: string;
    } & Record<string, unknown>;
    Object.assign(ui, {
      appState,
      latestMapToOdom: {
        header: { frame_id: 'map', stamp: { sec: 200, nanosec: 0 } },
        child_frame_id: 'odom',
        transform: {
          translation: { x: 0, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
        },
      },
      explorationMapSnapshots: new Map([[1, map(new Array(8).fill(0))], [2, map(new Array(8).fill(0))], [3, map(new Array(8).fill(100))]]),
      frontierAnalysis: { candidates: [candidate], knownCellCount: 100 },
      frontierAnalysisMapGeneration: 8,
      frontierHistory: createFrontierHistory(),
      explorationCandidateByTask: new Map<number, unknown>(),
      explorationTasksWithStaleTransform: new Set<number>(),
      explorationGoalVisitHistory: createExplorationGoalVisitHistory(),
      explorationSweepProgress: createExplorationSweepProgress(),
      transport: {
        sendNavigationGoal: (_goal: PoseStampedMessage, resultCallbacks: GoalResultCallbacks) => {
          callbacks.push(resultCallbacks);
          return 'goal-13';
        },
      },
      find: vi.fn(() => ({ textContent: '' })),
      publishNavigationGoalDistance: vi.fn(),
      scheduleNavigationMap: vi.fn(),
      renderExplorationControls: vi.fn(),
      dispatchAppEvent,
    });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(200_000);

    ui.runAppEffect({ type: 'SEND_NAVIGATION_GOAL', goal, taskId: 13 });
    callbacks[0].onError({ status: 'aborted', message: 'The action was aborted' });

    expect(ui.frontierHistory.entries).toEqual([]);
    expect(ui.explorationSweepProgress.consecutiveGoalFailures).toBe(0);
    expect(dispatchAppEvent).toHaveBeenLastCalledWith({
      type: 'NAVIGATION_GOAL_FAILED',
      taskId: 13,
      error: 'SLAM mapまたはcostmapが安定していません',
      canceled: false,
      transient: 'navigation-recovery',
    }, false);
    expect(ui.explorationLastReason).toContain('mapの形状または占有データが変化中');
    clock.mockRestore();
  });

  it('keeps manual ownership until a canceled frontier goal has settled before sending Object Search navigation', () => {
    vi.useFakeTimers();
    try {
      const goal: PoseStampedMessage = {
        header: { frame_id: 'map', stamp: { sec: 1, nanosec: 0 } },
        pose: {
          position: { x: 2, y: 3, z: 0 },
          orientation: { x: 0, y: 0, z: 0, w: 1 },
        },
      };
      const appState = createInitialAppState();
      appState.navigation = { status: 'sending', taskId: 11, source: 'object-search', goalId: null };
      const sendNavigationGoal = vi.fn(() => 'object-search-goal-11');
      const publish = vi.fn();
      const setNavigationMode = vi.fn();
      const dispatchAppEvent = vi.fn(() => true);
      const ui = Object.create(LearningUI.prototype) as { runAppEffect(effect: AppEffect): void } & Record<string, unknown>;
      Object.assign(ui, {
        appState,
        explorationCandidateByTask: new Map<number, unknown>(),
        explorationGoalVisitHistory: createExplorationGoalVisitHistory(),
        explorationSweepProgress: createExplorationSweepProgress(),
        transport: {
          getConnectionState: () => 'CONNECTED',
          publish,
          sendNavigationGoal,
        },
        simulation: { setNavigationMode },
        find: vi.fn(() => ({ textContent: '' })),
        publishNavigationGoalDistance: vi.fn(),
        scheduleNavigationMap: vi.fn(),
        dispatchAppEvent,
      });

      ui.runAppEffect({ type: 'SEND_NAVIGATION_GOAL', goal, taskId: 11, afterCancelSettles: true });
      expect(sendNavigationGoal).not.toHaveBeenCalled();
      expect(setNavigationMode).not.toHaveBeenCalled();

      vi.advanceTimersByTime(NAVIGATION_GOAL_CANCEL_SETTLE_MS - 1);
      expect(sendNavigationGoal).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(setNavigationMode).toHaveBeenCalledWith(true);
      expect(publish).toHaveBeenCalledWith('/control/navigation_mode', expect.any(String), { data: true });
      expect(sendNavigationGoal).toHaveBeenCalledTimes(1);
      expect(dispatchAppEvent).toHaveBeenCalledWith({
        type: 'NAVIGATION_GOAL_ACCEPTED',
        taskId: 11,
        goalId: 'object-search-goal-11',
      }, false);

      appState.navigation = { status: 'sending', taskId: 12, source: 'object-search', goalId: null };
      ui.runAppEffect({ type: 'SEND_NAVIGATION_GOAL', goal, taskId: 12, afterCancelSettles: true });
      appState.navigation = { status: 'canceled', taskId: 12, source: 'object-search' };
      vi.advanceTimersByTime(NAVIGATION_GOAL_CANCEL_SETTLE_MS);
      expect(sendNavigationGoal).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets fixed-map navigation and republishes the matching AMCL initial pose', () => {
    const publish = vi.fn();
    const resetForNavigation = vi.fn();
    const updateHandles = vi.fn();
    const ui = Object.create(LearningUI.prototype) as ExplorationSessionHarness & Record<string, unknown>;
    const appState = createInitialAppState();
    appState.runtime = { status: 'stable', mode: 'navigation' };
    Object.assign(ui, {
      appState,
      latestMapToOdom: {
        header: { frame_id: 'map', stamp: { sec: 1, nanosec: 0 } },
        child_frame_id: 'odom',
        transform: {
          translation: { x: 10, y: 20, z: 0 },
          rotation: { x: 0, y: 0, z: 0, w: 1 },
        },
      },
      latestSlamPose: null,
      latestOdomPose: null,
      simulation: { resetForNavigation },
      transport: { getConnectionState: () => 'CONNECTED', publish },
      updateHandles,
    });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(123_456);

    ui.runAppEffect({ type: 'RESET_ROBOT_ORIGIN' });

    expect(resetForNavigation).toHaveBeenCalledWith(false);
    expect(publish).toHaveBeenCalledWith(
      '/initialpose',
      'geometry_msgs/msg/PoseWithCovarianceStamped',
      expect.objectContaining({
        header: { frame_id: 'map', stamp: { sec: 123, nanosec: 456_000_000 } },
        pose: expect.objectContaining({
          pose: expect.objectContaining({ position: expect.objectContaining({ x: 7.35, y: 20 }) }),
          covariance: expect.arrayContaining([.25]),
        }),
      }),
    );
    expect(updateHandles).toHaveBeenCalledOnce();
    clock.mockRestore();
  });

  it('clears map snapshots and freshness timestamps with runtime data', () => {
    const snapshots = new Map<number, unknown>([[7, { stale: true }]]);
    const clearNavigationTracking = vi.fn();
    const clearCurrentMap = vi.fn();
    const clearExplorationVisuals = vi.fn();
    const ui = Object.create(LearningUI.prototype) as ExplorationSessionHarness;
    Object.assign(ui, {
      explorationMapSnapshots: snapshots,
      explorationMapGeneration: 7,
      latestMapReceivedAt: 123_000,
      latestExplorationPoseAt: 123_100,
      explorationEvidenceNotBeforeMs: 0,
      latestSlamPose: { stale: true },
      explorationGraphFailureChecks: 1,
      clearNavigationTracking,
      clearCurrentMap,
      clearExplorationVisuals,
    });

    const clock = vi.spyOn(Date, 'now').mockReturnValue(124_000);
    ui.runAppEffect({ type: 'CLEAR_RUNTIME_DATA' });

    expect(snapshots.size).toBe(0);
    expect(ui.explorationMapGeneration).toBe(8);
    expect(ui.latestMapReceivedAt).toBe(0);
    expect(ui.latestExplorationPoseAt).toBe(0);
    expect(ui.explorationEvidenceNotBeforeMs).toBe(124_000);
    expect(ui.latestSlamPose).toBeNull();
    expect(ui.explorationGraphFailureChecks).toBe(0);
    expect(clearNavigationTracking).toHaveBeenCalledOnce();
    expect(clearCurrentMap).toHaveBeenCalledOnce();
    expect(clearExplorationVisuals).toHaveBeenCalledOnce();
    clock.mockRestore();
  });

  it('rejects delayed map and pose Topic callbacks at the reset evidence barrier', () => {
    interface TopicHarness {
      onTopicEvent(event: TransportEvent): void;
      syncMappingPose(): void;
      appState: AppState;
      transport: { getConnectionState(): 'CONNECTED' };
      eventLog: Map<TopicName, TopicMessage>;
      selectedTopic: TopicName;
      explorationEvidenceNotBeforeMs: number;
      explorationMapGeneration: number;
      explorationMapSnapshots: Map<number, OccupancyGridMessage>;
      latestMapReceivedAt: number;
      latestExplorationPoseAt: number;
      latestSlamPose: PoseStampedMessage | null;
      mapToOdomHistory: never[];
      odomHistory: never[];
      currentPose: PoseStampedMessage | null;
      occupancyMap: OccupancyGridMessage | null;
      mapEmpty: { hidden: boolean };
      animateFlow: () => void;
      dispatchAppEvent: (event: AppEvent, announceRejection: boolean) => boolean;
      scheduleNavigationMap: () => void;
      evaluateWaitingExplorationOnFreshMap: () => void;
      updatePoseText: () => void;
    }
    const stamp = (milliseconds: number) => ({
      sec: Math.floor(milliseconds / 1000),
      nanosec: Math.round(milliseconds % 1000 * 1_000_000),
    });
    const mapAt = (milliseconds: number): OccupancyGridMessage => ({
      header: { frame_id: 'map', stamp: stamp(milliseconds) },
      info: {
        map_load_time: stamp(milliseconds),
        resolution: .05,
        width: 1,
        height: 1,
        origin: {
          position: { x: 0, y: 0, z: 0 },
          orientation: { x: 0, y: 0, z: 0, w: 1 },
        },
      },
      data: [0],
    });
    const poseAt = (milliseconds: number): PoseStampedMessage => ({
      header: { frame_id: 'map', stamp: stamp(milliseconds) },
      pose: {
        position: { x: 0, y: 0, z: 0 },
        orientation: { x: 0, y: 0, z: 0, w: 1 },
      },
    });
    const dispatchAppEvent = vi.fn(() => true);
    const evaluateWaitingExplorationOnFreshMap = vi.fn();
    const ui = Object.create(LearningUI.prototype) as TopicHarness;
    Object.assign(ui, {
      appState: {
        ...createInitialAppState(),
        runtime: { status: 'stable', mode: 'exploration' },
        transport: 'CONNECTED',
        map: { status: 'initializing', target: 'exploration', reason: 'map-reset', mapReceived: false, poseReceived: false, navigationReceived: false, cycle: 7 },
      },
      transport: { getConnectionState: () => 'CONNECTED' as const },
      eventLog: new Map<TopicName, TopicMessage>(),
      selectedTopic: '/cmd_vel' as const,
      explorationEvidenceNotBeforeMs: 1_000,
      explorationMapGeneration: 4,
      explorationMapSnapshots: new Map<number, OccupancyGridMessage>(),
      latestMapReceivedAt: 0,
      latestExplorationPoseAt: 0,
      latestSlamPose: null,
      mapToOdomHistory: [],
      odomHistory: [],
      currentPose: null,
      occupancyMap: null,
      mapEmpty: { hidden: false },
      animateFlow: vi.fn(),
      dispatchAppEvent,
      scheduleNavigationMap: vi.fn(),
      evaluateWaitingExplorationOnFreshMap,
      updatePoseText: vi.fn(),
    });

    ui.onTopicEvent({ topic: '/map', message: mapAt(999), at: 0 });
    ui.onTopicEvent({ topic: '/map', message: mapAt(1_000), at: 1 });
    expect(ui.explorationMapGeneration).toBe(4);
    expect(ui.explorationMapSnapshots.size).toBe(0);
    expect(dispatchAppEvent).not.toHaveBeenCalled();

    ui.onTopicEvent({ topic: '/map', message: mapAt(1_001), at: 2 });
    expect(ui.explorationMapGeneration).toBe(5);
    expect(ui.explorationMapSnapshots.get(5)).toEqual(mapAt(1_001));
    expect(ui.latestMapReceivedAt).toBe(1_001);
    expect(dispatchAppEvent).toHaveBeenNthCalledWith(1, { type: 'MAP_RECEIVED', cycle: 7 }, false);
    expect(dispatchAppEvent).toHaveBeenNthCalledWith(2, {
      type: 'EXPLORATION_MAP_OBSERVED',
      cycle: 7,
      mapGeneration: 5,
      observedAtMs: 1_001,
    }, false);
    expect(evaluateWaitingExplorationOnFreshMap).toHaveBeenCalledOnce();

    dispatchAppEvent.mockClear();
    evaluateWaitingExplorationOnFreshMap.mockClear();
    ui.latestSlamPose = poseAt(1_000);
    ui.syncMappingPose();
    expect(ui.currentPose).toBeNull();
    expect(dispatchAppEvent).not.toHaveBeenCalled();

    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_002);
    ui.latestSlamPose = poseAt(1_001);
    ui.syncMappingPose();
    expect(ui.currentPose).toEqual(poseAt(1_001));
    expect(ui.latestExplorationPoseAt).toBe(1_001);
    expect(dispatchAppEvent).toHaveBeenNthCalledWith(1, { type: 'POSE_READY', cycle: 7 }, false);
    expect(dispatchAppEvent).toHaveBeenNthCalledWith(2, { type: 'EXPLORATION_POSE_OBSERVED', cycle: 7, observedAtMs: 1_001 }, false);
    expect(evaluateWaitingExplorationOnFreshMap).toHaveBeenCalledOnce();
    clock.mockRestore();
  });

  it('keeps readiness through one lifecycle timeout and invalidates it on the consecutive timeout', async () => {
    interface GraphHealthHarness {
      refreshRosGraph(): Promise<void>;
      transport: { getConnectionState(): 'CONNECTED'; getGraphSnapshot(): Promise<RosGraphSnapshot> };
      appState: AppState;
      rosGraphRequestGeneration: number;
      missingGraphChecks: number;
      explorationGraphFailureChecks: number;
      renderGraphList: () => void;
      find: () => { textContent: string };
      dispatchAppEvent: (event: AppEvent, announceRejection: boolean) => boolean;
      showNarration: (message: string) => void;
    }
    const rule = rosGraphRuleForMode('exploration');
    let lifecycleManagers: RosGraphSnapshot['lifecycleManagers'] = { mapping: true, navigation: null };
    const transport = {
      getConnectionState: (): 'CONNECTED' => 'CONNECTED',
      getGraphSnapshot: async (): Promise<RosGraphSnapshot> => ({
        nodes: [...rule.required],
        topics: [],
        actions: ['/navigate_to_pose'],
        lifecycleManagers,
      }),
    };
    const dispatchAppEvent = vi.fn(() => true);
    const ui = Object.create(LearningUI.prototype) as GraphHealthHarness;
    Object.assign(ui, {
      transport,
      appState: {
        ...createInitialAppState(),
        runtime: { status: 'stable', mode: 'exploration' },
        transport: 'CONNECTED',
        map: { status: 'ready', mode: 'exploration', cycle: 7 },
      },
      rosGraphRequestGeneration: 0,
      missingGraphChecks: 0,
      explorationGraphFailureChecks: 0,
      renderGraphList: vi.fn(),
      find: vi.fn(() => ({ textContent: '' })),
      dispatchAppEvent,
      showNarration: vi.fn(),
    });

    await ui.refreshRosGraph();
    expect(ui.explorationGraphFailureChecks).toBe(1);
    expect(dispatchAppEvent).not.toHaveBeenCalled();

    await ui.refreshRosGraph();
    expect(ui.explorationGraphFailureChecks).toBe(2);
    expect(dispatchAppEvent).toHaveBeenCalledOnce();
    expect(dispatchAppEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'NAVIGATION_UNAVAILABLE',
      cycle: 7,
    }), false);

    lifecycleManagers = { mapping: true, navigation: true };
    await ui.refreshRosGraph();
    expect(ui.explorationGraphFailureChecks).toBe(0);
    expect(dispatchAppEvent).toHaveBeenLastCalledWith({ type: 'NAVIGATION_READY', cycle: 7 }, false);
  });

  it('does not call rosapi graph services while the runtime is switching', async () => {
    interface GraphSuspensionHarness {
      refreshRosGraph(): Promise<void>;
      transport: { getConnectionState(): 'CONNECTED'; getGraphSnapshot: ReturnType<typeof vi.fn> };
      appState: AppState;
    }
    const getGraphSnapshot = vi.fn();
    const ui = Object.create(LearningUI.prototype) as GraphSuspensionHarness;
    Object.assign(ui, {
      transport: { getConnectionState: (): 'CONNECTED' => 'CONNECTED', getGraphSnapshot },
      appState: {
        ...createInitialAppState(),
        runtime: { status: 'switching', mode: 'mapping', target: 'exploration', phase: 'processing' },
        transport: 'CONNECTED',
        map: {
          status: 'initializing',
          target: 'exploration',
          reason: 'runtime-switch',
          mapReceived: false,
          poseReceived: false,
          navigationReceived: false,
          cycle: 8,
        },
      },
    });

    await ui.refreshRosGraph();
    expect(getGraphSnapshot).not.toHaveBeenCalled();
  });

  it('does not call rosapi graph services before cold exploration has map and pose evidence', async () => {
    interface GraphSuspensionHarness {
      refreshRosGraph(): Promise<void>;
      transport: { getConnectionState(): 'CONNECTED'; getGraphSnapshot: ReturnType<typeof vi.fn> };
      appState: AppState;
    }
    const getGraphSnapshot = vi.fn();
    const ui = Object.create(LearningUI.prototype) as GraphSuspensionHarness;
    Object.assign(ui, {
      transport: { getConnectionState: (): 'CONNECTED' => 'CONNECTED', getGraphSnapshot },
      appState: {
        ...createInitialAppState(),
        runtime: { status: 'stable', mode: 'exploration' },
        transport: 'CONNECTED',
        map: {
          status: 'initializing',
          target: 'exploration',
          reason: 'runtime-switch',
          mapReceived: true,
          poseReceived: false,
          navigationReceived: false,
          cycle: 8,
        },
      },
    });

    await ui.refreshRosGraph();
    expect(getGraphSnapshot).not.toHaveBeenCalled();
  });

  it('classifies only genuine frontier exhaustion as terminal candidate absence', () => {
    const candidate: FrontierCandidate = {
      id: 'frontier-1',
      clusterId: 'cluster-1',
      clusterCellIndices: new Int32Array([1]),
      cell: { index: 1, x: 1, y: 0 },
      world: { x: 1, y: 0, yaw: 0 },
      metrics: { informationGain: 2, pathDistanceMeters: 1, clearanceMeters: 1, score: 1 },
    };
    const available = { cooldown: 0, 'max-attempts': 0 };
    const coolingDown = { cooldown: 1, 'max-attempts': 0 };
    const exhausted = { cooldown: 0, 'max-attempts': 1 };
    const mixed = { cooldown: 1, 'max-attempts': 1 };

    expect(classifyExplorationNoCandidateResult({ selectionReason: 'no-frontiers', candidates: [], blacklistStatusCounts: available }, 0)).toBe('no-frontiers');
    expect(classifyExplorationNoCandidateResult({ selectionReason: 'no-eligible-candidates', candidates: [], blacklistStatusCounts: available }, 0)).toBe('no-eligible-candidates');
    expect(classifyExplorationNoCandidateResult({ selectionReason: 'robot-out-of-bounds', candidates: [], blacklistStatusCounts: available }, 0)).toBe('robot-out-of-bounds');
    expect(classifyExplorationNoCandidateResult({ selectionReason: 'robot-not-free', candidates: [], blacklistStatusCounts: available }, 0)).toBe('robot-not-free');
    expect(classifyExplorationNoCandidateResult({ selectionReason: 'robot-insufficient-clearance', candidates: [], blacklistStatusCounts: available }, 0)).toBe('robot-insufficient-clearance');
    expect(classifyExplorationNoCandidateResult({ selectionReason: 'open-clearance-priority', candidates: [candidate], blacklistStatusCounts: available }, 0)).toBe('no-eligible-candidates');
    expect(classifyExplorationNoCandidateResult({ selectionReason: 'no-eligible-candidates', candidates: [], blacklistStatusCounts: coolingDown }, 0)).toBe('blacklist-cooldown');
    expect(classifyExplorationNoCandidateResult({ selectionReason: 'no-eligible-candidates', candidates: [], blacklistStatusCounts: exhausted }, 0)).toBe('no-eligible-candidates');
    expect(classifyExplorationNoCandidateResult({ selectionReason: 'no-eligible-candidates', candidates: [], blacklistStatusCounts: mixed }, 0)).toBe('blacklist-cooldown');
  });

  it('timestamps requested and observed command-owner events at the UI boundary', () => {
    interface CommandOwnerHarness {
      setNavigationControl(enabled: boolean, publish: boolean): void;
      dispatchAppEvent: (event: AppEvent, announceRejection?: boolean) => boolean;
      showNarration: (message: string) => void;
    }
    const dispatchAppEvent = vi.fn(() => true);
    const showNarration = vi.fn();
    const ui = Object.create(LearningUI.prototype) as CommandOwnerHarness;
    Object.assign(ui, { dispatchAppEvent, showNarration });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(456_789);

    ui.setNavigationControl(false, false);
    expect(dispatchAppEvent).toHaveBeenLastCalledWith({
      type: 'COMMAND_OWNER_OBSERVED',
      owner: 'manual',
      observedAtMs: 456_789,
    }, false);

    ui.setNavigationControl(true, true);
    expect(dispatchAppEvent).toHaveBeenLastCalledWith({
      type: 'COMMAND_OWNER_REQUESTED',
      owner: 'navigation',
      requestedAtMs: 456_789,
    }, true);
    expect(showNarration).toHaveBeenCalledOnce();
    clock.mockRestore();
  });

  it('shows the Gate wait state only before navigation acknowledgement', () => {
    const requestedAtMs = 1_000;
    const awaiting = {
      ...createInitialAppState(),
      pendingCommandOwner: { owner: 'navigation', requestedAtMs, expiresAtMs: requestedAtMs + 750, acknowledged: false } as const,
    };
    expect(commandOwnerAwaitingAcknowledgement(awaiting)).toBe(true);
    expect(commandOwnerAwaitingAcknowledgement({
      ...awaiting,
      pendingCommandOwner: { ...awaiting.pendingCommandOwner, acknowledged: true },
    })).toBe(false);
    expect(commandOwnerAwaitingAcknowledgement({ ...awaiting, pendingCommandOwner: null })).toBe(false);
  });
});
