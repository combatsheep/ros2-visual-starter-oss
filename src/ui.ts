import { applyPlanarTransform, closestStamped, createMapViewport, laserHitToWorld, makePose, navigationTransformFreshness, quaternionToYaw, robotMarkerDimensionsForViewport, selectMappingPose, transformOdomPoseToMap, viewportCanvasToWorld, worldToViewportCanvas, type MapViewport } from './navigationMap';
import { appPath } from './appPaths';
import { clonePlayground, createPlaygroundLibrary, DEFAULT_PLAYGROUND, getVisionTargetAssetById, getVisionTargetAssetByUrl, parsePlayground, parsePlaygroundLibrary, PLAYGROUND_LIBRARY_STORAGE_KEY, PLAYGROUND_STAGE_PRESETS, PLAYGROUND_STORAGE_KEY, PlaygroundHistory, snapToGrid, upsertPlaygroundLibrary, validateRobotClearance, VISION_TARGET_ASSETS, type PlaygroundDefinition, type PlaygroundObject, type PlaygroundObjectKind, type PlaygroundStageSize, type VisionTargetAssetId } from './playground';
import { analyzeFrontiers, createExplorationGoalVisitHistory, createFrontierHistory, createMapCornerGoalCandidates, createObjectSearchRoamingGoalCandidates, EXPLORATION_LOCAL_GOAL_HORIZON_METERS, filterUnvisitedGoalCandidates, getFrontierBlacklistStatus, planFrontierGoalSelection, recordExplorationGoalVisit, recordFrontierAttempt, selectObjectSearchRoamingCandidate, type ExplorationGoalVisitHistory, type FrontierAnalysis, type FrontierCandidate, type FrontierGrid, type FrontierHistory, type FrontierPoint } from './frontierExploration';
import { BackupActionStatusTracker, explorationDiversionEnabledFromStorage, selectExplorationDiversionCandidate } from './explorationDiversion';
import { createExplorationSweepProgress, EXPLORATION_COMPLETION_MIN_EXPLORED_RATIO, explorationCoverageAllowsCompletion, latchCornerSweepForCandidateExhaustion, observeExplorationSweepCoverage, recordExplorationGoalFailure as recordExplorationGoalFailureProgress, recordExplorationGoalSuccess, summarizeExplorationCoverage, summarizeExplorationCoverageFromOccupancyGrid, type ExplorationCoverage, type ExplorationSweepProgress } from './explorationCompletion';
import { assessExplorationMapStability } from './explorationStability';
import { adjustNavigationGoalForObstacleBeyond, type NavigationGoalObstacleKind } from './navigationGoal';
import { evaluateExplorationReadinessHealth, evaluateRuntimeRosGraphHealth } from './rosGraphHealth';
import { TransportAdapter, topicType } from './transport';
import { EXPLORATION_NO_CANDIDATE_CONFIRMATIONS_REQUIRED, EXPLORATION_POSE_FRESHNESS_MS, NAVIGATION_GOAL_CANCEL_SETTLE_MS, canAcceptManualMotion, canEnableNavigationControl, canPauseExploration, canQueryRosGraph, canResumeExploration, canSaveCurrentMap, canStartExploration, canStopExploration, createInitialAppState, currentRuntimeMode, explorationFreshnessUnavailableReason, explorationIsActive, explorationUnavailableReason, explorationUsesObjectSearchPolicy, isInteractionLocked, mapSaveUnavailableReason, objectSearchReadinessUnavailableReason, objectSearchStatusMessage, processingModalModel, runtimeManagerSnapshot, transitionAppState, type AppEffect, type AppEvent, type AppState, type ExplorationNoCandidateReason, type RuntimeManagerState } from './appState';
import { CameraInfoMessage, Detection2DArrayMessage, LaserScanMessage, OdometryMessage, TopicMessage, TopicName, TransportEvent, TwistMessage, ConnectionState, OccupancyGridMessage, PathMessage, PoseStampedMessage, PoseWithCovarianceStampedMessage, RuntimeMode, TfMessage, TransformStampedMessage, unwrapBool, unwrapString, type GoalStatusArrayMessage, type NavigationGoalError } from './types';
import { type CameraMode, Simulation, TRAINING_START_ROS_POSE } from './simulation';
import { clampSimTopCameraZoom, SIM_TOP_CAMERA_ZOOM_STEP } from './simCamera';
import { createStageImageId, getRegisteredStageImageByReference, isStageImageDimensionValid, listStoredStageImages, readStageImageDimensions, registerStageImage, stageImageDimensionError, stageImageFormatForFile, storeStageImage, STAGE_IMAGE_UPLOAD_OPTION, type RegisteredStageImage, type StoredStageImage } from './stageImages';
import { lidarVisibleScanIndex, SIM_LIDAR_RAY_COUNT, SIM_LIDAR_VISIBLE_RAY_COUNT } from './lidarSampling';
import { combineDetectionsWithDepth, depthToPseudoColor, rosTimeToMilliseconds, sampleDetectionDepth, type DetectionWithDistance, type VisionFrame } from './vision';
import { applyObjectSearchIntent, createObjectSearchChatState, submitObjectSearchText, synchronizeObjectSearchChat, type ObjectSearchChatResult, type ObjectSearchChatState } from './objectSearchChat';
import { APPLE_POSTSTOP_REQUIRED_HITS, APPLE_POSTSTOP_WINDOW_FRAMES, APPLE_PRESTOP_REQUIRED_HITS, APPLE_PRESTOP_WINDOW_FRAMES, type AppleDetectionInput } from './objectSearchDetection';
import { planAppleApproachGoal } from './objectSearchApproach';
import { routeObjectSearchIntent } from './objectSearchIntent';
import { beginLocalLlmRequest, createLocalLlmRequestGuard, invalidateLocalLlmRequest, LOCAL_LLM_MODEL_LABEL, LOCAL_LLM_REQUEST_TIMEOUT_MS, localLlmRequestIsPending, parseLocalLlmStatus, resolveLocalLlmResult, type LocalLlmIntentName, type LocalLlmRequestGuard, type LocalLlmStatusEnvelope } from './localLlmIntent';

const formatNumber = (value: number, digits = 2): string => Number.isFinite(value) ? value.toFixed(digits) : '∞';
const EXPLORATION_EVALUATION_INTERVAL_MS = 750;
const EXPLORATION_WAIT_COOLDOWN_MS = 1200;
const EXPLORATION_DIVERSION_STORAGE_KEY = 'ros2-visual-starter-exploration-diversion-v2';
const TABLET_CONTROL_DOCK_POSITION_STORAGE_KEY = 'ros2-visual-starter-tablet-control-dock-position-v1';
const TABLET_CONTROL_DOCK_HIDDEN_STORAGE_KEY = 'ros2-visual-starter-tablet-control-dock-hidden-v1';
const LOCAL_LLM_THINKING_MESSAGE = 'LOCAL LLMで考えています…';
const GOAL_OBSTACLE_LABELS: Record<NavigationGoalObstacleKind, string> = {
  occupied: '壁・障害物',
  unknown: '未観測領域',
  'map-boundary': '地図端',
};

export interface TabletControlDockPosition {
  left: number;
  top: number;
}

export function clampTabletControlDockPosition(
  position: TabletControlDockPosition,
  viewport: { width: number; height: number },
  dock: { width: number; height: number },
  margin = 8,
): TabletControlDockPosition {
  const maxLeft = Math.max(margin, viewport.width - dock.width - margin);
  const maxTop = Math.max(margin, viewport.height - dock.height - margin);
  return {
    left: Math.max(margin, Math.min(maxLeft, position.left)),
    top: Math.max(margin, Math.min(maxTop, position.top)),
  };
}

function readTabletControlDockPosition(): TabletControlDockPosition | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(TABLET_CONTROL_DOCK_POSITION_STORAGE_KEY) ?? 'null');
    if (typeof parsed !== 'object' || parsed === null) return null;
    const position = parsed as Partial<TabletControlDockPosition>;
    return Number.isFinite(position.left) && Number.isFinite(position.top)
      ? { left: Number(position.left), top: Number(position.top) }
      : null;
  } catch {
    return null;
  }
}

function readTabletControlDockHidden(): boolean {
  try { return localStorage.getItem(TABLET_CONTROL_DOCK_HIDDEN_STORAGE_KEY) === 'true'; } catch { return false; }
}

function occupancyGridForGoalSelection(map: OccupancyGridMessage): FrontierGrid {
  const origin = map.info.origin;
  return {
    width: map.info.width,
    height: map.info.height,
    resolution: map.info.resolution,
    origin: { x: origin.position.x, y: origin.position.y, yaw: quaternionToYaw(origin.orientation) },
    data: map.data,
  };
}

export function classifyExplorationNoCandidateResult(
  analysis: Pick<FrontierAnalysis, 'selectionReason' | 'candidates' | 'blacklistStatusCounts'>,
  eligibleCandidateCount: number,
): ExplorationNoCandidateReason {
  if (analysis.selectionReason === 'robot-out-of-bounds'
    || analysis.selectionReason === 'robot-not-free'
    || analysis.selectionReason === 'robot-insufficient-clearance') return analysis.selectionReason;
  const exactBlacklistRemovedCandidate = eligibleCandidateCount < analysis.candidates.length;
  if (analysis.blacklistStatusCounts.cooldown > 0) return 'blacklist-cooldown';
  if (exactBlacklistRemovedCandidate || analysis.blacklistStatusCounts['max-attempts'] > 0) {
    return 'no-eligible-candidates';
  }
  return analysis.selectionReason === 'no-frontiers' ? 'no-frontiers' : 'no-eligible-candidates';
}

export function commandOwnerAwaitingAcknowledgement(state: Pick<AppState, 'pendingCommandOwner'>): boolean {
  return state.pendingCommandOwner?.owner === 'navigation' && !state.pendingCommandOwner.acknowledged;
}

export interface ExplorationControlCopy {
  chipLabel: string;
  resumeLabel: string;
  stopLabel: string;
  stopTitle: string;
}

export function explorationControlCopy(
  status: AppState['exploration']['status'],
  coverageReached = false,
  objectSearchActive = false,
): ExplorationControlCopy {
  if (status === 'error') {
    return {
      chipLabel: '探索エラー',
      resumeLabel: 'エラーから再開',
      stopLabel: 'エラー状態を終了',
      stopTitle: '探索エラーを完了扱いにせず、安全停止済みのrunを終了します',
    };
  }
  if (status === 'completed') {
    return {
      chipLabel: 'COMPLETED',
      resumeLabel: '再開',
      stopLabel: '終了',
      stopTitle: '完了条件を確認した探索を終了します',
    };
  }
  const unfinished = status === 'evaluating'
    || status === 'sending'
    || status === 'moving'
    || status === 'replanning'
    || status === 'paused';
  const finishable = unfinished && coverageReached && !objectSearchActive;
  return {
    chipLabel: status.toUpperCase(),
    resumeLabel: '再開',
    stopLabel: finishable ? '終了' : unfinished ? '探索を中止' : '終了',
    stopTitle: finishable
      ? '観測済み領域が90%以上に達したため、goalを取消して探索を終了できます'
      : unfinished
        ? '探索を完了扱いにせず、安全にgoalを取消して終了します'
      : '',
  };
}

const KIND_LABELS: Record<PlaygroundObjectKind, string> = { wall: '壁', box: '箱', gate: 'Gate', vision_target: '画像パネル' };
const HANDLE_HIT_RADIUS = 18;
const HEIGHT_HANDLE_OFFSET_PX = 20;
const DUPLICATE_OFFSET_X = .6;

interface FootprintCorner { x: number; z: number }

function footprintCorners(object: PlaygroundObject): [FootprintCorner, FootprintCorner, FootprintCorner, FootprintCorner] {
  const cosine = Math.cos(object.rotation);
  const sine = Math.sin(object.rotation);
  const halfWidth = object.size.width / 2;
  const halfDepth = object.size.depth / 2;
  const local: Array<[number, number]> = [[-halfWidth, -halfDepth], [halfWidth, -halfDepth], [halfWidth, halfDepth], [-halfWidth, halfDepth]];
  return local.map(([lx, lz]) => ({ x: object.position.x + lx * cosine + lz * sine, z: object.position.z - lx * sine + lz * cosine })) as [FootprintCorner, FootprintCorner, FootprintCorner, FootprintCorner];
}

function clampPosition(x: number, z: number, bounds: number): { x: number; z: number } {
  return { x: Math.max(-bounds, Math.min(bounds, x)), z: Math.max(-bounds, Math.min(bounds, z)) };
}

function clampRange(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function playgroundDefaults(kind: PlaygroundObjectKind, count: number, visionTargetAssetId: VisionTargetAssetId = 'yolox-dog'): Omit<PlaygroundObject, 'id' | 'kind'> {
  const selectedVisionAsset = getVisionTargetAssetById(visionTargetAssetId) ?? VISION_TARGET_ASSETS.yoloxDog;
  const defaults: Record<PlaygroundObjectKind, Omit<PlaygroundObject, 'id' | 'kind'>> = {
    wall: { label: `追加した壁 ${count}`, position: { x: 2.8, z: 0 }, rotation: Math.PI / 2, size: { width: 2, height: 1, depth: .15 }, color: '#95c9bd' },
    box: { label: `追加した箱 ${count}`, position: { x: 2, z: 1.2 }, rotation: 0, size: { width: .8, height: .65, depth: .8 }, color: '#e88d46' },
    gate: { label: `追加したGate ${count}`, position: { x: -2, z: .2 }, rotation: 0, size: { width: 1.2, height: 1.2, depth: .12 }, color: '#a3b9ec' },
    vision_target: { label: `${selectedVisionAsset.label} ${count}`, position: { x: 0, z: -2.8 }, rotation: 0, size: { width: 1.6, height: 1.2, depth: .05 }, color: '#ffffff', asset: selectedVisionAsset.url },
  };
  return defaults[kind];
}

interface SavedMapSummary { name: string; modifiedMs: number }
/** Initial pose in the saved map frame; the SIM robot itself stays in odom coordinates. */
interface MapLibraryStartPose { x: number; y: number; yaw: number }
interface MapLibraryState { maps: SavedMapSummary[]; selected: string | null; startPose?: MapLibraryStartPose | null; defaultMap?: boolean; status: string; error: string }
interface ExplorationTaskCandidateSnapshot {
  candidate: FrontierCandidate;
  mapGeneration: number;
  knownCellCount: number;
}
export type { RuntimeManagerState } from './appState';

interface StageGesture {
  kind: 'move' | 'resize' | 'rotate' | 'resizeHeight';
  id: string;
  snapshot: PlaygroundDefinition;
  offsetX: number;
  offsetZ: number;
  anchorX: number;
  anchorZ: number;
  cornerSignX: number;
  cornerSignZ: number;
  centerX: number;
  centerZ: number;
  startPointerAngle: number;
  startRotation: number;
  startClientY: number;
  lastX: number;
  lastZ: number;
  lastRotation: number;
  lastWidth: number;
  lastHeight: number;
  lastDepth: number;
}

const HEIGHT_HANDLE = 4;

function normalizeAngle(rotation: number): number {
  let degrees = rotation * 180 / Math.PI;
  degrees = ((degrees % 360) + 540) % 360 - 180;
  return Number((degrees * Math.PI / 180).toFixed(6));
}

interface StageCameraDrag {
  kind: 'orbit' | 'pan' | 'planPan';
  lastX: number;
  lastY: number;
}

interface StageImageOption {
  value: string;
  reference: string;
  label: string;
  expectedClasses: readonly string[];
}

export class LearningUI {
  private readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly simShell: HTMLElement;
  private readonly stageShell: HTMLElement;
  private readonly stageHandles: HTMLElement;
  private readonly lidarCanvas: HTMLCanvasElement;
  private readonly raySelection: HTMLElement;
  private readonly narration: HTMLElement;
  private readonly processingModal: HTMLElement;
  private readonly processingModalTitle: HTMLElement;
  private readonly processingModalDetail: HTMLElement;
  private readonly processingModalStatus: HTMLElement;
  private readonly stageImageErrorModal: HTMLElement;
  private readonly stageImageErrorDetail: HTMLElement;
  private readonly stageImageErrorClose: HTMLButtonElement;
  private readonly stageImageUploadFile: HTMLInputElement;
  private readonly transportLabel: HTMLElement;
  private readonly inspectorTopic: HTMLElement;
  private readonly friendlyMessage: HTMLElement;
  private readonly rawMessage: HTMLElement;
  private readonly mapCanvas: HTMLCanvasElement;
  private readonly mapEmpty: HTMLElement;
  private readonly rgbCameraCanvas: HTMLCanvasElement;
  private readonly depthCameraCanvas: HTMLCanvasElement;
  private readonly detectionOverlay: HTMLCanvasElement;
  private readonly tabletControlDock: HTMLElement;
  private readonly tabletControlDockHandle: HTMLButtonElement;
  private readonly tabletControlDockOpen: HTMLButtonElement;
  private readonly eventLog = new Map<TopicName, TopicMessage>();
  private selectedTopic: TopicName = '/cmd_vel';
  private simulation: Simulation | null = null;
  private transport: TransportAdapter | null = null;
  private controlLeaseOwner = true;
  private requestControlLease: (() => Promise<boolean>) | null = null;
  private occupancyMap: OccupancyGridMessage | null = null;
  private currentPose: PoseStampedMessage | null = null;
  private latestOdomPose: PoseStampedMessage | null = null;
  private latestAmclPose: PoseStampedMessage | null = null;
  private latestSlamPose: PoseStampedMessage | null = null;
  private latestMapToOdom: TransformStampedMessage | null = null;
  private readonly odomHistory: PoseStampedMessage[] = [];
  private readonly mapToOdomHistory: TransformStampedMessage[] = [];
  private goalPose: PoseStampedMessage | null = null;
  private globalPath: PathMessage | null = null;
  private localPath: PathMessage | null = null;
  private latestScan: LaserScanMessage | null = null;
  private readonly mapRaster = document.createElement('canvas');
  private mapCanvasResizeObserver: ResizeObserver | null = null;
  private mapViewport: MapViewport | null = null;
  private mapZoom = 1;
  private mapRasterDirty = false;
  private navigationDrawFrame: number | null = null;
  private frontierAnalysis: FrontierAnalysis | null = null;
  private explorationCoverage: ExplorationCoverage | null = null;
  private explorationSweepProgress: ExplorationSweepProgress = createExplorationSweepProgress();
  private explorationGoalVisitHistory: ExplorationGoalVisitHistory = createExplorationGoalVisitHistory();
  private frontierAnalysisMap: OccupancyGridMessage | null = null;
  private frontierHistory: FrontierHistory = createFrontierHistory();
  private explorationMapGeneration = 0;
  private frontierAnalysisMapGeneration = 0;
  private explorationEvaluationTimer: number | null = null;
  private explorationWaitTimer: number | null = null;
  private explorationLastEvaluationAt = 0;
  private latestMapReceivedAt = 0;
  private latestExplorationPoseAt = 0;
  private explorationEvidenceNotBeforeMs = 0;
  private explorationLastReason = 'なし';
  private readonly explorationMapSnapshots = new Map<number, OccupancyGridMessage>();
  private readonly explorationCandidateByTask = new Map<number, ExplorationTaskCandidateSnapshot>();
  private readonly explorationTasksWithStaleTransform = new Set<number>();
  private backupActionStatusTracker = new BackupActionStatusTracker();
  private readonly backupTaskByGoalId = new Map<string, number>();
  private explorationDiversionEnabled = explorationDiversionEnabledFromStorage(localStorage.getItem(EXPLORATION_DIVERSION_STORAGE_KEY));
  private explorationDiversionAnchor: FrontierPoint | null = null;
  private pendingBackupDiversionTaskId: number | null = null;
  private safetyStopped = false;
  private appState: AppState = createInitialAppState();
  private requestRuntimeMode: ((mode: RuntimeMode) => Promise<boolean>) | null = null;
  private releaseUserInput: (() => void) | null = null;
  private renderedRuntimeMode: RuntimeMode | null = null;
  private rayCount = SIM_LIDAR_RAY_COUNT;
  private cameraMode: CameraMode = 'follow';
  private simTopCameraZoom = 1;
  private missions = new Set<string>(JSON.parse(localStorage.getItem('ros2-visual-starter-missions') ?? '[]') as string[]);
  private missingGraphChecks = 0;
  private explorationGraphFailureChecks = 0;
  private rosGraphRequestGeneration = 0;
  private readonly flowAnimationAt = new Map<string, number>();
  private savedMapNames = new Set<string>();
  private mapSaveInProgress = false;
  private pendingSavedMap: { name: string; overwrite: boolean } | null = null;
  private lastMapSaveMessage = '';
  private latestVisionFrame: VisionFrame | null = null;
  private latestDetections: Detection2DArrayMessage | null = null;
  private yoloConnected = false;
  private objectSearchChat: ObjectSearchChatState = createObjectSearchChatState();
  private localLlmStatus: LocalLlmStatusEnvelope = {
    schema_version: 1,
    state: 'initializing',
    provider: 'local_llm',
    model_label: LOCAL_LLM_MODEL_LABEL,
    model_id: '',
    busy: false,
    last_latency_ms: 0,
    error: '',
  };
  private localLlmRequest: LocalLlmRequestGuard = createLocalLlmRequestGuard();
  private localLlmRequestTimer: number | null = null;
  private localLlmRequestAbort: AbortController | null = null;
  private objectSearchInputComposing = false;
  private objectSearchAdvanceQueued = false;
  private objectSearchSafeStopQueued = false;
  private objectSearchHealthTimer: number | null = null;
  private lastAppEventRejection = '';
  private playground = clonePlayground(DEFAULT_PLAYGROUND);
  private playgroundLibrary = createPlaygroundLibrary();
  private playgroundNameDraft = DEFAULT_PLAYGROUND.name;
  private readonly playgroundHistory = new PlaygroundHistory();
  private uploadedStageImages: RegisteredStageImage[] = [];
  private selectedPlaygroundId = DEFAULT_PLAYGROUND.objects[0].id;
  private snapEnabled = true;
  private armedPlacement: PlaygroundObjectKind | null = null;
  private armedVisionTargetAssetId: VisionTargetAssetId = 'yolox-dog';
  private editTool: 'move' | 'rotate' = 'move';
  private gesture: StageGesture | null = null;
  private cameraDrag: StageCameraDrag | null = null;
  private spaceDown = false;
  private readonly stageFlyKeys = new Set<string>();
  private activePointerId = -1;
  private tabletControlDockVisible = !readTabletControlDockHidden();
  private tabletControlDockPosition = readTabletControlDockPosition();

  constructor(root: HTMLElement, canvas: HTMLCanvasElement) {
    this.root = root;
    this.canvas = canvas;
    root.setAttribute('data-view', 'sim');
    this.simShell = this.find('#scene-shell');
    this.stageShell = this.find('#stage-shell');
    this.stageHandles = this.find('#stage-handles');
    this.lidarCanvas = this.find<HTMLCanvasElement>('#lidar-canvas');
    this.raySelection = this.find('#ray-selection');
    this.narration = this.find('#narration');
    this.processingModal = this.find('#processing-modal');
    this.processingModalTitle = this.find('#processing-modal-title');
    this.processingModalDetail = this.find('#processing-modal-detail');
    this.processingModalStatus = this.find('#processing-modal-status');
    this.stageImageErrorModal = this.find('#stage-image-error-modal');
    this.stageImageErrorDetail = this.find('#stage-image-error-detail');
    this.stageImageErrorClose = this.find<HTMLButtonElement>('#stage-image-error-close');
    this.stageImageUploadFile = this.find<HTMLInputElement>('#stage-image-upload-file');
    this.transportLabel = this.find('#transport-label');
    this.inspectorTopic = this.find('#inspector-topic');
    this.friendlyMessage = this.find('#friendly-message');
    this.rawMessage = this.find('#raw-message');
    this.mapCanvas = this.find<HTMLCanvasElement>('#map-canvas');
    this.mapEmpty = this.find('#map-empty');
    this.rgbCameraCanvas = this.find<HTMLCanvasElement>('#rgb-camera-canvas');
    this.depthCameraCanvas = this.find<HTMLCanvasElement>('#depth-camera-canvas');
    this.detectionOverlay = this.find<HTMLCanvasElement>('#detection-overlay');
    this.tabletControlDock = this.find('#tablet-control-dock');
    this.tabletControlDockHandle = this.find<HTMLButtonElement>('#tablet-control-dock-handle');
    this.tabletControlDockOpen = this.find<HTMLButtonElement>('#tablet-control-dock-open');
    this.observeMapCanvasResize();
    this.bindThemeToggle();
    this.bindInspectorTabs();
    this.bindMissions();
    this.bindGlossary();
    this.bindLidarSelection();
    this.bindTabletControlDock();
    this.bindNavigationControls();
    this.bindExplorationControls();
    this.bindVisionControls();
    this.bindObjectSearchChat();
    this.bindViewTabs();
    this.bindStageImageErrorModal();
    this.bindStageEditorControls();
    this.bindStageCanvasEvents();
    this.renderNavigationControlButtons();
    this.updateTabletControlDockPresentation();
    this.renderStateBoundarySummary();
    this.renderExplorationControls();
    this.renderObjectSearchChat();
    this.renderMissionProgress();
    void this.refreshLocalLlmStatus();
    window.setInterval(() => void this.refreshLocalLlmStatus(), 5_000);
    void this.hydrateUploadedStageImages();
  }

  private find<T extends HTMLElement = HTMLElement>(selector: string): T { const element = this.root.querySelector<T>(selector); if (!element) throw new Error(`UI element not found: ${selector}`); return element; }

  private observeMapCanvasResize(): void {
    const redraw = (): void => {
      if (this.syncNavigationCanvasResolution()) this.scheduleNavigationMap();
    };
    if (typeof ResizeObserver === 'function') {
      this.mapCanvasResizeObserver = new ResizeObserver(redraw);
      this.mapCanvasResizeObserver.observe(this.mapCanvas);
    } else {
      window.addEventListener('resize', redraw);
    }
    redraw();
  }

  private syncNavigationCanvasResolution(): boolean {
    const rect = this.mapCanvas.getBoundingClientRect();
    const deviceScale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const width = Math.max(1, Math.round(rect.width * deviceScale));
    const height = Math.max(1, Math.round(rect.height * deviceScale));
    if (this.mapCanvas.width === width && this.mapCanvas.height === height) return false;
    this.mapCanvas.width = width;
    this.mapCanvas.height = height;
    return true;
  }

  private bindThemeToggle(): void {
    const button = this.find<HTMLButtonElement>('#theme-toggle');
    const html = document.documentElement;
    const render = (theme: 'dark' | 'light'): void => {
      html.dataset.theme = theme;
      button.setAttribute('aria-pressed', String(theme === 'dark'));
      button.textContent = theme === 'dark' ? '☀️ ライト' : '🌙 ダーク';
      button.title = theme === 'dark' ? 'ライトモードへ切り替え' : 'ダークモードへ切り替え';
    };
    const initialTheme: 'dark' | 'light' = html.dataset.theme === 'light' || localStorage.getItem('ros2-visual-starter-theme') === 'light' ? 'light' : 'dark';
    render(initialTheme);
    button.addEventListener('click', () => {
      const nextTheme: 'dark' | 'light' = html.dataset.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem('ros2-visual-starter-theme', nextTheme);
      render(nextTheme);
    });
  }

  private get runtimeMode(): RuntimeMode { return currentRuntimeMode(this.appState); }
  private get connectionState(): ConnectionState { return this.appState.transport; }
  private get runtimeManagerState(): RuntimeManagerState { return runtimeManagerSnapshot(this.appState); }
  private get activeView(): 'sim' | 'stage' { return this.appState.view.mode; }
  private get stageView(): 'plan' | 'orbit' { return this.appState.view.mode === 'stage' ? this.appState.view.surface : 'plan'; }

  private isInteractionLocked(): boolean { return isInteractionLocked(this.appState); }

  private canEnableNavigationControl(): boolean {
    return this.hasRuntimeControl() && canEnableNavigationControl(this.appState);
  }

  private canAcceptManualMotion(): boolean {
    return this.hasRuntimeControl() && canAcceptManualMotion(this.appState);
  }

  private hasRuntimeControl(): boolean { return this.runtimeMode === 'sim' || this.controlLeaseOwner; }

  private renderNavigationControlButtons(): void {
    const navigationButton = this.find<HTMLButtonElement>('#navigation-mode-button');
    const manualButton = this.find<HTMLButtonElement>('#manual-mode-button');
    const readOnly = !this.hasRuntimeControl();
    const explorationActive = this.appState.exploration.status === 'evaluating'
      || this.appState.exploration.status === 'sending'
      || this.appState.exploration.status === 'moving'
      || this.appState.exploration.status === 'replanning';
    const explorationPaused = this.appState.exploration.status === 'paused';
    const objectSearchReserved = this.appState.objectSearch.status !== 'idle' && this.appState.objectSearch.status !== 'canceled';
    const available = this.canEnableNavigationControl() && !explorationActive && !explorationPaused && !objectSearchReserved;
    const commandOwnerPending = commandOwnerAwaitingAcknowledgement(this.appState);
    navigationButton.disabled = !available;
    navigationButton.setAttribute('aria-disabled', String(!available));
    navigationButton.toggleAttribute('aria-busy', commandOwnerPending);
    navigationButton.title = commandOwnerPending
      ? 'Command Gateのnavigation owner応答を待っています'
      : available
      ? 'Nav2へ切り替えた後、地図の白い場所をクリックして目標を送ります'
      : objectSearchReserved
        ? 'Object Search Mission中はFrontier ExplorationがNav2経路を使用します。先に探索を中止してください'
      : explorationActive
        ? '探索中はoperatorのNav2操作へ切り替えられません。先に探索を一時停止してください'
        : explorationPaused
          ? '探索を続ける場合は「再開」、operatorのNav2目標を使う場合は探索を「終了」してください'
        : 'NAV2 activated後、初期化と自機位置の同期が完了すると使用できます';
    navigationButton.textContent = objectSearchReserved
      ? 'Object SearchがNav2を予約中'
      : explorationActive
      ? '探索がNav2を使用中'
      : explorationPaused
        ? '探索は「再開」で続行'
        : 'Nav2操作にする';
    manualButton.disabled = readOnly || this.isInteractionLocked() || this.activeView !== 'sim' || (this.connectionState !== 'CONNECTED' && this.connectionState !== 'SIMULATED');
    manualButton.classList.toggle('active', this.appState.command.owner === 'manual');
    navigationButton.classList.toggle('active', this.appState.command.owner === 'navigation');
    this.find<HTMLButtonElement>('#reset-map-button').disabled = readOnly;
    this.find<HTMLButtonElement>('#cancel-goal-button').disabled = readOnly;
    this.find<HTMLButtonElement>('#reset-button').disabled = readOnly;
    this.root.querySelectorAll<HTMLButtonElement>('[data-reset-origin]').forEach((button) => {
      button.disabled = readOnly || this.isInteractionLocked();
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-control]').forEach((button) => {
      const isStop = button.dataset.control === 'stop';
      button.disabled = readOnly || (!isStop && !this.canAcceptManualMotion());
    });
  }

  private renderExplorationControls(): void {
    const exploration = this.appState.exploration;
    const prepare = this.find<HTMLButtonElement>('#prepare-exploration-button');
    const start = this.find<HTMLButtonElement>('#start-exploration-button');
    const pause = this.find<HTMLButtonElement>('#pause-exploration-button');
    const resume = this.find<HTMLButtonElement>('#resume-exploration-button');
    const stop = this.find<HTMLButtonElement>('#stop-exploration-button');
    const diversionToggle = this.find<HTMLButtonElement>('#exploration-diversion-toggle');
    const runtimeReady = this.appState.runtime.status === 'stable' && this.appState.runtime.mode === 'exploration';
    const readinessReady = runtimeReady && this.appState.map.status === 'ready' && this.appState.map.mode === 'exploration';
    const preparing = this.appState.runtime.status === 'switching' && this.appState.runtime.target === 'exploration';
    const objectSearchMissionStatus = this.appState.objectSearch.status;
    const objectSearchActive = explorationUsesObjectSearchPolicy(exploration)
      && objectSearchMissionStatus !== 'idle'
      && objectSearchMissionStatus !== 'canceled'
      && objectSearchMissionStatus !== 'succeeded'
      && objectSearchMissionStatus !== 'not_found';
    const readOnly = !this.hasRuntimeControl();
    prepare.disabled = readOnly || preparing || runtimeReady || this.appState.runtime.status === 'switching';
    prepare.textContent = preparing ? '探索構成を準備中…' : readinessReady ? '探索構成 ready' : runtimeReady ? '探索構成を初期化中…' : '探索構成を準備';
    prepare.setAttribute('aria-pressed', String(readinessReady));
    prepare.title = readinessReady ? 'Online SLAM＋Nav2のexploration runtimeがreadyです' : runtimeReady ? 'live map・SLAM pose・Nav2 Actionの準備完了を待っています' : preparing ? 'SLAM ToolboxとNav2の起動完了を待っています' : '保存地図を読まず、新しいonline mapで探索構成を起動します';

    const freshness = { mapGeneration: this.explorationMapGeneration, nowMs: Date.now() };
    const baseUnavailable = explorationUnavailableReason(this.appState);
    const freshnessUnavailable = explorationFreshnessUnavailableReason(this.appState, freshness);
    const unavailable = baseUnavailable ?? ((exploration.status === 'idle'
      || exploration.status === 'paused'
      || exploration.status === 'completed'
      || exploration.status === 'error') ? freshnessUnavailable : null);
    start.disabled = readOnly || !canStartExploration(this.appState, freshness);
    pause.disabled = readOnly || !canPauseExploration(this.appState);
    resume.disabled = readOnly || !canResumeExploration(this.appState, freshness);
    stop.disabled = readOnly || !canStopExploration(this.appState);
    const coverageReached = this.explorationCoverage !== null
      && explorationCoverageAllowsCompletion(this.explorationCoverage.exploredRatio);
    const controlCopy = explorationControlCopy(exploration.status, coverageReached, objectSearchActive);
    resume.textContent = controlCopy.resumeLabel;
    stop.textContent = controlCopy.stopLabel;
    diversionToggle.disabled = readOnly;
    diversionToggle.classList.toggle('active', this.explorationDiversionEnabled);
    diversionToggle.setAttribute('aria-pressed', String(this.explorationDiversionEnabled));
    diversionToggle.textContent = `BackUp後変更 ${this.explorationDiversionEnabled ? 'ON' : 'OFF'}`;
    diversionToggle.title = this.explorationDiversionEnabled
      ? 'BackUp成功後に現在goalを取消し、離れたfrontierへ切り替えます。OFFで従来の同一goal再計画へ戻せます'
      : '現在はBackUp後もNav2の同一goal再計画を続けます。ONで遠方frontierへの切替を有効にします';
    start.title = start.disabled ? unavailable ?? '現在の探索を終了してから開始してください' : 'fresh mapからfrontierを評価して探索を開始します';
    pause.title = pause.disabled ? '走行または候補評価中に使用できます' : 'goalを取消し、手動ownerと速度0へ戻します';
    resume.title = resume.disabled
      ? unavailable ?? '一時停止中または探索エラーのrunだけ再開できます'
      : exploration.status === 'error'
        ? 'blacklistを保持し、現在のfresh live mapとposeから安全な別候補を評価します'
        : '現在のfresh live mapを再評価し、停止前goalを直接再送せず探索を続けます';
    stop.title = stop.disabled ? '開始済みの探索はありません' : controlCopy.stopTitle;

    const chip = this.find('#exploration-state-chip');
    chip.textContent = controlCopy.chipLabel;
    chip.className = `exploration-state-chip ${exploration.status}`;
    const thinking = this.find<HTMLElement>('#exploration-thinking');
    const explorationActive = explorationIsActive(exploration);
    const thinkingLabel = exploration.status === 'replanning'
      ? '回避後の位置、地図、または別の目標を再検討中'
      : exploration.status === 'evaluating'
        ? 'frontier候補と安全な目標を評価中'
        : exploration.status === 'sending'
          ? '選択した目標をNav2へ送信中'
          : 'Nav2で探索走行中';
    thinking.hidden = !explorationActive;
    thinking.className = `exploration-thinking ${exploration.status}`;
    thinking.setAttribute('aria-label', thinkingLabel);
    thinking.title = exploration.status === 'replanning'
      ? '回避後のpose、fresh map、または別のfrontier goalを再評価しています'
      : exploration.status === 'evaluating'
        ? 'frontier候補と安全なgoalを評価しています'
        : exploration.status === 'sending'
          ? '選択したgoalをNav2へ送信しています'
          : 'Nav2で探索を継続しています';
    const pauseReasons: Record<string, string> = {
      user: 'ユーザー操作で一時停止しました。',
      'origin-reset': '初期位置へ戻したため一時停止しました。',
      'manual-override': '手動overrideで一時停止しました。',
      'operator-conflict': 'operator goalとの競合を避けて一時停止しました。',
      'safety-stop': 'Safety stopを検知して一時停止しました。',
      'navigation-unavailable': 'Nav2構成がreadyでなくなったため一時停止しました。',
      'control-lease': '別の画面へ操作権が移ったため一時停止しました。',
      vision: 'Visionのfreshな応答を確認できないため一時停止しました。',
      stage: 'STAGE入場により一時停止しました。',
      'runtime-change': 'runtime切替により一時停止しました。',
      transport: 'Transport切断により一時停止しました。',
    };
    const reason = exploration.status === 'paused'
      ? `${pauseReasons[exploration.reason] ?? '探索を一時停止しました。'} 再開するとfresh mapから候補を選び直します。`
      : exploration.status === 'completed'
        ? `freeと障害物を合わせた観測済み領域が${Math.round(EXPLORATION_COMPLETION_MIN_EXPLORED_RATIO * 100)}%以上になり、3枚のfresh mapで到達可能な安全frontier goalがないことを確認しました。地図を保存するか探索を終了できます。`
        : exploration.status === 'error'
          ? `探索エラー: ${exploration.message}`
          : unavailable
            ?? (exploration.status === 'idle'
              ? '準備完了です。「探索開始」でfrontier評価を始めます。'
              : exploration.status === 'evaluating'
                ? 'known free領域だけで到達性、clearance、情報利得、経路距離を評価しています。'
                : exploration.status === 'replanning'
                  ? '速度0を確認し、次のfresh mapまたはcooldown後に再計画します。'
                  : '選択したfrontier goalを既存NavigateToPose ActionとCommand Gateへ渡しています。');
    this.find('#exploration-reason').textContent = reason;

    const retryCount = exploration.status === 'idle' ? 0 : exploration.retryCount;
    const replanCount = exploration.status === 'idle' ? 0 : exploration.replanCount;
    const candidateCount = this.frontierAnalysis?.candidates.length ?? 0;
    const knownCellCount = this.frontierAnalysis?.knownCellCount ?? 0;
    const exploredCoverage = this.explorationCoverage ? `${Math.round(this.explorationCoverage.exploredRatio * 100)}%` : '--';
    this.find('#exploration-metrics').textContent = `${candidateCount}候補 / ${knownCellCount} cells / 探索済み ${exploredCoverage} / 再計画 ${replanCount}回 / 失敗 ${retryCount}回`;
    const exploredCoveragePercent = this.explorationCoverage ? Math.round(this.explorationCoverage.exploredRatio * 100) : null;
    const completionTargetPercent = Math.round(EXPLORATION_COMPLETION_MIN_EXPLORED_RATIO * 100);
    const coverageSatisfied = exploredCoveragePercent !== null && exploredCoveragePercent >= completionTargetPercent;
    const coverageCompletionEligible = coverageSatisfied && !objectSearchActive;
    const confirmationCount = exploration.status === 'idle'
      ? 0
      : Math.min(exploration.noCandidateConfirmations, EXPLORATION_NO_CANDIDATE_CONFIRMATIONS_REQUIRED);
    const progress = this.find<HTMLElement>('#exploration-coverage-progress');
    const progressFill = this.find<HTMLElement>('#exploration-coverage-progress-fill');
    const progressMarker = this.find<HTMLElement>('#exploration-coverage-target-marker');
    const progressPanel = this.find<HTMLElement>('#exploration-coverage');
    this.find('#exploration-coverage-current').textContent = exploredCoveragePercent === null ? '--%' : `${exploredCoveragePercent}%`;
    this.find('#exploration-coverage-target').textContent = objectSearchActive ? 'Object Searchでは未使用' : `${completionTargetPercent}%以上`;
    progressFill.style.width = `${exploredCoveragePercent ?? 0}%`;
    progressMarker.style.left = `${completionTargetPercent}%`;
    progressMarker.hidden = objectSearchActive;
    progress.setAttribute('aria-valuenow', String(exploredCoveragePercent ?? 0));
    progress.setAttribute('aria-valuetext', exploredCoveragePercent === null
      ? '探索率はまだ取得できていません'
      : objectSearchActive
        ? `観測済み${exploredCoveragePercent}%（Object Searchは地図全域の完了判定を使用しません）`
        : `観測済み${exploredCoveragePercent}%、終了目安${completionTargetPercent}%以上`);
    progressPanel.classList.toggle('coverage-met', coverageCompletionEligible);
    progressPanel.classList.toggle('completed', exploration.status === 'completed');
    const progressStatus = exploredCoveragePercent === null
      ? 'live map受信後に探索率を表示します。'
      : objectSearchActive
        ? 'Object Search中は地図全域の完了判定を使わず、物体検出までfrontierまたは既知領域の安全な巡回を続けます。'
        : !coverageSatisfied
          ? `面積条件まであと${completionTargetPercent - exploredCoveragePercent}ポイントです。`
          : exploration.status === 'completed'
            ? `終了条件達成：安全な探索goalなしをfresh mapで${EXPLORATION_NO_CANDIDATE_CONFIRMATIONS_REQUIRED}/${EXPLORATION_NO_CANDIDATE_CONFIRMATIONS_REQUIRED}回確認しました。`
            : confirmationCount > 0
              ? `面積条件達成・安全な探索goalなしをfresh mapで${confirmationCount}/${EXPLORATION_NO_CANDIDATE_CONFIRMATIONS_REQUIRED}回確認中です。`
              : explorationActive
                ? '面積条件達成・「終了」で安全に探索を止めるか、frontier探索を継続できます。'
                : exploration.status === 'paused'
                  ? '面積条件達成・一時停止中です。再開するとfrontier探索を続けます。'
                  : '面積条件達成・探索開始後にfrontierの有無を確認します。';
    this.find('#exploration-coverage-status').textContent = progressStatus;
    const selected = this.frontierAnalysis?.selected;
    this.find('#exploration-selection').textContent = selected
      ? `clearance ${formatNumber(selected.metrics.clearanceMeters)}m / gain ${selected.metrics.informationGain} / path ${formatNumber(selected.metrics.pathDistanceMeters)}m / score ${formatNumber(selected.metrics.score)}`
      : '未選択';
    this.find('#exploration-last-reason').textContent = this.explorationLastReason;
  }

  private setInteractionLayersLocked(locked: boolean): void {
    this.root.querySelectorAll<HTMLElement>('.topbar, .workspace, .story-footer, .tablet-control-dock, .tablet-control-dock-open').forEach((layer) => {
      if (locked) layer.setAttribute('inert', '');
      else layer.removeAttribute('inert');
    });
  }

  private dispatchAppEvent(event: AppEvent, announceRejection = true): boolean {
    this.lastAppEventRejection = '';
    const previous = this.appState;
    const graphAllowedBefore = canQueryRosGraph(previous);
    const result = transitionAppState(previous, event);
    if (!result.accepted) {
      if (result.rejection) {
        this.lastAppEventRejection = result.rejection;
        this.explorationLastReason = result.rejection;
        this.renderExplorationControls();
        if (announceRejection) this.showNarration(result.rejection);
      }
      return false;
    }
    if (result.state === previous && result.effects.length === 0) return true;
    this.appState = result.state;
    this.invalidateLocalLlmForAppEvent(event, previous, this.appState);
    const graphAllowedAfter = canQueryRosGraph(this.appState);
    if (graphAllowedBefore && !graphAllowedAfter) {
      this.rosGraphRequestGeneration += 1;
      this.missingGraphChecks = 0;
      this.explorationGraphFailureChecks = 0;
    }
    this.renderApplicationState(previous);
    result.effects.forEach((effect) => this.runAppEffect(effect));
    if (!graphAllowedBefore && graphAllowedAfter) void this.refreshRosGraph();
    this.scheduleObjectSearchLifecycle();
    return true;
  }

  private invalidateLocalLlmForAppEvent(event: AppEvent, previous: AppState, current: AppState): void {
    if (!localLlmRequestIsPending(this.localLlmRequest)) return;
    let reason = '';
    if (event.type === 'TRANSPORT_CHANGED' && previous.transportCycle !== current.transportCycle) reason = 'Transport cycleが変わったためLocal LLM requestを無効化しました。';
    else if (event.type === 'CONTROL_LEASE_CHANGED' && (previous.controlLease.generation !== current.controlLease.generation || !current.controlLease.owner)) reason = 'Control Leaseが変わったためLocal LLM requestを無効化しました。';
    else if (event.type === 'RUNTIME_SWITCH_REQUESTED' && event.target !== currentRuntimeMode(previous)) reason = 'runtime変更のためLocal LLM requestを無効化しました。';
    else if (event.type === 'RUNTIME_MANAGER_OBSERVED' && (event.snapshot.processing || Boolean(event.snapshot.error) || event.snapshot.mode !== currentRuntimeMode(previous))) reason = 'runtime状態が変わったためLocal LLM requestを無効化しました。';
    else if (event.type === 'VIEW_REQUESTED' && event.view === 'stage') reason = 'STAGE移行のためLocal LLM requestを無効化しました。';
    else if (event.type === 'MAP_RESET_REQUESTED') reason = 'map resetのためLocal LLM requestを無効化しました。';
    else if (event.type === 'ROBOT_ORIGIN_RESET_REQUESTED') reason = '原点resetのためLocal LLM requestを無効化しました。';
    else if (event.type === 'WINDOW_FOCUS_LOST') reason = 'window focusを失ったためLocal LLM requestを無効化しました。';
    else if (event.type === 'SAFE_STOP_REQUESTED' || (event.type === 'SAFETY_CHANGED' && event.stopped)) reason = '安全停止のためLocal LLM requestを無効化しました。';
    else if (event.type === 'COMMAND_OWNER_REQUESTED' && event.owner === 'manual') reason = 'manual操作への切替のためLocal LLM requestを無効化しました。';
    if (reason) this.invalidatePendingLocalLlm(reason, true);
  }

  private scheduleObjectSearchLifecycle(): void {
    const mission = this.appState.objectSearch;
    if (mission.status === 'preparing' && !this.objectSearchAdvanceQueued) {
      this.objectSearchAdvanceQueued = true;
      const generation = mission.generation;
      const visionCycle = this.appState.vision.cycle;
      const mapCycle = this.appState.map.cycle;
      const mapGeneration = this.appState.explorationEvidence.mapGeneration;
      const explorationGeneration = this.appState.exploration.generation;
      queueMicrotask(() => {
        this.objectSearchAdvanceQueued = false;
        if (this.appState.objectSearch.status !== 'preparing'
          || this.appState.objectSearch.generation !== generation
          || this.appState.vision.cycle !== visionCycle
          || this.appState.map.cycle !== mapCycle) return;
        this.dispatchAppEvent({
          type: 'OBJECT_SEARCH_ADVANCE_REQUESTED',
          generation,
          visionCycle,
          mapCycle,
          mapGeneration,
          explorationGeneration,
          requestedAtMs: Date.now(),
        }, false);
      });
    }

    if (mission.status === 'candidate' && !this.objectSearchSafeStopQueued) {
      this.objectSearchSafeStopQueued = true;
      const generation = mission.generation;
      const visionCycle = mission.visionCycle;
      const transportCycle = mission.transportCycle;
      const explorationGeneration = mission.explorationGeneration;
      const candidateFrameStampMs = mission.candidate.frameStampMs;
      const positionConfirmed = mission.positionConfirmed;
      if (explorationGeneration === null) {
        this.objectSearchSafeStopQueued = false;
      } else {
        queueMicrotask(() => {
          this.objectSearchSafeStopQueued = false;
          const current = this.appState.objectSearch;
          if (current.status !== 'candidate'
            || current.generation !== generation
            || current.candidate.frameStampMs !== candidateFrameStampMs) return;
          const requestedAtMs = Date.now();
          if (positionConfirmed) {
            this.dispatchAppEvent({
              type: 'OBJECT_SEARCH_SAFE_STOP_REQUESTED',
              generation,
              visionCycle,
              transportCycle,
              explorationGeneration,
              candidateFrameStampMs,
              requestedAtMs,
            }, false);
            return;
          }
          if (!this.currentPose || !this.occupancyMap) {
            this.dispatchAppEvent({
              type: 'OBJECT_SEARCH_APPROACH_UNAVAILABLE',
              generation,
              candidateFrameStampMs,
              requestedAtMs,
              reason: 'fresh live mapまたはSLAM poseを確認できません。',
            }, false);
            return;
          }
          const plan = planAppleApproachGoal(
            current.candidate,
            this.currentPose.pose,
            occupancyGridForGoalSelection(this.occupancyMap),
          );
          if (plan.status !== 'goal') {
            this.dispatchAppEvent({
              type: 'OBJECT_SEARCH_APPROACH_UNAVAILABLE',
              generation,
              candidateFrameStampMs,
              requestedAtMs,
              reason: plan.status === 'unavailable' ? plan.reason : '現在位置が既にgoal条件を満たすか再確認してください。',
            }, false);
            return;
          }
          this.dispatchAppEvent({
            type: 'OBJECT_SEARCH_APPROACH_REQUESTED',
            generation,
            visionCycle,
            transportCycle,
            explorationGeneration,
            candidateFrameStampMs,
            requestedAtMs,
            goal: {
              header: {
                frame_id: 'map',
                stamp: { sec: Math.floor(requestedAtMs / 1000), nanosec: requestedAtMs % 1000 * 1_000_000 },
              },
              pose: makePose(plan.approach.goal.x, plan.approach.goal.y, plan.approach.goal.yaw),
            },
            approach: plan.approach,
          }, false);
        });
      }
    }

    const healthMonitored = mission.status === 'searching'
      || mission.status === 'candidate'
      || mission.status === 'approaching'
      || mission.status === 'stopping'
      || mission.status === 'confirming';
    if (!healthMonitored) {
      if (this.objectSearchHealthTimer !== null) window.clearTimeout(this.objectSearchHealthTimer);
      this.objectSearchHealthTimer = null;
      return;
    }
    if (this.objectSearchHealthTimer !== null) return;
    this.objectSearchHealthTimer = window.setTimeout(() => {
      this.objectSearchHealthTimer = null;
      const current = this.appState.objectSearch;
      if (current.status !== 'searching'
        && current.status !== 'candidate'
        && current.status !== 'approaching'
        && current.status !== 'stopping'
        && current.status !== 'confirming') return;
      const requestedAtMs = Date.now();
      const unavailable = objectSearchReadinessUnavailableReason(this.appState, {
        generation: current.generation,
        visionCycle: this.appState.vision.cycle,
        mapCycle: this.appState.map.cycle,
        mapGeneration: this.appState.explorationEvidence.mapGeneration,
        explorationGeneration: this.appState.exploration.generation,
        nowMs: requestedAtMs,
      });
      if (unavailable) {
        this.dispatchAppEvent({ type: 'OBJECT_SEARCH_HEALTH_CHECK_REQUESTED', generation: current.generation, requestedAtMs }, false);
      } else {
        this.scheduleObjectSearchLifecycle();
      }
    }, 250);
  }

  private renderApplicationState(previous: AppState): void {
    this.renderRuntimeModePresentation(currentRuntimeMode(previous));
    this.renderRuntimeButtons();
    this.renderNavigationControlButtons();
    this.updateSaveMapButton();
    this.renderStateBoundarySummary();
    this.renderExplorationControls();
    this.renderObjectSearchSummary();
    const modal = processingModalModel(this.appState);
    this.processingModal.hidden = modal === null;
    this.setInteractionLayersLocked(modal !== null);
    this.root.toggleAttribute('aria-busy', modal !== null);
    const stageTab = this.root.querySelector<HTMLButtonElement>('.view-tab[data-view="stage"]');
    if (stageTab) {
      stageTab.disabled = modal !== null;
      stageTab.setAttribute('aria-disabled', String(modal !== null));
    }
    if (modal) {
      this.processingModalTitle.textContent = modal.title;
      this.processingModalDetail.textContent = modal.detail;
      this.processingModalStatus.textContent = modal.status;
    }
  }

  private renderStateBoundarySummary(): void {
    const readinessLabel = (mode: 'mapping' | 'navigation' | 'exploration'): string => mode === 'mapping' ? 'MAP' : mode === 'navigation' ? 'NAV2' : 'EXPLORE';
    const runtime = this.appState.runtime.status === 'stable'
      ? `安定: ${this.appState.runtime.mode.toUpperCase()}`
      : this.appState.runtime.status === 'switching'
        ? `切替: ${this.appState.runtime.mode.toUpperCase()}→${this.appState.runtime.target.toUpperCase()}`
        : `エラー: ${this.appState.runtime.mode.toUpperCase()}`;
    const map = this.appState.map.status === 'unavailable'
      ? 'map不要'
      : this.appState.map.status === 'initializing'
        ? `${readinessLabel(this.appState.map.target)}初期化中`
        : this.appState.map.status === 'ready'
          ? `${readinessLabel(this.appState.map.mode)} ready`
          : this.appState.map.status === 'resetting'
            ? 'MAP reset中'
            : 'mapエラー';
    const command = this.appState.command.owner === 'navigation'
      ? commandOwnerAwaitingAcknowledgement(this.appState) ? 'Nav2（Gate応答待ち）' : 'Nav2'
      : this.appState.command.owner === 'manual' ? '手動' : '停止中';
    const view = this.appState.view.mode === 'sim' ? 'SIM' : `STAGE:${this.appState.view.surface === 'plan' ? '図面' : 'カメラ'}${this.appState.view.gesture === 'active' ? ':操作中' : ''}`;
    this.find('#state-runtime-map').textContent = `${runtime} / ${map}`;
    this.find('#state-command-view').textContent = `${command} / ${this.appState.transport} / ${view} / ${this.appState.navigation.status} / Safety:${this.appState.safety.stopped ? '停止' : 'clear'}`;
    const mission = this.appState.objectSearch;
    const missionLabel = mission.status === 'idle' ? 'ObjectSearch:idle' : `ObjectSearch:${mission.status} #${mission.missionId}.${mission.generation}`;
    this.find('#state-exploration').textContent = `${this.appState.exploration.status} / generation ${this.appState.exploration.generation} / ${missionLabel}`;
  }

  private runAppEffect(effect: AppEffect): void {
    if (effect.type === 'RELEASE_USER_INPUT') {
      this.releaseUserInput?.();
      return;
    }
    if (effect.type === 'CANCEL_NAVIGATION_GOAL') {
      this.transport?.cancelNavigationGoal();
      return;
    }
    if (effect.type === 'SET_COMMAND_OWNER') {
      const navigation = effect.owner === 'navigation';
      this.simulation?.setNavigationMode(navigation);
      if (this.transport?.getConnectionState() === 'CONNECTED') this.transport.publish('/control/navigation_mode', topicType('/control/navigation_mode'), { data: navigation });
      return;
    }
    if (effect.type === 'ZERO_VELOCITY') {
      this.simulation?.stopMotion();
      return;
    }
    if (effect.type === 'CLEAR_GOAL_DATA') {
      this.clearGoalData();
      return;
    }
    if (effect.type === 'CLEAR_RUNTIME_DATA') {
      this.clearNavigationTracking();
      this.clearCurrentMap();
      this.clearExplorationVisuals();
      this.explorationMapSnapshots.clear();
      this.explorationMapGeneration += 1;
      this.latestMapReceivedAt = 0;
      this.latestExplorationPoseAt = 0;
      this.explorationEvidenceNotBeforeMs = Date.now();
      this.latestSlamPose = null;
      this.explorationGraphFailureChecks = 0;
      return;
    }
    if (effect.type === 'RESET_NAVIGATION_ORIGIN') {
      this.simulation?.resetForNavigation();
      return;
    }
    if (effect.type === 'RESET_ROBOT_ORIGIN') {
      const navigationStartPose = this.runtimeMode === 'navigation' ? this.mapTrainingStartPose() : null;
      this.simulation?.resetForNavigation(false);
      if (navigationStartPose && this.transport?.getConnectionState() === 'CONNECTED') {
        const milliseconds = Date.now();
        const covariance = Array<number>(36).fill(0);
        covariance[0] = .25;
        covariance[7] = .25;
        covariance[35] = .0685;
        this.transport.publish('/initialpose', topicType('/initialpose'), {
          header: { frame_id: 'map', stamp: { sec: Math.floor(milliseconds / 1000), nanosec: milliseconds % 1000 * 1_000_000 } },
          pose: { pose: makePose(navigationStartPose.x, navigationStartPose.y, navigationStartPose.yaw), covariance },
        });
      }
      this.updateHandles();
      return;
    }
    if (effect.type === 'REQUEST_RUNTIME') {
      void this.requestRuntimeMode?.(effect.mode);
      return;
    }
    if (effect.type === 'REQUEST_MAP_RESET') {
      if (!this.transport) {
        this.dispatchAppEvent({ type: 'MAP_RESET_COMPLETED', success: false }, false);
        return;
      }
      void this.transport.resetMap().then((success) => {
        this.dispatchAppEvent({ type: 'MAP_RESET_COMPLETED', success }, false);
      });
      return;
    }
    if (effect.type === 'SEND_NAVIGATION_GOAL') {
      this.goalPose = effect.goal;
      this.find('#map-goal').textContent = `${formatNumber(effect.goal.pose.position.x)} / ${formatNumber(effect.goal.pose.position.y)} m`;
      this.publishNavigationGoalDistance();
      this.scheduleNavigationMap();
      if (this.appState.navigation.status === 'sending' && this.appState.navigation.source === 'exploration') {
        const selected = this.appState.exploration.status === 'sending' ? this.appState.exploration.selected : null;
        const candidate = selected
          ? this.frontierAnalysis?.candidates.find((item) => item.id === selected.candidateId) ?? null
          : null;
        if (candidate && selected && this.frontierAnalysis && this.frontierAnalysisMapGeneration === selected.mapGeneration) {
          this.explorationCandidateByTask.set(effect.taskId, {
            candidate,
            mapGeneration: selected.mapGeneration,
            knownCellCount: this.frontierAnalysis.knownCellCount,
          });
          while (this.explorationCandidateByTask.size > 8) this.explorationCandidateByTask.delete(this.explorationCandidateByTask.keys().next().value as number);
        }
      }
      const sendGoal = (): void => {
        const goalId = this.transport?.sendNavigationGoal(effect.goal, {
          onFeedback: () => this.dispatchAppEvent({ type: 'NAVIGATION_GOAL_FEEDBACK', taskId: effect.taskId }, false),
          onResult: () => {
            const snapshot = this.explorationCandidateByTask.get(effect.taskId);
            const explorationTask = this.appState.navigation.taskId === effect.taskId
              && (this.appState.navigation.status === 'sending' || this.appState.navigation.status === 'moving')
              && this.appState.navigation.source === 'exploration';
            const accepted = this.dispatchAppEvent({ type: 'NAVIGATION_GOAL_SUCCEEDED', taskId: effect.taskId, completedAtMs: Date.now() }, false);
            if (accepted && explorationTask) {
              this.explorationSweepProgress = recordExplorationGoalSuccess(this.explorationSweepProgress);
              if (snapshot) this.explorationGoalVisitHistory = recordExplorationGoalVisit(this.explorationGoalVisitHistory, snapshot.candidate);
            }
            this.explorationTasksWithStaleTransform.delete(effect.taskId);
            this.explorationCandidateByTask.delete(effect.taskId);
          },
          onError: (error) => {
            const canceled = error.status === 'canceled';
            const navigation = this.appState.navigation;
            const explorationTask = (navigation.status === 'sending' || navigation.status === 'moving')
              && navigation.taskId === effect.taskId
              && navigation.source === 'exploration';
            const transformFreshness = navigationTransformFreshness(this.latestMapToOdom, Date.now());
            const staleTransformObservedDuringTask = this.explorationTasksWithStaleTransform.has(effect.taskId);
            const objectSearchExploration = explorationTask
              && explorationUsesObjectSearchPolicy(this.appState.exploration)
              && this.appState.objectSearch.status === 'searching'
              && this.appState.objectSearch.explorationGeneration === this.appState.exploration.generation;
            const mapStability = objectSearchExploration
              ? assessExplorationMapStability([...this.explorationMapSnapshots.values()])
              : null;
            const transientTransformFailure = explorationTask
              && error.status === 'aborted'
              && (transformFreshness.status !== 'fresh' || staleTransformObservedDuringTask);
            const transientMapFailure = objectSearchExploration
              && error.status === 'aborted'
              && mapStability !== null
              && !mapStability.stable;
            const transientNavigationFailure = transientTransformFailure || transientMapFailure;
            if (!transientNavigationFailure) this.recordExplorationGoalFailure(effect.taskId, canceled ? 'canceled' : 'failed');
            else {
              this.explorationLastReason = transientTransformFailure
                ? 'SLAMのmap→odom TFが遅れたため、安全停止して同期待ちへ戻ります。このgoalは失敗回数やblacklistへ加算しません。'
                : 'SLAM mapの形状または占有データが変化中のため、安全停止して安定待ちへ戻ります。このgoalは失敗回数やblacklistへ加算しません。';
              this.renderExplorationControls();
            }
            this.explorationTasksWithStaleTransform.delete(effect.taskId);
            this.explorationCandidateByTask.delete(effect.taskId);
            this.dispatchAppEvent({
              type: 'NAVIGATION_GOAL_FAILED',
              taskId: effect.taskId,
              error: transientTransformFailure
                ? 'SLAMのmap→odom TFが遅れています'
                : transientMapFailure
                  ? 'SLAM mapまたはcostmapが安定していません'
                  : this.explainNavigationError(error),
              canceled,
              transient: transientTransformFailure
                ? 'stale-transform'
                : transientMapFailure
                  ? 'navigation-recovery'
                  : undefined,
            }, false);
          },
        }) ?? null;
        if (goalId) this.dispatchAppEvent({ type: 'NAVIGATION_GOAL_ACCEPTED', taskId: effect.taskId, goalId }, false);
        else {
          this.recordExplorationGoalFailure(effect.taskId, 'failed');
          this.explorationCandidateByTask.delete(effect.taskId);
          this.dispatchAppEvent({ type: 'NAVIGATION_GOAL_FAILED', taskId: effect.taskId, error: '目標を送信できませんでした', canceled: false }, false);
        }
      };
      if (effect.afterCancelSettles) {
        globalThis.setTimeout(() => {
          const navigation = this.appState.navigation;
          if (navigation.status !== 'sending'
            || navigation.source !== 'object-search'
            || navigation.taskId !== effect.taskId) return;
          this.runAppEffect({ type: 'SET_COMMAND_OWNER', owner: 'navigation' });
          sendGoal();
        }, NAVIGATION_GOAL_CANCEL_SETTLE_MS);
      } else {
        sendGoal();
      }
      return;
    }
    if (effect.type === 'EVALUATE_EXPLORATION_MAP') {
      this.queueExplorationEvaluation(effect.generation, effect.mapGeneration, effect.blacklistedCandidateIds);
      return;
    }
    if (effect.type === 'WAIT_FOR_EXPLORATION_MAP') {
      this.waitForExplorationMap(effect.generation, effect.afterMapGeneration, effect.requireFreshMap);
      return;
    }
    if (effect.type === 'CLEAR_EXPLORATION_DATA') {
      this.clearExplorationData();
      return;
    }
    if (effect.type === 'ENTER_STAGE') {
      this.applyView('stage');
      return;
    }
    if (effect.type === 'EXIT_STAGE') {
      this.applyView('sim');
      return;
    }
    if (effect.type === 'SET_STAGE_SURFACE') {
      this.applyStageSurface(effect.surface);
      return;
    }
    if (effect.type === 'SET_NAVIGATION_STATUS') {
      this.find('#nav-status').textContent = effect.message;
      return;
    }
    if (effect.type === 'SYNC_OBJECT_SEARCH_CHAT') {
      const lastMessage = this.objectSearchChat.messages.at(-1);
      const message = effect.message && lastMessage?.text !== effect.message
        ? { role: effect.role ?? 'robot' as const, text: effect.message }
        : undefined;
      this.objectSearchChat = synchronizeObjectSearchChat(this.objectSearchChat, effect.status, effect.targetClass, message);
      this.renderObjectSearchChat();
      return;
    }
    this.showNarration(effect.message);
  }

  private recordExplorationGoalFailure(taskId: number, outcome: 'failed' | 'canceled'): void {
    const navigation = this.appState.navigation;
    if ((navigation.status !== 'sending' && navigation.status !== 'moving')
      || navigation.taskId !== taskId
      || navigation.source !== 'exploration') return;
    const snapshot = this.explorationCandidateByTask.get(taskId);
    if (!snapshot) return;
    this.frontierHistory = recordFrontierAttempt(this.frontierHistory, {
      candidateId: snapshot.candidate.id,
      world: snapshot.candidate.world,
      generation: snapshot.mapGeneration,
      knownCellCount: snapshot.knownCellCount,
      nowMs: Date.now(),
      outcome,
    });
    this.explorationSweepProgress = recordExplorationGoalFailureProgress(this.explorationSweepProgress);
    this.explorationLastReason = outcome === 'failed'
      ? `${snapshot.candidate.id} のgoal失敗をblacklistへ記録しました。`
      : `${snapshot.candidate.id} の予期しないcancelをcooldown対象へ記録しました。`;
  }

  private observeBackupActionStatus(message: GoalStatusArrayMessage): void {
    const observation = this.backupActionStatusTracker.observe(message);
    const navigation = this.appState.navigation;
    if (this.explorationDiversionEnabled
      && (navigation.status === 'sending' || navigation.status === 'moving')
      && navigation.source === 'exploration') {
      for (const goalId of observation.activeGoalIds) {
        this.backupTaskByGoalId.set(goalId, navigation.taskId);
        while (this.backupTaskByGoalId.size > 64) {
          const oldest = this.backupTaskByGoalId.keys().next().value as string | undefined;
          if (!oldest) break;
          this.backupTaskByGoalId.delete(oldest);
        }
      }
    }
    for (const goalId of observation.succeededGoalIds) {
      const taskId = this.backupTaskByGoalId.get(goalId);
      this.backupTaskByGoalId.delete(goalId);
      if (!this.explorationDiversionEnabled || taskId === undefined) continue;
      if (this.appState.safety.stopped) {
        this.pendingBackupDiversionTaskId = taskId;
        this.explorationLastReason = 'BackUpに成功しました。Safety clear後に現在goalを取消して遠方frontierへ変更します。';
        this.renderExplorationControls();
      } else {
        this.requestExplorationRecoveryDiversion(taskId);
      }
    }
  }

  private requestExplorationRecoveryDiversion(taskId: number): void {
    const snapshot = this.explorationCandidateByTask.get(taskId);
    if (!snapshot || !this.explorationDiversionEnabled) return;
    if (!this.dispatchAppEvent({ type: 'EXPLORATION_RECOVERY_DIVERSION_REQUESTED', taskId }, false)) return;
    this.pendingBackupDiversionTaskId = null;
    this.explorationDiversionAnchor = { x: snapshot.candidate.world.x, y: snapshot.candidate.world.y };
    this.frontierHistory = recordFrontierAttempt(this.frontierHistory, {
      candidateId: snapshot.candidate.id,
      world: snapshot.candidate.world,
      generation: snapshot.mapGeneration,
      knownCellCount: snapshot.knownCellCount,
      nowMs: Date.now(),
      outcome: 'canceled',
    });
    this.explorationCandidateByTask.delete(taskId);
    this.explorationLastReason = `${snapshot.candidate.id} から後退できたため、現在goalを取消して遠方候補へ変更します。`;
    this.renderExplorationControls();
  }

  private queueExplorationEvaluation(generation: number, mapGeneration: number, blacklistedCandidateIds: readonly string[]): void {
    if (this.explorationEvaluationTimer !== null) window.clearTimeout(this.explorationEvaluationTimer);
    if (this.explorationWaitTimer !== null) window.clearTimeout(this.explorationWaitTimer);
    this.explorationWaitTimer = null;
    const delay = Math.max(0, EXPLORATION_EVALUATION_INTERVAL_MS - (performance.now() - this.explorationLastEvaluationAt));
    this.explorationEvaluationTimer = window.setTimeout(() => {
      this.explorationEvaluationTimer = null;
      this.evaluateExplorationMap(generation, mapGeneration, blacklistedCandidateIds);
    }, delay);
  }

  private evaluateExplorationMap(generation: number, mapGeneration: number, blacklistedCandidateIds: readonly string[]): void {
    const exploration = this.appState.exploration;
    if (exploration.generation !== generation
      || exploration.status !== 'evaluating'
      || exploration.mapGeneration !== mapGeneration
      || this.runtimeMode !== 'exploration') return;
    if (this.explorationMapGeneration > mapGeneration) {
      this.dispatchAppEvent({
        type: 'EXPLORATION_EVALUATION_REQUESTED',
        generation,
        mapGeneration: this.explorationMapGeneration,
      }, false);
      return;
    }
    this.explorationLastEvaluationAt = performance.now();
    const map = this.explorationMapSnapshots.get(mapGeneration);
    if (!map || !this.currentPose) {
      this.explorationLastReason = '評価対象のlive mapまたはSLAM poseを待っています。fresh dataの受信後に再評価します。';
      this.renderExplorationControls();
      this.retryPendingExplorationEvaluation(generation, mapGeneration, blacklistedCandidateIds);
      return;
    }
    if (Date.now() - this.latestExplorationPoseAt > EXPLORATION_POSE_FRESHNESS_MS
      || Date.now() - this.latestMapReceivedAt > EXPLORATION_POSE_FRESHNESS_MS * 2) {
      this.explorationLastReason = 'live mapまたはSLAM poseが古いため評価を保留しています。fresh dataを待っています。';
      this.renderExplorationControls();
      this.retryPendingExplorationEvaluation(generation, mapGeneration, blacklistedCandidateIds);
      return;
    }
    const transformFreshness = navigationTransformFreshness(this.latestMapToOdom, Date.now());
    if (transformFreshness.status !== 'fresh') {
      const age = 'ageMs' in transformFreshness && transformFreshness.ageMs >= 0
        ? `（${Math.round(transformFreshness.ageMs)} ms遅延）`
        : '';
      this.explorationLastReason = `SLAMのmap→odom TF同期待ちです${age}。新しいTFを受信するまでgoalを送信しません。`;
      this.renderExplorationControls();
      this.retryPendingExplorationEvaluation(generation, mapGeneration, blacklistedCandidateIds);
      return;
    }
    const objectSearchExploration = explorationUsesObjectSearchPolicy(exploration)
      && this.appState.objectSearch.status === 'searching'
      && this.appState.objectSearch.explorationGeneration === generation;
    if (objectSearchExploration) {
      const mapStability = assessExplorationMapStability([...this.explorationMapSnapshots.values()]);
      if (!mapStability.stable) {
        const stabilityReason = mapStability.status === 'insufficient-samples'
          ? `fresh mapを${mapStability.sampleCount}/3枚受信するまで`
          : mapStability.status === 'geometry-changing'
            ? 'mapのサイズ・原点が変化中のため'
            : 'mapの占有データが変化中のため';
        this.explorationLastReason = `Object Searchは${stabilityReason}goal送信を保留します。SLAM・TF・costmapの安定後に再評価します。`;
        this.renderExplorationControls();
        this.retryPendingExplorationEvaluation(generation, mapGeneration, blacklistedCandidateIds);
        return;
      }
    }
    try {
      const grid = occupancyGridForGoalSelection(map);
      const robotWorld = { x: this.currentPose.pose.position.x, y: this.currentPose.pose.position.y };
      const analysis = analyzeFrontiers({
        grid,
        robotWorld,
        generation: mapGeneration,
        nowMs: Date.now(),
        history: this.frontierHistory,
      });
      const currentExploration = this.appState.exploration;
      if (currentExploration.generation !== generation
        || currentExploration.status !== 'evaluating'
        || currentExploration.mapGeneration !== mapGeneration
        || this.explorationMapGeneration !== mapGeneration) return;
      const objectSearchExploration = explorationUsesObjectSearchPolicy(currentExploration)
        && this.appState.objectSearch.status === 'searching'
        && this.appState.objectSearch.explorationGeneration === generation;
      const eligibleCandidates = analysis.candidates.filter((candidate) => !blacklistedCandidateIds.includes(candidate.id));
      const coverage = summarizeExplorationCoverage(grid.data.length, analysis.freeCellCount, analysis.knownCellCount);
      this.explorationCoverage = coverage;
      if (objectSearchExploration) {
        // Object Search is interested in new camera viewpoints, not map
        // coverage. A previous normal run may already have latched the corner
        // recovery state, so clear that local selector state on every mission
        // evaluation as well as skipping its triggers below.
        this.explorationSweepProgress = createExplorationSweepProgress();
      } else {
        this.explorationSweepProgress = observeExplorationSweepCoverage(this.explorationSweepProgress, coverage.exploredRatio);
      }
      let selectionPlan = planFrontierGoalSelection(
        eligibleCandidates,
        [],
        robotWorld,
        false,
        analysis.requiredClearanceMeters,
        this.explorationGoalVisitHistory,
        blacklistedCandidateIds,
        objectSearchExploration ? 'object-search' : 'coverage',
      );
      if (!objectSearchExploration) {
        this.explorationSweepProgress = latchCornerSweepForCandidateExhaustion(
          this.explorationSweepProgress,
          coverage.exploredRatio,
          selectionPlan.candidates.length,
          this.explorationGoalVisitHistory.entries.length,
        );
        const cornerCandidates = this.explorationSweepProgress.cornerSweepLatched
          ? createMapCornerGoalCandidates({
            grid,
            safeCellMask: analysis.safeCellMask,
            clearanceMeters: analysis.clearanceMeters,
            pathDistanceMeters: analysis.pathDistanceMeters,
          }).filter((candidate) => getFrontierBlacklistStatus(this.frontierHistory, {
            world: candidate.world,
            generation: mapGeneration,
            knownCellCount: analysis.knownCellCount,
            nowMs: Date.now(),
          }) === 'available')
          : [];
        if (this.explorationSweepProgress.cornerSweepLatched) {
          selectionPlan = planFrontierGoalSelection(
            eligibleCandidates,
            cornerCandidates,
            robotWorld,
            true,
            analysis.requiredClearanceMeters,
            this.explorationGoalVisitHistory,
            blacklistedCandidateIds,
            'coverage',
          );
        }
      } else if (!selectionPlan.selected) {
        // Once the currently visible frontiers are exhausted, keep the
        // perception mission moving through safe, known interior viewpoints.
        // The selector is deliberately not a corner sweep and remains inside
        // the same live map / clearance / reachable-cell evidence.
        const roamingCandidates = createObjectSearchRoamingGoalCandidates({
          grid,
          safeCellMask: analysis.safeCellMask,
          clearanceMeters: analysis.clearanceMeters,
          pathDistanceMeters: analysis.pathDistanceMeters,
          robotWorld,
          requiredClearanceMeters: analysis.requiredClearanceMeters,
        });
        const eligibleRoamingCandidates = roamingCandidates.filter((candidate) => !blacklistedCandidateIds.includes(candidate.id));
        const unvisitedRoamingCandidates = filterUnvisitedGoalCandidates(
          eligibleRoamingCandidates,
          this.explorationGoalVisitHistory,
        );
        selectionPlan = planFrontierGoalSelection(
          roamingCandidates,
          [],
          robotWorld,
          false,
          analysis.requiredClearanceMeters,
          this.explorationGoalVisitHistory,
          blacklistedCandidateIds,
          'object-search',
          true,
        );
        if (unvisitedRoamingCandidates.length === 0 && eligibleRoamingCandidates.length > 0) {
          selectionPlan = {
            ...selectionPlan,
            selected: selectObjectSearchRoamingCandidate(
              selectionPlan.candidates,
              robotWorld,
              this.explorationGoalVisitHistory,
            ),
          };
        }
      }
      const candidates = selectionPlan.candidates;
      const diversion = this.explorationDiversionEnabled && this.explorationDiversionAnchor
        ? selectExplorationDiversionCandidate(candidates, this.explorationDiversionAnchor)
        : null;
      const selectedCandidate = diversion?.candidate ?? selectionPlan.selected;
      this.frontierAnalysis = {
        ...analysis,
        candidates,
        selected: selectedCandidate,
        selectionReason: selectedCandidate
          ? selectionPlan.mode === 'corner-sweep' ? 'coverage-corner-sweep' : 'open-clearance-priority'
          : candidates.length > 0 ? 'no-eligible-candidates' : analysis.selectionReason,
      };
      this.frontierAnalysisMap = map;
      this.frontierAnalysisMapGeneration = mapGeneration;
      const rejectionLabels: Record<string, string> = {
        noise: 'noise',
        'no-safe-free-goal': '安全余白NG',
        unreachable: '到達不能',
        'too-close': '近距離goal',
        blacklisted: 'blacklist',
        'candidate-limit': '候補上限',
      };
      const rejectionCounts = new Map<string, number>();
      for (const rejection of this.frontierAnalysis.rejected) {
        rejectionCounts.set(rejection.reason, (rejectionCounts.get(rejection.reason) ?? 0) + 1);
      }
      const rejectionSummary = [...rejectionCounts.entries()]
        .map(([reason, count]) => `${rejectionLabels[reason] ?? reason} ${count}`)
        .concat(this.frontierAnalysis.omittedRejectionCount > 0 ? [`表示上限外 ${this.frontierAnalysis.omittedRejectionCount}`] : [])
        .join(' / ');
      this.scheduleNavigationMap();
      this.renderExplorationControls();
      const selected = this.frontierAnalysis.selected;
      if (!selected) {
        const noCandidateEventReason = classifyExplorationNoCandidateResult(analysis, candidates.length);
        const recoveryExhausted = coverage.exploredRatio < EXPLORATION_COMPLETION_MIN_EXPLORED_RATIO
          && !objectSearchExploration
          && this.explorationSweepProgress.cornerSweepLatched
          && candidates.length === 0;
        const noCandidateReason: Record<ExplorationNoCandidateReason, string> = {
          'no-frontiers': 'frontierが見つかりません。fresh mapで再確認します。',
          'no-eligible-candidates': 'frontierは残っていますが、現在poseからclearance・到達性条件を満たすgoalがありません。退避後のposeまたはfresh mapで再確認します。',
          'robot-out-of-bounds': '自機位置がlive map外です。mapとSLAM poseの同期を待って再評価します。',
          'robot-not-free': '自機位置が既知free領域にありません。mapとSLAM poseの同期を待って再評価します。',
          'robot-insufficient-clearance': '自機がSafety余白内です。手動で後退・旋回するか「初期位置へ戻す」で退避してから再開してください。',
          'blacklist-cooldown': '到達可能な候補はblacklist cooldown中です。完了に数えず再評価します。',
        };
        const coverageReason = objectSearchExploration
          ? ' Object Searchでは四隅掃引やmap全域の完了判定を使わず、fresh mapまたは安全な既知領域goalを待ちます。'
          : coverage.exploredRatio < EXPLORATION_COMPLETION_MIN_EXPLORED_RATIO
            ? ` 観測済み領域${Math.round(coverage.exploredRatio * 100)}%のため、完了基準${Math.round(EXPLORATION_COMPLETION_MIN_EXPLORED_RATIO * 100)}%まで探索を継続します。`
            : '';
        this.explorationLastReason = `${objectSearchExploration ? 'Object Search用の安全な巡回goalを作れません。' : noCandidateReason[noCandidateEventReason]}${coverageReason}${rejectionSummary ? ` 拒否: ${rejectionSummary}` : ''}`;
        this.dispatchAppEvent({
          type: 'EXPLORATION_NO_CANDIDATES',
          generation,
          mapGeneration,
          reason: noCandidateEventReason,
          exploredCoverageRatio: coverage.exploredRatio,
          recoveryExhausted,
        }, false);
        return;
      }
      const milliseconds = Date.now();
      const adjusted = adjustNavigationGoalForObstacleBeyond(grid, robotWorld, selected.world);
      const goal: PoseStampedMessage = {
        header: { frame_id: 'map', stamp: { sec: Math.floor(milliseconds / 1000), nanosec: milliseconds % 1000 * 1_000_000 } },
        pose: makePose(adjusted.goal.x, adjusted.goal.y, adjusted.goal.yaw),
      };
      const adjustmentReason = adjusted.adjusted && adjusted.obstacleKind
        ? ` 目的地の奥に${GOAL_OBSTACLE_LABELS[adjusted.obstacleKind]}があるため${formatNumber(adjusted.retreatMeters)}m手前へ補正しました。`
        : '';
      const diversionReason = diversion
        ? ` BackUp前のgoalから最遠の${formatNumber(diversion.distanceMeters)}m地点へ変更しました${diversion.minimumDistanceSatisfied ? '' : '（2m未満）'}。`
        : '';
      const cornerSweepReason = this.explorationSweepProgress.cornerSweepTrigger === 'normal-candidates-exhausted'
        ? `観測済み領域${Math.round(coverage.exploredRatio * 100)}%で未訪問の通常goalが尽きた`
        : this.explorationSweepProgress.cornerSweepTrigger === 'failed-goal-recovery'
          ? `通常goalの失敗が${this.explorationSweepProgress.consecutiveGoalFailures}回続いた`
          : `goal成功2回の探索率増加が${formatNumber((this.explorationSweepProgress.lastWindowGainRatio ?? 0) * 100)}ポイントで1ポイント未満だった`;
      const selectionDescription = selectionPlan.mode === 'object-search'
        ? `Object Search用に四隅掃引とmap全域の完了判定を使わず、${candidates.some((candidate) => candidate.clusterId.startsWith('object-search-roaming-')) ? '既知free領域の内部巡回' : '通常frontier'} ${candidates.length}候補から`
        : selectionPlan.mode === 'corner-sweep'
        ? `${cornerSweepReason}ため、未訪問の四隅${candidates.length}件を隣接順に巡回する次の`
        : selectionPlan.mode === 'post-corner-frontier'
          ? `四隅の安全goalを一巡したため、成功済み地点の周囲1mを除いたfrontier ${candidates.length}/${eligibleCandidates.length}候補から経路${EXPLORATION_LOCAL_GOAL_HORIZON_METERS}m以内の最遠（範囲外だけなら最短）の`
          : `${selectionPlan.preferredClearanceAvailable ? '広所優先' : '現在の最広帯'}${selectionPlan.relaxedClearanceUsed ? '＋分散候補補充' : ''}（clearance ${formatNumber(selectionPlan.clearanceFloorMeters)}m以上）かつ成功済み地点の周囲1mを除いた${candidates.length}/${eligibleCandidates.length}候補から経路${EXPLORATION_LOCAL_GOAL_HORIZON_METERS}m以内の最遠（範囲外だけなら最短）の`;
      this.explorationLastReason = `${selectionDescription} ${selected.id} を選択しました。${diversionReason}${adjustmentReason}${rejectionSummary ? ` 拒否: ${rejectionSummary}` : ''}`;
      if (this.dispatchAppEvent({ type: 'EXPLORATION_GOAL_REQUESTED', generation, mapGeneration, candidateId: selected.id, goal, requestedAtMs: milliseconds }, false)) {
        this.explorationDiversionAnchor = null;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.explorationLastReason = `frontier評価に失敗: ${message}`;
      this.dispatchAppEvent({ type: 'EXPLORATION_ERROR_REPORTED', generation, error: message }, false);
    }
  }

  private retryPendingExplorationEvaluation(generation: number, mapGeneration: number, blacklistedCandidateIds: readonly string[]): void {
    if (this.explorationWaitTimer !== null) window.clearTimeout(this.explorationWaitTimer);
    this.explorationWaitTimer = window.setTimeout(() => {
      this.explorationWaitTimer = null;
      const exploration = this.appState.exploration;
      if (exploration.generation !== generation || exploration.status !== 'evaluating') return;
      if (this.explorationMapGeneration > exploration.mapGeneration) {
        this.dispatchAppEvent({
          type: 'EXPLORATION_EVALUATION_REQUESTED',
          generation,
          mapGeneration: this.explorationMapGeneration,
        }, false);
        return;
      }
      if (exploration.mapGeneration !== mapGeneration) return;
      this.queueExplorationEvaluation(generation, mapGeneration, blacklistedCandidateIds);
    }, EXPLORATION_WAIT_COOLDOWN_MS);
  }

  private waitForExplorationMap(generation: number, afterMapGeneration: number, requireFreshMap: boolean): void {
    if (this.explorationWaitTimer !== null) window.clearTimeout(this.explorationWaitTimer);
    this.explorationWaitTimer = window.setTimeout(() => {
      this.explorationWaitTimer = null;
      if (this.appState.exploration.generation !== generation) return;
      if (this.explorationMapGeneration > afterMapGeneration || (!requireFreshMap && this.explorationMapGeneration >= afterMapGeneration)) {
        this.dispatchAppEvent({ type: 'EXPLORATION_EVALUATION_REQUESTED', generation, mapGeneration: this.explorationMapGeneration }, false);
      }
    }, EXPLORATION_WAIT_COOLDOWN_MS);
  }

  private evaluateWaitingExplorationOnFreshMap(): void {
    const exploration = this.appState.exploration;
    if (exploration.status === 'evaluating') {
      if (this.explorationMapGeneration > exploration.mapGeneration) {
        this.dispatchAppEvent({
          type: 'EXPLORATION_EVALUATION_REQUESTED',
          generation: exploration.generation,
          mapGeneration: this.explorationMapGeneration,
        }, false);
      } else if (this.explorationWaitTimer !== null) {
        window.clearTimeout(this.explorationWaitTimer);
        this.explorationWaitTimer = null;
        this.queueExplorationEvaluation(exploration.generation, exploration.mapGeneration, exploration.blacklistedCandidateIds);
      }
      return;
    }
    if (exploration.status !== 'replanning') return;
    // Failed/canceled goals must observe the explicit cooldown. The timer in
    // waitForExplorationMap owns their next evaluation even if /map is busy.
    if (!exploration.requireFreshMap) return;
    if (exploration.requireFreshMap && this.explorationMapGeneration <= exploration.afterMapGeneration) return;
    this.dispatchAppEvent({
      type: 'EXPLORATION_EVALUATION_REQUESTED',
      generation: exploration.generation,
      mapGeneration: this.explorationMapGeneration,
    }, false);
  }

  private clearExplorationVisuals(): void {
    if (this.explorationEvaluationTimer !== null) window.clearTimeout(this.explorationEvaluationTimer);
    if (this.explorationWaitTimer !== null) window.clearTimeout(this.explorationWaitTimer);
    this.explorationEvaluationTimer = null;
    this.explorationWaitTimer = null;
    this.frontierAnalysis = null;
    this.explorationCoverage = null;
    this.frontierAnalysisMap = null;
    this.frontierAnalysisMapGeneration = 0;
    this.explorationCandidateByTask.clear();
    this.explorationTasksWithStaleTransform.clear();
    this.backupTaskByGoalId.clear();
    this.explorationDiversionAnchor = null;
    this.pendingBackupDiversionTaskId = null;
    this.scheduleNavigationMap();
    this.renderExplorationControls();
  }

  private clearExplorationData(): void {
    this.clearExplorationVisuals();
    this.frontierHistory = createFrontierHistory();
    this.explorationSweepProgress = createExplorationSweepProgress();
    this.explorationGoalVisitHistory = createExplorationGoalVisitHistory();
    this.explorationLastReason = '探索データを消去しました。';
    this.renderExplorationControls();
  }

  setSimulation(simulation: Simulation): void {
    this.simulation = simulation;
    this.rayCount = simulation.getRayCount();
    this.find('#ray-count').textContent = String(this.rayCount);
    this.find('#visible-ray-count').textContent = String(SIM_LIDAR_VISIBLE_RAY_COUNT);
    let legacyPlayground: PlaygroundDefinition | null = null;
    try {
      const saved = localStorage.getItem(PLAYGROUND_STORAGE_KEY);
      if (saved) legacyPlayground = parsePlayground(saved);
    } catch (error) {
      this.setPlaygroundStatus(error instanceof Error ? error.message : String(error), true);
    }
    let library = createPlaygroundLibrary();
    try {
      const savedLibrary = localStorage.getItem(PLAYGROUND_LIBRARY_STORAGE_KEY);
      if (savedLibrary) library = parsePlaygroundLibrary(savedLibrary);
    } catch (error) {
      this.setPlaygroundStatus(error instanceof Error ? error.message : String(error), true);
    }
    if (library.items.length === 0 && legacyPlayground) {
      library = upsertPlaygroundLibrary(library, legacyPlayground);
      try { localStorage.setItem(PLAYGROUND_LIBRARY_STORAGE_KEY, JSON.stringify(library)); } catch { /* Browser保存が使えない場合も旧保存は残す。 */ }
    }
    this.playgroundLibrary = library;
    const selected = library.items.find((item) => item.definition.name === library.selected);
    this.playground = selected ? clonePlayground(selected.definition) : legacyPlayground ?? this.playground;
    this.playgroundNameDraft = this.playground.name;
    this.setStageLibraryMessage(library.items.length > 0 ? '保存Stageを選択すると読み込みます。' : '保存Stageはまだありません。');
    if (!this.playground.objects.some((object) => object.id === this.selectedPlaygroundId)) this.selectedPlaygroundId = this.playground.objects[0].id;
    this.applyPlaygroundToSimulation();
    this.renderPlaygroundEditor();
  }
  refreshStageHandles(): void {
    if (this.activeView === 'stage') this.updateHandles();
  }
  setTransport(transport: TransportAdapter): void {
    this.transport = transport;
    this.backupActionStatusTracker = new BackupActionStatusTracker();
    this.backupTaskByGoalId.clear();
    const navigationTopics: TopicName[] = ['/tf', '/map', '/pose', '/amcl_pose', '/plan', '/local_plan', '/backup/_action/status', '/control/mode', '/system/runtime_mode', '/map_library/state', '/vision/detections', '/vision/annotated/compressed', '/vision/status'];
    navigationTopics.forEach((topic) => transport.subscribe(topic, topicType(topic), () => undefined));
    window.setInterval(() => void this.refreshRosGraph(), 3000);
  }

  setConnection(state: ConnectionState, detail = ''): void {
    this.dispatchAppEvent({ type: 'TRANSPORT_CHANGED', connection: state, detail }, false);
    if (state !== 'CONNECTED') {
      this.missingGraphChecks = 0;
      this.explorationGraphFailureChecks = 0;
    }
    if (state !== 'CONNECTED') {
      this.yoloConnected = false;
      this.latestDetections = null;
      this.find('#yolo-status').textContent = '未接続（偽bboxなし）';
      this.find('#vision-device').textContent = 'YOLOX-Nano / 未接続';
      this.drawDetectionOverlay();
    }
    this.renderObjectSearchSummary();
    this.updateSaveMapButton();
    const pill = this.find('#connection-status');
    pill.classList.toggle('error', state === 'ERROR');
    this.renderRuntimeButtons();
    this.updateControlLeasePresentation();
    if (state === 'CONNECTED') {
      this.find('#nav-status').textContent = this.isInteractionLocked()
        ? 'ROS接続済み / mapと自機位置を初期化中'
        : this.renderedRuntimeMode === null || this.renderedRuntimeMode === 'sim'
        ? 'ROS接続済み / 構成を確認中'
        : this.runtimeIdleStatus();
      this.requestMapLibrary('list');
    }
    if (state === 'ERROR') { this.find('#nav-status').textContent = 'ROS接続エラー'; this.showNarration(`ROS 2へ接続できませんでした。速度を0にしています。${detail ? ' 接続構成を確認するか、SIMモードで学習を続けられます。' : ' SIMモードで学習を続けます。'}`); }
  }

  bindControlLease(requestControlLease: () => Promise<boolean>): void {
    this.requestControlLease = requestControlLease;
    const buttons = [...this.root.querySelectorAll<HTMLButtonElement>('[data-control-lease]')];
    buttons.forEach((button) => button.addEventListener('click', () => {
      if (buttons.some((candidate) => candidate.disabled) || !this.requestControlLease) return;
      buttons.forEach((candidate) => { candidate.disabled = true; candidate.textContent = '取得中…'; });
      void this.requestControlLease().then((owned) => {
        if (!owned) this.showNarration('操作権を取得できませんでした。接続を確認してもう一度試してください。');
      }).finally(() => {
        buttons.forEach((candidate) => {
          candidate.disabled = false;
          candidate.textContent = candidate.id === 'control-lease-button' ? '操作権を取得' : 'この端末で操作';
        });
      });
    }));
  }

  setControlLeaseOwner(owner: boolean): void {
    const changed = this.controlLeaseOwner !== owner;
    this.controlLeaseOwner = owner;
    this.root.dataset.controlOwnership = owner ? 'owner' : 'viewer';
    this.dispatchAppEvent({ type: 'CONTROL_LEASE_CHANGED', owner, changedAtMs: Date.now() }, false);
    this.renderRuntimeButtons();
    this.renderNavigationControlButtons();
    this.renderExplorationControls();
    this.updateSaveMapButton();
    this.updateControlLeasePresentation();
    this.updateTabletControlDockPresentation();
    if (changed && this.connectionState === 'CONNECTED') {
      this.showNarration(owner
        ? 'この画面がROS 2の操作権を取得しました。センサー・現在位置・速度命令の送信元はこの画面だけです。'
        : '別の画面がROS 2の操作権を持っています。この画面は購読専用です。「操作権を取得」で安全に切り替えられます。');
    }
  }

  private updateControlLeasePresentation(): void {
    const sharedRuntime = this.runtimeMode !== 'sim' && this.connectionState !== 'SIMULATED';
    const viewer = sharedRuntime && !this.controlLeaseOwner;
    this.transportLabel.textContent = viewer
      ? '購読専用 / 別画面が操作中'
      : this.connectionState === 'CONNECTED'
        ? 'rosbridge / Jazzy / 操作中'
        : this.connectionState === 'CONNECTING' || this.connectionState === 'RECONNECTING'
          ? 'rosbridge 再接続中'
          : 'Local Topic Bus';
    this.find<HTMLButtonElement>('#control-lease-button').hidden = !viewer;
    this.find<HTMLElement>('#control-lease-banner').hidden = !viewer;
    const exitButton = this.find<HTMLButtonElement>('#app-exit-button');
    exitButton.disabled = viewer;
    exitButton.title = viewer ? '先に「この端末で操作」を押して操作権を取得してください' : 'フロントとROS 2を終了';
    this.find<HTMLButtonElement>('#stop-button').disabled = viewer;
  }

  bindRuntimeControls(requestMode: (mode: RuntimeMode) => Promise<boolean>): void {
    this.requestRuntimeMode = requestMode;
    this.find<HTMLButtonElement>('#connection-status').addEventListener('click', () => this.dispatchAppEvent({ type: 'RUNTIME_SWITCH_REQUESTED', target: this.runtimeManagerState.mode === 'sim' ? 'base' : 'sim' }));
    this.find<HTMLButtonElement>('#map-runtime-toggle').addEventListener('click', () => this.dispatchAppEvent({ type: 'RUNTIME_SWITCH_REQUESTED', target: this.runtimeManagerState.mode === 'mapping' || this.runtimeManagerState.mode === 'navigation' || this.runtimeManagerState.mode === 'exploration' ? 'base' : 'mapping' }));
    this.find<HTMLButtonElement>('#nav-runtime-toggle').addEventListener('click', () => this.dispatchAppEvent({ type: 'RUNTIME_SWITCH_REQUESTED', target: this.runtimeManagerState.mode === 'navigation' || this.runtimeManagerState.mode === 'exploration' ? 'mapping' : 'navigation' }));
  }

  bindAppExit(requestShutdown: () => Promise<boolean>): void {
    const button = this.find<HTMLButtonElement>('#app-exit-button');
    button.addEventListener('click', () => {
      if (!this.hasRuntimeControl()) { this.showNarration('ROS 2を終了するには、この画面へ操作権を切り替えてください。'); return; }
      if (button.disabled || !window.confirm('フロントとROS 2 backendを終了します。よろしいですか？')) return;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.textContent = '終了中…';
      void requestShutdown().then((success) => {
        if (success) return;
        button.disabled = false;
        button.removeAttribute('aria-busy');
        button.textContent = 'アプリ終了';
        this.showNarration('アプリを終了できませんでした。ターミナルの ./stop.sh を実行してください。');
      });
    });
  }


  setRuntimeManagerState(state: RuntimeManagerState): void {
    this.dispatchAppEvent({ type: 'RUNTIME_MANAGER_OBSERVED', snapshot: state }, false);
  }

  private renderRuntimeButtons(): void {
    const state = this.runtimeManagerState;
    const switching = this.isInteractionLocked();
    const readOnly = state.mode !== 'sim' && !this.controlLeaseOwner;
    const processingLabel = state.phase === 'closing' || state.target === 'sim' ? 'CLOSING…' : 'PROCESSING…';
    const rosActive = state.mode !== 'sim' && this.connectionState === 'CONNECTED';
    const mapActive = state.mode === 'mapping' || state.mode === 'navigation' || state.mode === 'exploration';
    const navActive = state.mode === 'navigation' || state.mode === 'exploration';
    const apply = (button: HTMLButtonElement, active: boolean, label: string): void => {
      button.disabled = switching || readOnly;
      button.classList.toggle('activated', active);
      button.classList.toggle('deactivated', !active);
      button.classList.toggle('processing', switching);
      button.textContent = switching ? processingLabel : `${label} ${active ? 'activated' : 'deactivated'}`;
      button.setAttribute('aria-pressed', String(active));
    };
    apply(this.find<HTMLButtonElement>('#map-runtime-toggle'), mapActive, 'MAP');
    apply(this.find<HTMLButtonElement>('#nav-runtime-toggle'), navActive, 'NAV2');
    const rosButton = this.find<HTMLButtonElement>('#connection-status');
    apply(rosButton, rosActive, 'ROS2');
    if (!switching) {
      const dot = document.createElement('span');
      dot.className = 'status-dot';
      const label = document.createElement('span');
      label.textContent = `ROS2 ${rosActive ? 'activated' : 'deactivated'}`;
      rosButton.replaceChildren(dot, label);
    }
    this.renderNavigationControlButtons();
    this.updateControlLeasePresentation();
  }

  onTopicEvent(event: TransportEvent): void {
    const rosSessionTopic = event.topic === '/map'
      || event.topic === '/pose'
      || event.topic === '/amcl_pose'
      || event.topic === '/tf'
      || event.topic === '/plan'
      || event.topic === '/local_plan'
      || event.topic === '/backup/_action/status';
    if (rosSessionTopic && this.runtimeMode !== 'sim' && this.transport?.getConnectionState() !== 'CONNECTED') return;
    this.eventLog.set(event.topic, event.message);
    this.animateFlow(event.topic);
    if (event.topic === this.selectedTopic) this.renderInspector(event.topic, event.message);
    if (event.topic === '/cmd_vel') {
      const twist = event.message as TwistMessage;
      this.dispatchAppEvent({
        type: 'ROBOT_MOTION_OBSERVED',
        generation: this.appState.objectSearch.generation,
        transportCycle: this.appState.transportCycle,
        observedAtMs: Date.now(),
        linearX: twist.linear.x,
        angularZ: twist.angular.z,
      }, false);
    }
    if (event.topic === '/backup/_action/status') this.observeBackupActionStatus(event.message as GoalStatusArrayMessage);
    if (event.topic === '/safety/stop') {
      const stopped = unwrapBool(event.message);
      const changed = stopped !== this.safetyStopped;
      this.safetyStopped = stopped;
      const source = this.transport?.getConnectionState() === 'CONNECTED' ? '実Safety Controller' : 'SIMのSafety Controller';
      this.dispatchAppEvent({ type: 'SAFETY_CHANGED', stopped, status: `${source}のSafety stop / 速度0` }, false);
      if (!stopped && changed && this.pendingBackupDiversionTaskId !== null) {
        const taskId = this.pendingBackupDiversionTaskId;
        this.pendingBackupDiversionTaskId = null;
        this.requestExplorationRecoveryDiversion(taskId);
      }
      if (stopped && changed) {
        const navigationActive = (this.appState.navigation.status === 'sending' || this.appState.navigation.status === 'moving')
          && this.appState.command.owner === 'navigation';
        if (this.runtimeMode === 'exploration') this.explorationLastReason = navigationActive
          ? `${source}が前進を制限中です。5秒間進めない場合だけNav2が1回後退し、成功後は遠方変更${this.explorationDiversionEnabled ? 'ONのため別goalを選びます' : 'OFFのため同じgoalを再計画します'}。`
          : `${source}が前進速度を0にしました。手動の後退と旋回はできます。`;
        this.showNarration(navigationActive
          ? `${source}が前進を制限しています。5秒間進めない場合だけNav2が衝突予測付きで1回後退します。その場旋回は行いません。`
          : `${source}が前方の障害物を検知し、前進速度を0にしました。後退と旋回はできます。`);
      }
    }
    if (event.topic === '/map') {
      const map = event.message as OccupancyGridMessage;
      if (map.info && Array.isArray(map.data)) {
        const observedAtMs = rosTimeToMilliseconds(map.header.stamp);
        if (this.runtimeMode === 'exploration'
          && (!Number.isFinite(observedAtMs) || observedAtMs <= this.explorationEvidenceNotBeforeMs)) return;
        if (!this.dispatchAppEvent({ type: 'MAP_RECEIVED', cycle: this.appState.map.cycle }, false)) return;
        this.occupancyMap = map;
        this.latestMapReceivedAt = observedAtMs;
        if (this.runtimeMode === 'exploration') {
          this.explorationCoverage = summarizeExplorationCoverageFromOccupancyGrid(map.data);
          this.explorationMapGeneration += 1;
          this.explorationMapSnapshots.set(this.explorationMapGeneration, map);
          while (this.explorationMapSnapshots.size > 3) this.explorationMapSnapshots.delete(this.explorationMapSnapshots.keys().next().value as number);
          this.dispatchAppEvent({
            type: 'EXPLORATION_MAP_OBSERVED',
            cycle: this.appState.map.cycle,
            mapGeneration: this.explorationMapGeneration,
            observedAtMs,
          }, false);
        }
        this.mapEmpty.hidden = true;
        this.scheduleNavigationMap(true);
        if (this.runtimeMode === 'exploration') this.evaluateWaitingExplorationOnFreshMap();
      }
    }
    if (event.topic === '/pose') {
      const pose = event.message as PoseWithCovarianceStampedMessage;
      this.latestSlamPose = { header: pose.header, pose: pose.pose.pose };
      if (this.runtimeMode === 'mapping' || this.runtimeMode === 'exploration') {
        this.syncMappingPose();
      }
    }
    if (event.topic === '/tf') {
      const tf = event.message as TfMessage;
      const mapToOdom = tf.transforms?.find((transform) => transform.header.frame_id.replace(/^\//, '') === 'map' && transform.child_frame_id.replace(/^\//, '') === 'odom');
      if (mapToOdom) {
        this.latestMapToOdom = mapToOdom;
        const navigation = this.appState.navigation;
        if ((navigation.status === 'sending' || navigation.status === 'moving')
          && navigation.source === 'exploration'
          && navigationTransformFreshness(mapToOdom, Date.now()).status !== 'fresh') {
          this.explorationTasksWithStaleTransform.add(navigation.taskId);
        }
        this.rememberStamped(this.mapToOdomHistory, mapToOdom);
        if (this.runtimeMode === 'navigation') this.syncNavigationPose();
        if (this.runtimeMode === 'mapping' || this.runtimeMode === 'exploration') this.syncMappingPose();
        if ((this.runtimeMode === 'navigation' || this.runtimeMode === 'exploration') && this.latestScan) this.scheduleNavigationMap();
      }
    }
    if (event.topic === '/amcl_pose') {
      const pose = event.message as PoseWithCovarianceStampedMessage;
      this.latestAmclPose = { header: pose.header, pose: pose.pose.pose };
      this.syncNavigationPose();
      this.scheduleNavigationMap();
    }
    const navigationTaskActive = this.appState.navigation.status === 'sending' || this.appState.navigation.status === 'moving';
    if (event.topic === '/plan' && navigationTaskActive) { this.globalPath = event.message as PathMessage; this.updatePathText(); this.scheduleNavigationMap(); }
    if (event.topic === '/local_plan' && navigationTaskActive) { this.localPath = event.message as PathMessage; this.updatePathText(); this.scheduleNavigationMap(); }
    if (event.topic === '/control/mode') this.setNavigationControl(unwrapString(event.message) === 'navigation', false);
    if (event.topic === '/map_library/state') this.renderMapLibraryState(unwrapString(event.message));
    if (event.topic === '/vision/detections') {
      this.latestDetections = event.message as Detection2DArrayMessage;
      this.dispatchAppEvent({
        type: 'VISION_DETECTOR_OBSERVED',
        cycle: this.appState.vision.cycle,
        observedAtMs: Date.now(),
        frameObservedAtMs: rosTimeToMilliseconds(this.latestDetections.header.stamp),
      }, false);
      this.observeObjectSearchDetection(this.latestDetections);
      this.drawDetectionOverlay();
      this.renderObjectSearchSummary();
    }
    if (event.topic === '/vision/status') this.renderVisionStatus(unwrapString(event.message));
    if (event.topic === '/odom' || event.topic === '/pose' || event.topic === '/amcl_pose' || event.topic === '/tf') {
      this.publishNavigationGoalDistance();
    }
  }

  renderVisionFrame(frame: VisionFrame): void {
    this.latestVisionFrame = frame;
    this.dispatchAppEvent({ type: 'VISION_FRAME_OBSERVED', cycle: this.appState.vision.cycle, observedAtMs: frame.capturedAtMs }, false);
    const rgbContext = this.rgbCameraCanvas.getContext('2d');
    if (rgbContext) {
      const image = rgbContext.createImageData(frame.width, frame.height);
      image.data.set(frame.rgb);
      rgbContext.putImageData(image, 0, 0);
    }
    const depthContext = this.depthCameraCanvas.getContext('2d');
    if (depthContext) {
      const image = depthContext.createImageData(frame.width, frame.height);
      for (let index = 0; index < frame.depthMeters.length; index += 1) {
        const [red, green, blue] = depthToPseudoColor(frame.depthMeters[index]);
        const offset = index * 4;
        image.data[offset] = red;
        image.data[offset + 1] = green;
        image.data[offset + 2] = blue;
        image.data[offset + 3] = 255;
      }
      depthContext.putImageData(image, 0, 0);
    }
    this.find('#vision-source').textContent = this.connectionState === 'CONNECTED' ? 'ROS CAMERA TOPICS' : 'SIM CAMERA';
    this.find('#vision-timestamp').textContent = `${frame.stamp.sec}.${String(frame.stamp.nanosec).padStart(9, '0')} / 差 0 ms`;
    this.markMission('camera');
    this.drawDetectionOverlay();
    this.renderObjectSearchSummary();
  }

  renderScan(scan: LaserScanMessage): void {
    this.latestScan = scan;
    this.drawLidar(scan);
    if (this.runtimeMode === 'navigation' || this.runtimeMode === 'exploration') this.scheduleNavigationMap();
    if (this.selectedTopic === '/scan') this.renderInspector('/scan', scan);
  }

  renderOdom(odom: OdometryMessage): void {
    if (this.selectedTopic === '/odom') this.renderInspector('/odom', odom);
    this.latestOdomPose = { header: odom.header, pose: odom.pose.pose };
    this.rememberStamped(this.odomHistory, this.latestOdomPose);
    if ((this.runtimeMode === 'navigation' || this.runtimeMode === 'exploration') && this.latestScan) this.scheduleNavigationMap();
    if (this.runtimeMode === 'navigation') {
      this.syncNavigationPose();
    } else if (this.runtimeMode === 'mapping' || this.runtimeMode === 'exploration') {
      this.syncMappingPose();
    } else {
      this.currentPose = this.latestOdomPose;
      this.updatePoseText();
      this.scheduleNavigationMap();
    }
  }

  renderStatus(status: { frontDistance: number; speed: number; fps: number; stopped: boolean }): void {
    this.find('#front-distance').textContent = formatNumber(status.frontDistance);
    this.find('#current-speed').textContent = formatNumber(status.speed);
    this.find('#fps-value').textContent = status.fps > 0 ? String(status.fps) : '--';
    if (status.stopped) this.find('#scene-hint').textContent = 'Safety停止中 / 後退できます';
    else this.find('#scene-hint').textContent = 'WASD / 矢印キーで操作';
  }

  showNarration(message: string): void { this.narration.textContent = message; this.narration.classList.remove('narration-pop'); void this.narration.offsetWidth; this.narration.classList.add('narration-pop'); }

  private requestSafeStop(status = '緊急停止 / Nav2目標を取り消しました'): void {
    if (this.dispatchAppEvent({ type: 'SAFE_STOP_REQUESTED', status })) this.showNarration('緊急停止しました。Nav2目標も取り消し、安全のため速度を0にしています。');
  }

  private updateTabletControlDockPresentation(): void {
    const enabled = this.activeView === 'sim' && this.hasRuntimeControl();
    this.tabletControlDock.hidden = !enabled || !this.tabletControlDockVisible;
    this.tabletControlDockOpen.hidden = !enabled || this.tabletControlDockVisible;
    if (enabled && this.tabletControlDockVisible) this.applyTabletControlDockPosition();
  }

  private applyTabletControlDockPosition(): void {
    if (!this.tabletControlDockPosition) return;
    const rect = this.tabletControlDock.getBoundingClientRect();
    const position = clampTabletControlDockPosition(
      this.tabletControlDockPosition,
      { width: window.innerWidth, height: window.innerHeight },
      { width: rect.width, height: rect.height },
    );
    this.tabletControlDockPosition = position;
    this.tabletControlDock.style.left = `${position.left}px`;
    this.tabletControlDock.style.top = `${position.top}px`;
    this.tabletControlDock.style.right = 'auto';
    this.tabletControlDock.style.bottom = 'auto';
  }

  private bindTabletControlDock(): void {
    const handle = this.tabletControlDockHandle;
    let drag: { pointerId: number; offsetX: number; offsetY: number } | null = null;
    const persistPosition = (): void => {
      if (!this.tabletControlDockPosition) return;
      try { localStorage.setItem(TABLET_CONTROL_DOCK_POSITION_STORAGE_KEY, JSON.stringify(this.tabletControlDockPosition)); } catch { /* storage is optional */ }
    };
    const finishDrag = (event?: PointerEvent): void => {
      if (!drag || (event && event.pointerId !== drag.pointerId)) return;
      if (event) {
        try { handle.releasePointerCapture?.(event.pointerId); } catch { /* Safari may reject capture */ }
      }
      drag = null;
      this.tabletControlDock.classList.remove('dragging');
      persistPosition();
    };
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 && event.pointerType !== 'touch') return;
      event.preventDefault();
      const rect = this.tabletControlDock.getBoundingClientRect();
      this.tabletControlDockPosition = this.tabletControlDockPosition ?? { left: rect.left, top: rect.top };
      this.applyTabletControlDockPosition();
      const positionedRect = this.tabletControlDock.getBoundingClientRect();
      drag = { pointerId: event.pointerId, offsetX: event.clientX - positionedRect.left, offsetY: event.clientY - positionedRect.top };
      this.tabletControlDock.classList.add('dragging');
      try { handle.setPointerCapture?.(event.pointerId); } catch { /* Safari may reject capture */ }
    });
    handle.addEventListener('pointermove', (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.preventDefault();
      this.tabletControlDockPosition = clampTabletControlDockPosition(
        { left: event.clientX - drag.offsetX, top: event.clientY - drag.offsetY },
        { width: window.innerWidth, height: window.innerHeight },
        { width: this.tabletControlDock.offsetWidth, height: this.tabletControlDock.offsetHeight },
      );
      this.applyTabletControlDockPosition();
    });
    handle.addEventListener('pointerup', (event) => finishDrag(event));
    handle.addEventListener('pointercancel', (event) => finishDrag(event));
    handle.addEventListener('lostpointercapture', () => finishDrag());
    handle.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 48 : 12;
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const rect = this.tabletControlDock.getBoundingClientRect();
      const current = this.tabletControlDockPosition ?? { left: rect.left, top: rect.top };
      this.tabletControlDockPosition = clampTabletControlDockPosition({
        left: current.left + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0),
        top: current.top + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0),
      }, { width: window.innerWidth, height: window.innerHeight }, { width: rect.width, height: rect.height });
      this.applyTabletControlDockPosition();
      persistPosition();
    });
    this.find<HTMLButtonElement>('#tablet-control-dock-close').addEventListener('click', () => {
      this.tabletControlDockVisible = false;
      try { localStorage.setItem(TABLET_CONTROL_DOCK_HIDDEN_STORAGE_KEY, 'true'); } catch { /* storage is optional */ }
      this.updateTabletControlDockPresentation();
    });
    this.tabletControlDockOpen.addEventListener('click', () => {
      this.tabletControlDockVisible = true;
      try { localStorage.removeItem(TABLET_CONTROL_DOCK_HIDDEN_STORAGE_KEY); } catch { /* storage is optional */ }
      this.updateTabletControlDockPresentation();
      this.tabletControlDockHandle.focus();
    });
    window.addEventListener('resize', () => this.applyTabletControlDockPosition());
  }

  markMission(id: string): void { if (this.missions.has(id)) return; this.missions.add(id); localStorage.setItem('ros2-visual-starter-missions', JSON.stringify([...this.missions])); const item = this.root.querySelector(`[data-mission="${id}"]`); item?.classList.add('done'); this.renderMissionProgress(); }

  bindSimulationControls(simulation: Simulation): void {
    const keyMap = new Map<string, { linear: number; angular: number }>([
      ['w', { linear: 1, angular: 0 }], ['arrowup', { linear: 1, angular: 0 }],
      ['s', { linear: -.6, angular: 0 }], ['arrowdown', { linear: -.6, angular: 0 }],
      ['a', { linear: 0, angular: 1.8 }], ['arrowleft', { linear: 0, angular: 1.8 }],
      ['d', { linear: 0, angular: -1.8 }], ['arrowright', { linear: 0, angular: -1.8 }],
    ]);
    const pressed = new Set<string>();
    const constrainInput = (input: { linear: number; angular: number }): { linear: number; angular: number } => this.runtimeMode === 'mapping' || this.runtimeMode === 'exploration'
      ? { linear: clampRange(input.linear, -.35, .45), angular: clampRange(input.angular, -1.1, 1.1) }
      : input;
    const update = (): void => {
      if (!this.canAcceptManualMotion()) {
        pressed.clear();
        simulation.setInput({ linear: 0, angular: 0 });
        return;
      }
      const values = [...pressed].map((key) => keyMap.get(key)).filter((value): value is { linear: number; angular: number } => value !== undefined);
      const input = constrainInput(values.reduce((sum, value) => ({ linear: Math.max(-.6, Math.min(1, sum.linear + value.linear)), angular: Math.max(-1.8, Math.min(1.8, sum.angular + value.angular)) }), { linear: 0, angular: 0 }));
      simulation.setInput(input);
      if (values.some((value) => value.linear !== 0 || value.angular !== 0)) this.markMission('move');
    };
    this.releaseUserInput = () => {
      pressed.clear();
      this.stageFlyKeys.clear();
      this.spaceDown = false;
      simulation.setInput({ linear: 0, angular: 0 });
      this.updateFlyInput();
    };
    const isTextEntry = (target: EventTarget | null): boolean => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable);
    window.addEventListener('keydown', (event) => {
      if (isTextEntry(event.target)) return;
      const key = event.key.toLowerCase();
      if (this.isInteractionLocked()) {
        if (key === ' ' || key === 'r' || keyMap.has(key) || key === 'q' || key === 'delete') event.preventDefault();
        return;
      }
      if (this.activeView === 'stage') {
        if (key === 'delete') { event.preventDefault(); this.deleteSelectedPlaygroundObject(); return; }
        if (key === 'w' || key === 'a' || key === 's' || key === 'd' || key === 'q' || key === 'r') { event.preventDefault(); this.stageFlyKeys.add(key); this.updateFlyInput(); }
        else if (key === ' ') { event.preventDefault(); this.spaceDown = true; }
        return;
      }
      if (this.runtimeMode === 'exploration' && keyMap.has(key) && canPauseExploration(this.appState)) {
        if (this.dispatchAppEvent({ type: 'COMMAND_OWNER_REQUESTED', owner: 'manual', requestedAtMs: Date.now() }, false)) {
          this.explorationLastReason = 'WASD／矢印キーの手動overrideで探索を一時停止しました。';
          this.renderExplorationControls();
        }
      }
      if (key === 'r') {
        event.preventDefault();
        this.dispatchAppEvent({ type: 'ROBOT_ORIGIN_RESET_REQUESTED' });
        return;
      }
      if (!this.canAcceptManualMotion()) {
        if (key === ' ' || key === 'r' || keyMap.has(key)) event.preventDefault();
        return;
      }
      if (key === ' ' || key === 'r' || keyMap.has(key)) event.preventDefault();
      if (key === ' ') this.requestSafeStop(); else if (keyMap.has(key)) { pressed.add(key); update(); }
    });
    window.addEventListener('keyup', (event) => {
      if (isTextEntry(event.target)) return;
      const key = event.key.toLowerCase();
      if (this.isInteractionLocked()) {
        if (keyMap.has(key)) pressed.delete(key);
        return;
      }
      if (this.activeView === 'stage') {
        if (this.stageFlyKeys.delete(key)) this.updateFlyInput();
        if (key === ' ') this.spaceDown = false;
        return;
      }
      if (!this.canAcceptManualMotion()) {
        if (keyMap.has(key)) pressed.delete(key);
        return;
      }
      if (keyMap.has(key)) { pressed.delete(key); update(); }
    });
    this.root.addEventListener('focusin', (event) => { if (isTextEntry(event.target)) { pressed.clear(); simulation.setInput({ linear: 0, angular: 0 }); } });
    window.addEventListener('blur', () => this.dispatchAppEvent({ type: 'WINDOW_FOCUS_LOST' }, false));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.requestSafeStop('画面が非表示になったため停止しました');
    });

    this.root.querySelectorAll<HTMLElement>('[data-control]').forEach((button) => {
      const control = button.dataset.control ?? '';
      const rawInput = control === 'forward' ? { linear: 1, angular: 0 } : control === 'backward' ? { linear: -.6, angular: 0 } : control === 'left' ? { linear: 0, angular: 1.8 } : control === 'right' ? { linear: 0, angular: -1.8 } : { linear: 0, angular: 0 };
      const start = (event: PointerEvent): void => {
        event.preventDefault();
        if (control !== 'stop' && this.runtimeMode === 'exploration' && canPauseExploration(this.appState)) {
          if (this.dispatchAppEvent({ type: 'COMMAND_OWNER_REQUESTED', owner: 'manual', requestedAtMs: Date.now() }, false)) {
            this.explorationLastReason = '操作パッドの手動overrideで探索を一時停止しました。';
            this.renderExplorationControls();
          }
        }
        if (control !== 'stop' && !this.canAcceptManualMotion()) return;
        try { button.setPointerCapture?.(event.pointerId); } catch { /* Safari may reject capture while still delivering pointer events */ }
        button.classList.add('pressed');
        if (control === 'stop') this.requestSafeStop();
        else { simulation.setInput(constrainInput(rawInput)); this.markMission('move'); }
      };
      const end = (): void => { button.classList.remove('pressed'); if (control !== 'stop') simulation.setInput({ linear: 0, angular: 0 }); };
      button.addEventListener('pointerdown', start); button.addEventListener('pointerup', end); button.addEventListener('pointercancel', end); button.addEventListener('pointerleave', end);
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-reset-origin]').forEach((button) => {
      button.addEventListener('click', () => this.dispatchAppEvent({ type: 'ROBOT_ORIGIN_RESET_REQUESTED' }));
    });
    this.find<HTMLButtonElement>('#stop-button').addEventListener('click', () => this.requestSafeStop());
    const robotCameraButton = this.find<HTMLButtonElement>('#robot-camera-toggle');
    const topCameraButton = this.find<HTMLButtonElement>('#camera-toggle');
    const centerCameraButton = this.find<HTMLButtonElement>('#camera-center-toggle');
    const selectCameraMode = (requestedMode: Exclude<CameraMode, 'follow'>): void => {
      this.cameraMode = this.cameraMode === requestedMode ? 'follow' : requestedMode;
      simulation.setCameraMode(this.cameraMode);
      const robotActive = this.cameraMode === 'robot';
      const topActive = this.cameraMode === 'top';
      robotCameraButton.classList.toggle('active', robotActive);
      topCameraButton.classList.toggle('active', topActive);
      robotCameraButton.setAttribute('aria-pressed', String(robotActive));
      topCameraButton.setAttribute('aria-pressed', String(topActive));
      this.renderSimTopZoomControls();
      this.showNarration(robotActive ? '自機カメラに切り替えました。ロボット前面のカメラから進行方向を見ています。' : topActive ? '上面視点に切り替えました。初期方位は右のmapと同じ、ROS +Yが画面上です。' : 'ロボット追従視点に戻しました。');
    };
    robotCameraButton.addEventListener('click', () => selectCameraMode('robot'));
    topCameraButton.addEventListener('click', () => selectCameraMode('top'));
    const changeSimTopCameraZoom = (next: number): void => {
      this.simTopCameraZoom = clampSimTopCameraZoom(next);
      simulation.setTopCameraZoom(this.simTopCameraZoom);
      this.showNarration(`SIM上面図を${Math.round(this.simTopCameraZoom * 100)}%にしました。Fitで初期表示へ戻せます。`);
    };
    this.find<HTMLButtonElement>('#sim-top-zoom-in').addEventListener('click', () => changeSimTopCameraZoom(this.simTopCameraZoom * SIM_TOP_CAMERA_ZOOM_STEP));
    this.find<HTMLButtonElement>('#sim-top-zoom-out').addEventListener('click', () => changeSimTopCameraZoom(this.simTopCameraZoom / SIM_TOP_CAMERA_ZOOM_STEP));
    this.find<HTMLButtonElement>('#sim-top-fit').addEventListener('click', () => changeSimTopCameraZoom(1));
    let robotCentered = false;
    centerCameraButton.addEventListener('click', () => {
      robotCentered = !robotCentered;
      simulation.setRobotCenteredCamera(robotCentered);
      centerCameraButton.classList.toggle('active', robotCentered);
      centerCameraButton.setAttribute('aria-pressed', String(robotCentered));
      centerCameraButton.setAttribute('aria-label', robotCentered ? 'ロボット中心の回転を解除' : 'ロボット中心の回転にする');
      this.showNarration(robotCentered ? '追従視点と上面視点を、ロボットの向きを上にして回転します。' : '追従視点と上面視点の方位を固定しました。ロボットが旋回しても画面は回転しません。');
    });
    this.find<HTMLButtonElement>('#lidar-toggle').addEventListener('click', (event) => { const button = event.currentTarget as HTMLButtonElement; const visible = button.dataset.visible !== 'false'; button.dataset.visible = String(!visible); button.classList.toggle('active', !visible); const state = button.querySelector('span'); if (state) state.textContent = !visible ? 'ON' : 'OFF'; simulation.setLidarVisible(!visible); this.showNarration(!visible ? 'LiDARの光線を表示しました。2Dスキャンと同じ距離を見ています。' : 'LiDARの光線を隠しました。センサーのデータ自体は更新され続けます。'); });
  }

  private bindVisionControls(): void {
    this.depthCameraCanvas.addEventListener('pointerdown', (event) => {
      const frame = this.latestVisionFrame;
      if (!frame) return;
      const rect = this.depthCameraCanvas.getBoundingClientRect();
      const x = Math.max(0, Math.min(frame.width - 1, Math.floor((event.clientX - rect.left) / rect.width * frame.width)));
      const y = Math.max(0, Math.min(frame.height - 1, Math.floor((event.clientY - rect.top) / rect.height * frame.height)));
      const distance = frame.depthMeters[y * frame.width + x];
      this.find('#depth-cursor').textContent = Number.isFinite(distance)
        ? `pixel (${x}, ${y}) = ${formatNumber(distance, 3)} m / camera_rgb_optical_frameのZ距離`
        : `pixel (${x}, ${y}) = 未計測（invalidまたは0.10〜8.00 mのclip外）`;
      this.markMission('depth');
      if (this.latestScan) this.markMission('compare');
    });
  }

  private bindObjectSearchChat(): void {
    const form = this.find<HTMLFormElement>('#object-search-form');
    const input = this.find<HTMLInputElement>('#object-search-input');
    input.addEventListener('compositionstart', () => { this.objectSearchInputComposing = true; });
    input.addEventListener('compositionend', () => { this.objectSearchInputComposing = false; });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (this.objectSearchInputComposing || event.isComposing)) event.preventDefault();
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (this.objectSearchInputComposing || !input.value.trim()) return;
      this.submitObjectSearchChatText(input.value);
      input.value = '';
    });
    this.find<HTMLButtonElement>('#object-search-cancel').addEventListener('click', () => {
      this.submitObjectSearchChatText('探索を中止');
      input.focus();
    });
    this.find<HTMLButtonElement>('#object-search-resume').addEventListener('click', () => {
      this.submitObjectSearchChatText('探索を再開して');
      input.focus();
    });
  }

  private submitObjectSearchChatText(input: string): void {
    const routedIntent = routeObjectSearchIntent(input);
    const deterministicIntent = routedIntent.intent;
    if (deterministicIntent.type === 'cancel_object_search' && localLlmRequestIsPending(this.localLlmRequest)) {
      const mission = this.appState.objectSearch;
      this.invalidatePendingLocalLlm('ユーザーがLocal LLM requestを中止しました。', false);
      if (mission.status !== 'idle' && mission.status !== 'canceled') {
        this.submitRuleBasedObjectSearchText(input);
      } else {
        this.appendObjectSearchChatMessage('user', deterministicIntent.sourceText);
        this.appendObjectSearchChatMessage('robot', 'Local LLM requestを中止しました。Robotは停止状態です。');
        this.renderObjectSearchChat();
      }
      return;
    }
    if (routedIntent.route !== 'optional_llm') {
      this.submitRuleBasedObjectSearchText(input);
      return;
    }
    if (localLlmRequestIsPending(this.localLlmRequest)) {
      this.showNarration('Local LLMが処理中です。中止する場合は「探索を中止」を押してください。');
      return;
    }
    const ownsRequestContext = this.runtimeMode === 'sim'
      || (this.controlLeaseOwner && this.appState.controlLease.owner);
    if (!ownsRequestContext) {
      this.appendObjectSearchChatMessage('user', input.normalize('NFKC').trim());
      this.appendObjectSearchChatMessage('error', 'この端末に操作権がないためLocal LLM requestを送信しません。「この端末で操作」を押してください。');
      this.renderObjectSearchChat();
      return;
    }
    if (this.localLlmStatus.state !== 'ready') {
      const unavailableReason = this.localLlmStatus.state === 'disabled'
        ? 'Optional Local LLMは無効です。rule-based parserで解釈できる命令だけを使用できます。'
        : this.localLlmStatus.error || 'Optional Local LLMを利用できません。rule-based parserで解釈できる命令だけを使用できます。';
      this.appendObjectSearchChatMessage('user', deterministicIntent.sourceText);
      this.appendObjectSearchChatMessage('error', unavailableReason);
      this.renderObjectSearchChat();
      return;
    }
    if (this.localLlmStatus.busy) {
      this.appendObjectSearchChatMessage('user', input.normalize('NFKC').trim());
      this.appendObjectSearchChatMessage('error', 'Local LLMは別のrequestを処理中です。完了を待つか探索を中止してください。');
      this.renderObjectSearchChat();
      return;
    }
    try {
      const started = beginLocalLlmRequest(this.localLlmRequest, input, Date.now(), {
        transportCycle: this.appState.transportCycle,
        controlLeaseGeneration: this.appState.controlLease.generation,
        controlLeaseOwner: ownsRequestContext,
      });
      this.localLlmRequest = started.state;
      this.appendObjectSearchChatMessage('user', started.envelope.text);
      this.appendObjectSearchChatMessage('robot', LOCAL_LLM_THINKING_MESSAGE);
      this.localLlmRequestAbort?.abort();
      const abortController = new AbortController();
      this.localLlmRequestAbort = abortController;
      void this.requestLocalLlmIntent(JSON.stringify(started.envelope), abortController);
      this.clearLocalLlmRequestTimer();
      const requestId = started.envelope.request_id;
      const generation = started.envelope.generation;
      this.localLlmRequestTimer = window.setTimeout(() => {
        const pending = this.localLlmRequest.pending;
        if (!pending || pending.requestId !== requestId || pending.generation !== generation) return;
        abortController.abort();
        this.invalidatePendingLocalLlm('Local LLM responseが25秒以内に届かなかったため、Robotを開始しません。', true);
      }, LOCAL_LLM_REQUEST_TIMEOUT_MS);
      this.renderObjectSearchChat();
    } catch (error) {
      this.appendObjectSearchChatMessage('user', input.normalize('NFKC').trim());
      this.appendObjectSearchChatMessage('error', error instanceof Error ? error.message : 'Local LLM requestを作成できません。');
      this.renderObjectSearchChat();
    }
  }

  private async requestLocalLlmIntent(payload: string, abortController: AbortController): Promise<void> {
    try {
      const response = await fetch(appPath('api/llm/intent'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: payload,
        cache: 'no-store',
        signal: abortController.signal,
      });
      const serialized = await response.text();
      if (serialized.length > 8_192) throw new Error('Local LLM responseが上限を超えました。');
      if (this.localLlmRequestAbort !== abortController) return;
      this.observeLocalLlmResult(serialized);
    } catch (error) {
      if (abortController.signal.aborted || this.localLlmRequestAbort !== abortController) return;
      this.invalidatePendingLocalLlm(
        error instanceof Error && error.message ? error.message : 'Local LLMと通信できませんでした。Robotを開始しません。',
        true,
      );
    } finally {
      if (this.localLlmRequestAbort === abortController) this.localLlmRequestAbort = null;
      void this.refreshLocalLlmStatus();
    }
  }

  private submitRuleBasedObjectSearchText(input: string): void {
    const previousChat = this.objectSearchChat;
    const result = submitObjectSearchText(previousChat, input);
    this.handleObjectSearchChatResult(previousChat, result);
  }

  private handleObjectSearchChatResult(previousChat: ObjectSearchChatState, result: ObjectSearchChatResult): void {
    this.objectSearchChat = result.state;
    const mission = this.appState.objectSearch;
    let accepted = true;

    if (result.intent.type === 'find_object'
      && previousChat.status === 'idle'
      && result.state.status === 'accepted') {
      accepted = this.dispatchAppEvent({
        type: 'OBJECT_SEARCH_COMMAND_REQUESTED',
        targetClass: result.intent.targetClass,
        displayName: result.intent.displayName,
        normalizedCommand: result.intent.sourceText,
        requestedAtMs: Date.now(),
      });
    } else if (result.intent.type === 'cancel_object_search'
      && mission.status !== 'idle'
      && mission.status !== 'canceled') {
      accepted = this.dispatchAppEvent({
        type: 'OBJECT_SEARCH_CANCEL_REQUESTED',
        generation: mission.generation,
        requestedAtMs: Date.now(),
      });
    } else if (result.intent.type === 'resume_object_search'
      && (mission.status === 'paused' || mission.status === 'error')) {
      accepted = this.dispatchAppEvent({
        type: 'OBJECT_SEARCH_RESUME_REQUESTED',
        generation: mission.generation,
        visionCycle: this.appState.vision.cycle,
        mapCycle: this.appState.map.cycle,
        mapGeneration: this.appState.explorationEvidence.mapGeneration,
        explorationGeneration: this.appState.exploration.generation,
        requestedAtMs: Date.now(),
      });
    }

    if (!accepted) {
      const lastMessage = this.objectSearchChat.messages.at(-1);
      this.objectSearchChat = {
        ...this.objectSearchChat,
        messages: lastMessage?.role === 'robot'
          ? this.objectSearchChat.messages.slice(0, -1)
          : this.objectSearchChat.messages,
        status: previousChat.status,
        targetClass: previousChat.targetClass,
        acceptedMissionCount: previousChat.acceptedMissionCount,
      };
      this.objectSearchChat = synchronizeObjectSearchChat(
        this.objectSearchChat,
        previousChat.status,
        previousChat.targetClass,
        { role: 'error', text: this.lastAppEventRejection || '現在の状態では物体探索を実行できません。' },
      );
    }
    this.renderObjectSearchChat();
  }

  private appendObjectSearchChatMessage(role: 'user' | 'robot' | 'system' | 'error', text: string): void {
    this.objectSearchChat = synchronizeObjectSearchChat(
      this.objectSearchChat,
      this.objectSearchChat.status,
      this.objectSearchChat.targetClass,
      { role, text },
    );
  }

  private removeLocalLlmThinkingMessage(): void {
    let index = -1;
    for (let messageIndex = this.objectSearchChat.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const message = this.objectSearchChat.messages[messageIndex];
      if (message.role === 'robot' && message.text === LOCAL_LLM_THINKING_MESSAGE) {
        index = messageIndex;
        break;
      }
    }
    if (index < 0) return;
    this.objectSearchChat = {
      ...this.objectSearchChat,
      messages: this.objectSearchChat.messages.filter((_message, messageIndex) => messageIndex !== index),
    };
  }

  private clearLocalLlmRequestTimer(): void {
    if (this.localLlmRequestTimer !== null) window.clearTimeout(this.localLlmRequestTimer);
    this.localLlmRequestTimer = null;
  }

  private invalidatePendingLocalLlm(reason: string, announce: boolean): void {
    if (!localLlmRequestIsPending(this.localLlmRequest)) return;
    this.localLlmRequest = invalidateLocalLlmRequest(this.localLlmRequest, reason);
    this.localLlmRequestAbort?.abort();
    this.localLlmRequestAbort = null;
    this.clearLocalLlmRequestTimer();
    this.removeLocalLlmThinkingMessage();
    if (announce) this.appendObjectSearchChatMessage('error', reason);
    this.renderObjectSearchChat();
  }

  private permittedLocalLlmIntents(): LocalLlmIntentName[] {
    const mission = this.appState.objectSearch;
    const permitted: LocalLlmIntentName[] = ['unsupported'];
    const activeMissionCanExplainDuplicate = this.objectSearchChat.status === 'accepted'
      && mission.status !== 'idle'
      && mission.status !== 'canceled'
      && mission.status !== 'not_found';
    if (activeMissionCanExplainDuplicate
      || ((mission.status === 'idle' || mission.status === 'canceled' || mission.status === 'not_found')
      && this.appState.view.mode === 'sim'
      && !this.appState.safety.stopped)) permitted.push('find_object');
    if (mission.status !== 'idle' && mission.status !== 'canceled') permitted.push('cancel_object_search');
    return permitted;
  }

  private async refreshLocalLlmStatus(): Promise<void> {
    try {
      const response = await fetch(appPath('api/llm/status'), {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const serialized = await response.text();
      if (serialized.length > 4_096) throw new Error('status responseが上限を超えました。');
      this.observeLocalLlmStatus(serialized);
    } catch {
      this.localLlmStatus = {
        schema_version: 1,
        state: 'unavailable',
        provider: 'local_llm',
        model_label: LOCAL_LLM_MODEL_LABEL,
        model_id: '',
        busy: false,
        last_latency_ms: 0,
        error: 'Optional Local LLM sidecarへ接続できません。',
      };
      this.renderLocalLlmStatus();
    }
  }

  private observeLocalLlmStatus(serialized: string): void {
    try {
      this.localLlmStatus = parseLocalLlmStatus(serialized);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Local LLM statusを読み取れません。';
      this.localLlmStatus = {
        schema_version: 1,
        state: 'error',
        provider: 'local_llm',
        model_label: LOCAL_LLM_MODEL_LABEL,
        model_id: '',
        busy: false,
        last_latency_ms: 0,
        error: message,
      };
      this.invalidatePendingLocalLlm(message, true);
    }
    this.renderLocalLlmStatus();
  }

  private observeLocalLlmResult(serialized: string): void {
    const ownsRequestContext = this.runtimeMode === 'sim'
      || (this.controlLeaseOwner && this.appState.controlLease.owner);
    const resolution = resolveLocalLlmResult(this.localLlmRequest, serialized, {
      transportCycle: this.appState.transportCycle,
      controlLeaseGeneration: this.appState.controlLease.generation,
      controlLeaseOwner: ownsRequestContext,
      permittedIntents: this.permittedLocalLlmIntents(),
    });
    this.localLlmRequest = resolution.state;
    if (!resolution.consumed) {
      console.info(`Local LLM result rejected: ${resolution.rejection}`);
      return;
    }
    this.clearLocalLlmRequestTimer();
    this.removeLocalLlmThinkingMessage();
    if (resolution.result?.model_id) {
      this.localLlmStatus = {
        ...this.localLlmStatus,
        model_id: resolution.result.model_id,
        last_latency_ms: resolution.result.latency_ms,
      };
    }
    if (!resolution.intent) {
      this.appendObjectSearchChatMessage('error', resolution.rejection || 'Local LLM resultを現在の状態では実行できません。');
      this.renderObjectSearchChat();
      return;
    }
    const previousChat = this.objectSearchChat;
    const result = applyObjectSearchIntent(previousChat, resolution.intent, { recordUser: false });
    this.handleObjectSearchChatResult(previousChat, result);
  }

  private renderLocalLlmStatus(): void {
    const banner = this.find<HTMLElement>('#local-llm-banner');
    const state = this.find<HTMLElement>('#local-llm-state');
    const model = this.find<HTMLElement>('#local-llm-model');
    const latency = this.find<HTMLElement>('#local-llm-latency');
    const pending = localLlmRequestIsPending(this.localLlmRequest);
    banner.className = 'local-llm-banner';
    if (pending) {
      banner.classList.add('thinking');
      state.textContent = 'LOCAL LLM · THINKING';
      latency.textContent = '考えています…';
    } else if (this.localLlmStatus.state === 'disabled') {
      banner.classList.add('rule-based');
      state.textContent = 'RULE-BASED · LLM OFF';
      latency.textContent = '決定的parserだけを使用';
    } else if (this.localLlmStatus.state === 'ready') {
      state.textContent = 'LOCAL LLM · READY';
      latency.textContent = this.localLlmStatus.last_latency_ms > 0
        ? `last ${formatNumber(this.localLlmStatus.last_latency_ms, 1)} ms`
        : '同一origin APIからloopback adapterへ接続';
    } else {
      banner.classList.add(this.localLlmStatus.state === 'error' ? 'error' : 'rule-based');
      state.textContent = this.localLlmStatus.state === 'initializing'
        ? 'RULE-BASED · LLM準備中'
        : this.localLlmStatus.state === 'unavailable'
          ? 'RULE-BASED · LLM未接続'
          : 'RULE-BASED · LLM ERROR';
      latency.textContent = this.localLlmStatus.error || '決定的parserだけを使用';
    }
    model.textContent = LOCAL_LLM_MODEL_LABEL;
    model.title = this.localLlmStatus.model_id || LOCAL_LLM_MODEL_LABEL;
    const send = this.find<HTMLButtonElement>('#object-search-send');
    send.disabled = pending;
    send.setAttribute('aria-busy', String(pending));
  }

  private renderObjectSearchChat(): void {
    const roleLabels = { user: 'USER', robot: 'ROBOT', system: 'SYSTEM', error: 'ERROR' } as const;
    const items = this.objectSearchChat.messages.map((message) => {
      const article = document.createElement('article');
      article.className = `object-search-message ${message.role}`;
      const role = document.createElement('small');
      role.textContent = roleLabels[message.role];
      const text = document.createElement('p');
      text.textContent = message.text;
      article.append(role, text);
      return article;
    });
    const messageList = this.find<HTMLElement>('#object-search-messages');
    messageList.replaceChildren(...items);
    messageList.scrollTop = messageList.scrollHeight;
    const alert = this.find<HTMLElement>('#object-search-alert');
    const lastMessage = this.objectSearchChat.messages.at(-1);
    alert.hidden = lastMessage?.role !== 'error';
    alert.textContent = lastMessage?.role === 'error' ? lastMessage.text : '';
    this.renderObjectSearchSummary();
  }

  private currentObjectSearchCandidate(): Pick<AppleDetectionInput, 'confidence' | 'distanceMeters'> | null {
    const mission = this.appState.objectSearch;
    if (mission.status === 'candidate' || mission.status === 'approaching' || mission.status === 'stopping' || mission.status === 'confirming') {
      return mission.candidate;
    }
    if (mission.status === 'succeeded') return mission.evidence;
    if (mission.status === 'canceled' || mission.status === 'not_found') return null;
    if (mission.status !== 'idle') return mission.detectionTracker.frames.at(-1)?.selected ?? null;
    return null;
  }

  private objectSearchDetectionInputs(message: Detection2DArrayMessage, frame: VisionFrame): AppleDetectionInput[] {
    return message.detections.flatMap((detection, index) => {
      const result = detection.results[0];
      if (!result) return [];
      return [{
        classId: result.hypothesis.class_id,
        confidence: result.hypothesis.score,
        bbox: {
          centerX: detection.bbox.center.position.x,
          centerY: detection.bbox.center.position.y,
          width: detection.bbox.size_x,
          height: detection.bbox.size_y,
        },
        distanceMeters: sampleDetectionDepth(detection, frame.depthMeters, frame.width, frame.height),
        index,
      }];
    });
  }

  private observeObjectSearchDetection(message: Detection2DArrayMessage): void {
    const mission = this.appState.objectSearch;
    if (mission.status !== 'searching' && mission.status !== 'confirming' && mission.status !== 'finalizing') return;
    const frame = this.latestVisionFrame;
    if (!frame) return;
    this.dispatchAppEvent({
      type: 'OBJECT_SEARCH_DETECTION_OBSERVED',
      generation: mission.generation,
      visionCycle: this.appState.vision.cycle,
      transportCycle: this.appState.transportCycle,
      explorationGeneration: this.appState.exploration.generation,
      frameStampMs: rosTimeToMilliseconds(message.header.stamp),
      cameraFrameStampMs: frame.capturedAtMs,
      observedAtMs: Date.now(),
      imageWidth: frame.width,
      imageHeight: frame.height,
      detections: this.objectSearchDetectionInputs(message, frame),
    }, false);
  }

  private renderObjectSearchSummary(): void {
    const mission = this.appState.objectSearch;
    const statusLabels: Record<AppState['objectSearch']['status'], string> = {
      idle: 'IDLE / 命令待ち',
      preparing: 'PREPARING / 準備中',
      searching: 'SEARCHING / 探索中',
      candidate: 'CANDIDATE / 安定検出',
      approaching: 'APPROACHING / 正面へ接近中',
      stopping: 'STOPPING / 安全停止中',
      confirming: 'CONFIRMING / 停止後確認',
      succeeded: 'SUCCEEDED / 発見',
      not_found: 'NOT FOUND / 対象なし',
      paused: 'PAUSED / 一時停止',
      finalizing: 'FINALIZING / 確認待ち',
      canceled: 'CANCELED / 中止',
      error: 'ERROR / 要確認',
    };
    const status = this.find<HTMLElement>('#object-search-status');
    status.textContent = statusLabels[mission.status];
    status.className = `object-search-status-chip ${mission.status}`;
    this.find('#object-search-target').textContent = mission.status === 'idle'
      ? '未指定'
      : `${mission.targetClass} / ${mission.displayName}`;
    this.find('#object-search-mission').textContent = mission.status === 'idle'
      ? '未開始'
      : `#${mission.missionId} / generation ${mission.generation}`;
    this.find('#object-search-exploration').textContent = this.appState.exploration.status;
    this.find('#object-search-yolo').textContent = this.appState.vision.status === 'ready'
      ? `実YOLOX ready / cycle ${this.appState.vision.cycle}`
      : this.appState.vision.status === 'error'
        ? `エラー / cycle ${this.appState.vision.cycle}`
        : `準備待ち / cycle ${this.appState.vision.cycle}`;
    this.find('#object-search-reason').textContent = localLlmRequestIsPending(this.localLlmRequest)
      ? 'Local LLMの高レベルIntent候補を待っています。Robotはまだ開始しません。'
      : objectSearchStatusMessage(mission);
    const candidate = this.currentObjectSearchCandidate();
    this.find('#object-search-confidence').textContent = candidate ? `${formatNumber(candidate.confidence * 100, 1)}%` : '未検出';
    this.find('#object-search-distance').textContent = candidate?.distanceMeters === null || !candidate ? '未計測' : `${formatNumber(candidate.distanceMeters, 2)} m`;
    if (mission.status === 'idle' || mission.status === 'canceled') {
      this.find('#object-search-confirmation').textContent = `0 / ${APPLE_PRESTOP_WINDOW_FRAMES} frame（必要 ${APPLE_PRESTOP_REQUIRED_HITS} hit）`;
    } else if (mission.status === 'stopping') {
      this.find('#object-search-confirmation').textContent = `停止証拠 ${mission.stopEvidence.zeroVelocitySampleObservedAtMs.length} / 2 sample`;
    } else {
      const tracker = mission.detectionTracker;
      const postStop = tracker.phase === 'poststop';
      const windowSize = postStop ? APPLE_POSTSTOP_WINDOW_FRAMES : APPLE_PRESTOP_WINDOW_FRAMES;
      const requiredHits = postStop ? APPLE_POSTSTOP_REQUIRED_HITS : APPLE_PRESTOP_REQUIRED_HITS;
      const hitCount = tracker.frames.slice(-windowSize).reduce((count, frame) => count + Number(frame.hit), 0);
      this.find('#object-search-confirmation').textContent = `${hitCount} / ${windowSize} frame（${postStop ? '停止後・' : ''}必要 ${requiredHits} hit）`;
    }
    const cancel = this.find<HTMLButtonElement>('#object-search-cancel');
    const resume = this.find<HTMLButtonElement>('#object-search-resume');
    const llmPending = localLlmRequestIsPending(this.localLlmRequest);
    const cancelable = llmPending || (mission.status !== 'idle' && mission.status !== 'canceled');
    const resumable = mission.status === 'paused' || mission.status === 'error';
    cancel.disabled = !cancelable;
    cancel.title = llmPending
      ? 'pending Local LLM requestを直ちに無効化します'
      : cancelable
        ? 'goal取消、manual owner、速度0の順で安全に中止します'
        : '中止できるObject Search Missionはありません';
    resume.hidden = !resumable;
    resume.disabled = !resumable;
    resume.title = resumable ? objectSearchStatusMessage(mission) : '';
    this.renderLocalLlmStatus();
  }

  private renderVisionStatus(serialized: string): void {
    try {
      const status = JSON.parse(serialized) as { state?: string; model?: string; device?: string; latency_ms?: number; fps?: number; detections?: number; error?: string };
      this.yoloConnected = status.state === 'ready' || status.state === 'inferencing';
      const observedAtMs = Date.now();
      this.dispatchAppEvent(status.error || status.state === 'error'
        ? { type: 'VISION_STATUS_OBSERVED', cycle: this.appState.vision.cycle, status: 'error', observedAtMs, error: status.error || 'YOLOX Nodeがerrorを報告しました。' }
        : { type: 'VISION_STATUS_OBSERVED', cycle: this.appState.vision.cycle, status: this.yoloConnected ? 'ready' : 'initializing', observedAtMs }, false);
      this.find('#yolo-status').textContent = status.error
        ? `エラー: ${status.error}`
        : this.yoloConnected
          ? `実Detection Topic / ${status.detections ?? 0}件`
          : status.state === 'model_missing'
            ? 'model未取得 / pixi run vision-assets'
            : 'Camera frame待機中（偽bboxなし）';
      this.find('#vision-latency').textContent = Number.isFinite(status.latency_ms) ? `${formatNumber(status.latency_ms!, 1)} ms / ${formatNumber(status.fps ?? 0, 1)} fps` : '-- ms / -- fps';
      this.find('#vision-device').textContent = `${status.model ?? 'YOLOX-Nano'} / ${status.device ?? 'CPU'}`;
    } catch {
      this.yoloConnected = false;
      this.dispatchAppEvent({
        type: 'VISION_STATUS_OBSERVED',
        cycle: this.appState.vision.cycle,
        status: 'error',
        observedAtMs: Date.now(),
        error: 'YOLOX status messageを読み取れません。',
      }, false);
      this.find('#yolo-status').textContent = '推論状態Messageを読み取れません';
    }
    this.renderObjectSearchSummary();
  }

  private drawDetectionOverlay(): void {
    const context = this.detectionOverlay.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, this.detectionOverlay.width, this.detectionOverlay.height);
    const frame = this.latestVisionFrame;
    const message = this.latestDetections;
    if (!frame || !message || !this.yoloConnected) return;
    const ageMs = frame.capturedAtMs - rosTimeToMilliseconds(message.header.stamp);
    if (Math.abs(ageMs) > 500) {
      this.find('#vision-timestamp').textContent = `Detectionが${Math.round(Math.abs(ageMs))} msずれたためbboxを除外`;
      return;
    }
    const items = combineDetectionsWithDepth(message.detections, frame);
    context.lineWidth = 2;
    context.font = '700 12px ui-monospace, monospace';
    items.forEach((item, index) => this.drawDetection(context, item, index));
    if (items.length > 0) {
      this.markMission('yolo');
      if (items.some((item) => item.distanceMeters !== null) && this.latestScan) this.markMission('compare');
    }
    this.find('#yolo-status').textContent = `実Detection Topic / ${items.length}件表示`;
    this.find('#vision-timestamp').textContent = `RGB・Depth・Detection差 ${Math.round(Math.abs(ageMs))} ms`;
  }

  private drawDetection(context: CanvasRenderingContext2D, item: DetectionWithDistance, index: number): void {
    const bbox = item.detection.bbox;
    const x = bbox.center.position.x - bbox.size_x / 2;
    const y = bbox.center.position.y - bbox.size_y / 2;
    const colors = ['#ffcf56', '#66e0c2', '#ff7d73', '#79a7ff'];
    const color = colors[index % colors.length];
    context.strokeStyle = color;
    context.strokeRect(x, y, bbox.size_x, bbox.size_y);
    const distance = item.distanceMeters === null ? '未計測' : `${formatNumber(item.distanceMeters, 2)} m`;
    const label = `${item.classId} ${Math.round(item.confidence * 100)}% / ${distance}`;
    const labelWidth = Math.min(this.detectionOverlay.width - Math.max(0, x), context.measureText(label).width + 10);
    const labelY = Math.max(0, y - 18);
    context.fillStyle = color;
    context.fillRect(Math.max(0, x), labelY, labelWidth, 18);
    context.fillStyle = '#10272b';
    context.fillText(label, Math.max(0, x) + 5, labelY + 13, Math.max(0, labelWidth - 8));
  }

  private bindViewTabs(): void {
    this.root.querySelectorAll<HTMLButtonElement>('.view-tab[data-view]').forEach((tab) => tab.addEventListener('click', () => { if (!tab.disabled) this.switchView(tab.dataset.view ?? 'sim'); }));
  }

  switchView(requested: string): void {
    const view: 'sim' | 'stage' = requested === 'stage' ? 'stage' : 'sim';
    this.dispatchAppEvent({ type: 'VIEW_REQUESTED', view });
  }

  private applyView(view: 'sim' | 'stage'): void {
    if (view === 'sim') this.cancelGesture(true);
    this.root.setAttribute('data-view', view);
    this.updateTabletControlDockPresentation();
    this.renderSimTopZoomControls();
    this.root.querySelectorAll<HTMLButtonElement>('.view-tab[data-view]').forEach((tab) => {
      const active = tab.dataset.view === view;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    this.setArmedPlacement(null);
    if (view === 'stage') {
      this.simulation?.enterStageEditor();
      this.stageShell.insertBefore(this.canvas, this.stageShell.firstChild);
      this.gesture = null;
      this.cameraDrag = null;
      this.spaceDown = false;
      this.stageFlyKeys.clear();
      this.updateFlyInput();
      this.syncStageViewButtons('plan');
      const settle = (): void => {
        this.simulation?.refreshLayout();
        window.requestAnimationFrame(() => { this.simulation?.refreshLayout(); this.updateHandles(); });
      };
      window.requestAnimationFrame(settle);
      this.setPlaygroundStatus('編集モードです。SIMの物理・LiDAR・Camera・Topic配信を一時停止しています。図面ビューでドラッグ移動・角リサイズ・回転、Deleteキーで選択削除ができます。');
      this.showNarration('STAGEエディタを開きました。SIMの全ての処理を一時停止して編集モードでロックしています。');
    } else {
      this.simulation?.exitStageEditor();
      this.simShell.insertBefore(this.canvas, this.simShell.firstChild);
      this.updateHandles();
      const settle = (): void => { this.simulation?.refreshLayout(); window.requestAnimationFrame(() => this.simulation?.refreshLayout()); };
      window.requestAnimationFrame(settle);
      this.setPlaygroundStatus('SIMモードです。STAGEタブでいつでも編集に戻れます。');
      this.showNarration('SIMモードへ戻りました。編集内容はMesh・Collider・LiDAR・Cameraへ反映済みで、手動操作は速度0から再開します。');
      if (!this.runtimeManagerState.processing) this.find('#nav-status').textContent = this.runtimeIdleStatus();
    }
  }

  private renderSimTopZoomControls(): void {
    const controls = this.find('#sim-top-zoom-controls');
    const visible = this.activeView === 'sim' && this.cameraMode === 'top';
    controls.hidden = !visible;
    controls.setAttribute('aria-hidden', String(!visible));
  }

  private bindStageEditorControls(): void {
    const select = this.find<HTMLSelectElement>('#playground-object-select');
    select.addEventListener('change', () => { this.selectedPlaygroundId = select.value; this.applyPlaygroundToSimulation(); this.renderPlaygroundEditor(); });
    this.root.querySelectorAll<HTMLButtonElement>('[data-add-object]').forEach((button) => button.addEventListener('click', () => {
      if (this.activeView !== 'stage') return;
      const kind = button.dataset.addObject as PlaygroundObjectKind;
      const requestedAsset = getVisionTargetAssetById(button.dataset.visionTargetAsset ?? '')?.id ?? 'yolox-dog';
      const samePlacement = this.armedPlacement === kind && (kind !== 'vision_target' || requestedAsset === this.armedVisionTargetAssetId);
      this.setArmedPlacement(samePlacement ? null : kind, requestedAsset);
    }));
    this.find<HTMLButtonElement>('#mode-move').addEventListener('click', () => this.setEditTool('move'));
    this.find<HTMLButtonElement>('#mode-rotate').addEventListener('click', () => this.setEditTool('rotate'));
    this.find<HTMLButtonElement>('#view-plan').addEventListener('click', () => this.setStageView('plan'));
    this.find<HTMLButtonElement>('#view-camera').addEventListener('click', () => this.setStageView('orbit'));
    this.root.querySelectorAll<HTMLButtonElement>('[data-stage-size]').forEach((button) => button.addEventListener('click', () => {
      const stageSize = button.dataset.stageSize;
      if (stageSize && Object.prototype.hasOwnProperty.call(PLAYGROUND_STAGE_PRESETS, stageSize)) this.setPlaygroundStageSize(stageSize as PlaygroundStageSize);
    }));
    this.find<HTMLButtonElement>('#duplicate-object-button').addEventListener('click', () => this.duplicateSelectedPlaygroundObject());
    this.find<HTMLButtonElement>('#delete-object-button').addEventListener('click', () => this.deleteSelectedPlaygroundObject());
    this.find<HTMLButtonElement>('#undo-playground').addEventListener('click', () => {
      const previous = this.playgroundHistory.undo(this.playground);
      if (previous) { this.playground = previous; this.playgroundNameDraft = previous.name; this.ensurePlaygroundSelection(); this.applyPlaygroundToSimulation(); this.renderPlaygroundEditor(); this.updateHandles(); this.setPlaygroundStatus('Undoしました。Mesh・Collider・LiDAR・Cameraを同じworldへ戻しました。'); }
    });
    this.find<HTMLButtonElement>('#redo-playground').addEventListener('click', () => {
      const next = this.playgroundHistory.redo(this.playground);
      if (next) { this.playground = next; this.playgroundNameDraft = next.name; this.ensurePlaygroundSelection(); this.applyPlaygroundToSimulation(); this.renderPlaygroundEditor(); this.updateHandles(); this.setPlaygroundStatus('Redoしました。'); }
    });
    this.find<HTMLButtonElement>('#snap-toggle').addEventListener('click', () => {
      this.snapEnabled = !this.snapEnabled;
      const button = this.find<HTMLButtonElement>('#snap-toggle');
      button.classList.toggle('active', this.snapEnabled);
      button.setAttribute('aria-pressed', String(this.snapEnabled));
      this.setPlaygroundStatus(this.snapEnabled ? 'grid snapをONにしました。0.1 m間隔・回転5°間隔で配置されます。' : 'grid snapをOFFにしました。自由な位置・角度へ配置できます。');
    });
    const labelInput = this.find<HTMLInputElement>('#object-label');
    labelInput.addEventListener('change', () => this.applyInspectorValues());
    ['#object-x', '#object-z', '#object-rotation', '#object-width', '#object-height', '#object-depth'].forEach((selector) => this.find<HTMLInputElement>(selector).addEventListener('change', () => this.applyInspectorValues()));
    const stageNameInput = this.find<HTMLInputElement>('#stage-name-input');
    stageNameInput.addEventListener('input', () => { this.playgroundNameDraft = stageNameInput.value; });
    const stageLibrarySelect = this.find<HTMLSelectElement>('#playground-library-select');
    stageLibrarySelect.addEventListener('change', () => {
      if (stageLibrarySelect.value) this.loadPlaygroundFromLibrary(stageLibrarySelect.value);
    });
    const visionAssetSelect = this.find<HTMLSelectElement>('#vision-target-asset');
    visionAssetSelect.addEventListener('change', () => {
      if (visionAssetSelect.value === STAGE_IMAGE_UPLOAD_OPTION) {
        this.restoreVisionTargetAssetSelection();
        this.stageImageUploadFile.click();
        return;
      }
      this.applyVisionTargetAsset();
    });
    this.stageImageUploadFile.addEventListener('change', () => {
      const file = this.stageImageUploadFile.files?.[0];
      this.stageImageUploadFile.value = '';
      if (file) void this.importStageImage(file);
    });
    this.find<HTMLButtonElement>('#save-playground').addEventListener('click', () => this.savePlaygroundToLibrary());
    this.find<HTMLButtonElement>('#load-playground').addEventListener('click', () => {
      const selectedName = stageLibrarySelect.value;
      if (selectedName) this.loadPlaygroundFromLibrary(selectedName);
      else this.loadPlaygroundFromBrowser();
    });
    this.find<HTMLButtonElement>('#export-playground').addEventListener('click', () => {
      const blob = new Blob([`${JSON.stringify(this.playground, null, 2)}
`], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${this.playground.name || 'training-room'}-schema-v1.json`;
      link.click();
      URL.revokeObjectURL(url);
      this.setPlaygroundStatus('version付きJSONをexportしました。');
    });
    const fileInput = this.find<HTMLInputElement>('#import-playground-file');
    this.find<HTMLButtonElement>('#import-playground').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (!file) return;
      if (file.size > 1_000_000) { this.setPlaygroundStatus('import JSONは1 MB以内にしてください。', true); return; }
      this.replacePlaygroundFromUnknown(await file.text(), `${file.name} をimportしました。`);
    });
    this.find<HTMLButtonElement>('#reset-playground').addEventListener('click', () => {
      const snapshot = clonePlayground(this.playground);
      const next = clonePlayground(DEFAULT_PLAYGROUND);
      if (this.commitDefinition(next, snapshot, null)) {
        this.playgroundNameDraft = next.name;
        this.renderPlaygroundEditor();
        this.setPlaygroundStatus('既定Training Roomへ戻しました。Undoで直前のworldへ戻せます。保存地図は上書きしていません。');
      }
    });
    window.addEventListener('resize', () => { if (this.activeView === 'stage') this.updateHandles(); });
    this.renderPlaygroundEditor();
  }

  private bindStageImageErrorModal(): void {
    this.stageImageErrorClose.addEventListener('click', () => this.hideStageImageError());
    this.stageImageErrorModal.addEventListener('click', (event) => {
      if (event.target === this.stageImageErrorModal) this.hideStageImageError();
    });
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.stageImageErrorModal.hidden) this.hideStageImageError();
    });
  }

  private hideStageImageError(): void {
    this.stageImageErrorModal.hidden = true;
  }

  private showStageImageError(message: string): void {
    this.stageImageErrorDetail.textContent = message;
    this.stageImageErrorModal.hidden = false;
    this.stageImageErrorClose.focus();
  }

  private async hydrateUploadedStageImages(): Promise<void> {
    try {
      this.uploadedStageImages = (await listStoredStageImages()).map((record) => registerStageImage(record));
      this.renderPlaygroundEditor();
      if (this.simulation) this.applyPlaygroundToSimulation();
    } catch (error) {
      this.setPlaygroundStatus(error instanceof Error ? error.message : '保存画像を読み込めませんでした。', true);
    }
  }

  private stageImageOptions(): StageImageOption[] {
    const builtIn = Object.values(VISION_TARGET_ASSETS).map((asset): StageImageOption => ({
      value: asset.id,
      reference: asset.url,
      label: asset.label,
      expectedClasses: asset.expectedClasses,
    }));
    const uploaded = this.uploadedStageImages.map((asset): StageImageOption => ({
      value: asset.reference,
      reference: asset.reference,
      label: asset.fileName,
      expectedClasses: [],
    }));
    return [...builtIn, ...uploaded];
  }

  private stageImageOptionForReference(reference: string | undefined): StageImageOption | null {
    if (!reference) return null;
    const builtIn = getVisionTargetAssetByUrl(reference);
    if (builtIn) return { value: builtIn.id, reference: builtIn.url, label: builtIn.label, expectedClasses: builtIn.expectedClasses };
    const uploaded = getRegisteredStageImageByReference(reference);
    return uploaded ? { value: uploaded.reference, reference: uploaded.reference, label: uploaded.fileName, expectedClasses: [] } : null;
  }

  private restoreVisionTargetAssetSelection(): void {
    const selected = this.selectedPlaygroundObject();
    const select = this.find<HTMLSelectElement>('#vision-target-asset');
    select.value = this.stageImageOptionForReference(selected?.asset)?.value ?? VISION_TARGET_ASSETS.yoloxDog.id;
  }

  private async importStageImage(file: File): Promise<void> {
    const format = stageImageFormatForFile(file);
    if (!format) {
      const message = 'その画像フォーマットは使えません';
      this.showStageImageError(message);
      this.setPlaygroundStatus(message, true);
      return;
    }
    let dimensions: { width: number; height: number };
    try {
      dimensions = await readStageImageDimensions(file);
    } catch (error) {
      const message = error instanceof Error ? error.message : '画像を読み込めませんでした。';
      this.showStageImageError(message);
      this.setPlaygroundStatus(message, true);
      return;
    }
    if (!isStageImageDimensionValid(dimensions)) {
      const message = stageImageDimensionError(dimensions);
      this.showStageImageError(message);
      this.setPlaygroundStatus(message, true);
      return;
    }
    const record: StoredStageImage = {
      id: createStageImageId(),
      fileName: file.name,
      mimeType: format.mimeType,
      blob: file,
      width: dimensions.width,
      height: dimensions.height,
      createdAt: Date.now(),
    };
    let stored = true;
    try {
      await storeStageImage(record);
    } catch (error) {
      stored = false;
      this.showStageImageError(error instanceof Error ? error.message : '画像をBrowserへ保存できませんでした。');
    }
    const registered = registerStageImage(record);
    this.uploadedStageImages = [...this.uploadedStageImages, registered];
    this.renderPlaygroundEditor();
    const selected = this.selectedPlaygroundObject();
    if (selected?.kind === 'vision_target') {
      this.find<HTMLSelectElement>('#vision-target-asset').value = registered.reference;
      this.applyVisionTargetAsset(registered.reference);
    }
    this.setPlaygroundStatus(stored
      ? `画像「${file.name}」を保存画像として追加しました。${dimensions.width}×${dimensions.height}px / ${format.format.toUpperCase()}。`
      : `画像「${file.name}」を一時追加しました。Browser保存に失敗したため、ページを閉じる前に再登録してください。`, !stored);
  }

  private bindStageCanvasEvents(): void {
    const surface = this.stageShell;
    surface.addEventListener('pointerdown', (event) => this.onStagePointerDown(event));
    surface.addEventListener('pointermove', (event) => this.onStagePointerMove(event));
    surface.addEventListener('pointerup', (event) => this.onStagePointerUp(event));
    surface.addEventListener('pointercancel', (event) => this.cancelGesture(true, event.pointerId));
    surface.addEventListener('wheel', (event) => this.onStageWheel(event), { passive: false });
    surface.addEventListener('contextmenu', (event) => { if (this.activeView === 'stage') event.preventDefault(); });
  }

  private onStagePointerDown(event: PointerEvent): void {
    if (this.activeView !== 'stage' || !this.simulation) return;
    const isRightButton = event.pointerType === 'mouse' && event.button === 2;
    const isLeftButton = !(event.pointerType === 'mouse' && event.button !== 0);
    if (!isRightButton && !isLeftButton) return;
    if (isRightButton) {
      // Changing from the plan view cancels the previous gesture. Set the new
      // pointer id after that cancellation so capture belongs to this drag.
      this.setStageView('orbit');
      this.activePointerId = event.pointerId;
      this.beginCameraDrag({ kind: 'orbit', lastX: event.clientX, lastY: event.clientY });
      return;
    }
    this.activePointerId = event.pointerId;
    if (this.spaceDown) {
      const kind = this.stageView === 'plan' ? 'planPan' : 'pan';
      this.beginCameraDrag({ kind, lastX: event.clientX, lastY: event.clientY });
      return;
    }
    if (this.armedPlacement) { this.placeArmedObject(event.clientX, event.clientY); return; }
    const selected = this.selectedPlaygroundObject();
    if (selected && this.editTool === 'move') {
      const corner = this.hitResizeHandle(event.clientX, event.clientY, selected);
      if (corner >= 0) { this.beginGesture(selected, corner === HEIGHT_HANDLE ? 'resizeHeight' : 'resize', corner, undefined, event.clientY); return; }
    }
    const ground = this.simulation.groundPointAt(event.clientX, event.clientY);
    const hitId = this.simulation.pickPlaygroundIdAt(event.clientX, event.clientY);
    if (!hitId) {
      this.activePointerId = -1;
      if (this.selectedPlaygroundId) this.selectPlaygroundObject('');
      return;
    }
    if (hitId !== this.selectedPlaygroundId) this.selectPlaygroundObject(hitId);
    const object = this.playground.objects.find((candidate) => candidate.id === hitId);
    if (!object || !ground) { this.activePointerId = -1; return; }
    this.beginGesture(object, this.editTool === 'rotate' ? 'rotate' : 'move', -1, ground);
  }

  private beginCameraDrag(drag: StageCameraDrag): void {
    this.cameraDrag = drag;
    this.dispatchAppEvent({ type: 'STAGE_GESTURE_CHANGED', active: true }, false);
    this.canvas.setPointerCapture?.(this.activePointerId);
    this.canvas.classList.add('dragging');
  }

  private selectPlaygroundObject(id: string): void {
    this.selectedPlaygroundId = id;
    this.applyPlaygroundToSimulation();
    this.renderPlaygroundEditor();
  }

  private beginGesture(object: PlaygroundObject, kind: 'move' | 'resize' | 'rotate' | 'resizeHeight', corner: number, ground?: { x: number; z: number }, clientY?: number): void {
    let anchorX = 0;
    let anchorZ = 0;
    let cornerSignX = 1;
    let cornerSignZ = 1;
    let offsetX = 0;
    let offsetZ = 0;
    let startPointerAngle = 0;
    if (kind === 'resize' && corner >= 0 && corner < HEIGHT_HANDLE) {
      const corners = footprintCorners(object);
      const anchorCorner = corners[(corner + 2) % 4];
      anchorX = anchorCorner.x;
      anchorZ = anchorCorner.z;
      cornerSignX = corner === 1 || corner === 2 ? 1 : -1;
      cornerSignZ = corner === 2 || corner === 3 ? 1 : -1;
    }
    if (kind === 'move' && ground) {
      offsetX = ground.x - object.position.x;
      offsetZ = ground.z - object.position.z;
    }
    if (kind === 'rotate' && ground) startPointerAngle = Math.atan2(ground.z - object.position.z, ground.x - object.position.x);
    this.gesture = {
      kind,
      id: object.id,
      snapshot: clonePlayground(this.playground),
      offsetX,
      offsetZ,
      anchorX,
      anchorZ,
      cornerSignX,
      cornerSignZ,
      centerX: object.position.x,
      centerZ: object.position.z,
      startPointerAngle,
      startRotation: object.rotation,
      startClientY: clientY ?? 0,
      lastX: object.position.x,
      lastZ: object.position.z,
      lastRotation: object.rotation,
      lastWidth: object.size.width,
      lastHeight: object.size.height,
      lastDepth: object.size.depth,
    };
    this.dispatchAppEvent({ type: 'STAGE_GESTURE_CHANGED', active: true }, false);
    this.canvas.setPointerCapture?.(this.activePointerId);
    this.canvas.classList.add('dragging');
  }

  private onStagePointerMove(event: PointerEvent): void {
    if (this.activeView !== 'stage' || !this.simulation) return;
    const drag = this.cameraDrag;
    if (drag) {
      const deltaX = event.clientX - drag.lastX;
      const deltaY = event.clientY - drag.lastY;
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
      if (drag.kind === 'orbit') this.simulation.orbitRotate(deltaX, deltaY);
      else if (drag.kind === 'pan') this.simulation.orbitPan(deltaX, deltaY);
      else if (drag.kind === 'planPan') this.simulation.planPan(deltaX, deltaY);
      this.updateHandles();
      return;
    }
    const gesture = this.gesture;
    if (!gesture) return;
    const ground = this.simulation.groundPointAt(event.clientX, event.clientY);
    if (!ground) return;
    if (gesture.kind === 'move') {
      const point = clampPosition(this.snapped(ground.x - gesture.offsetX, .1), this.snapped(ground.z - gesture.offsetZ, .1), this.stagePositionBounds());
      gesture.lastX = point.x;
      gesture.lastZ = point.z;
    } else if (gesture.kind === 'resize') {
      const dx = ground.x - gesture.anchorX;
      const dz = ground.z - gesture.anchorZ;
      const cosine = Math.cos(gesture.lastRotation);
      const sine = Math.sin(gesture.lastRotation);
      const localX = Math.abs(dx * cosine - dz * sine);
      const localZ = Math.abs(dx * sine + dz * cosine);
      gesture.lastWidth = clampRange(this.snapped(localX, .05), .05, this.stageObjectSizeLimit());
      gesture.lastDepth = clampRange(this.snapped(localZ, .05), .05, this.stageObjectSizeLimit());
      const halfWidth = gesture.cornerSignX * gesture.lastWidth / 2;
      const halfDepth = gesture.cornerSignZ * gesture.lastDepth / 2;
      const point = clampPosition(gesture.anchorX + halfWidth * cosine + halfDepth * sine, gesture.anchorZ - halfWidth * sine + halfDepth * cosine, this.stagePositionBounds());
      gesture.lastX = point.x;
      gesture.lastZ = point.z;
    } else if (gesture.kind === 'resizeHeight') {
      const totalDy = event.clientY - gesture.startClientY;
      const nextHeight = gesture.lastHeight + this.simulation.screenDeltaToHeightDelta(totalDy);
      gesture.lastHeight = clampRange(this.snapped(nextHeight, .05), .1, 3);
    } else {
      const angle = Math.atan2(ground.z - gesture.centerZ, ground.x - gesture.centerX);
      let deltaDegrees = (angle - gesture.startPointerAngle) * 180 / Math.PI;
      deltaDegrees = ((deltaDegrees % 360) + 540) % 360 - 180;
      const baseDegrees = gesture.startRotation * 180 / Math.PI + deltaDegrees;
      const snappedDegrees = this.snapEnabled ? Math.round(baseDegrees / 5) * 5 : baseDegrees;
      gesture.lastRotation = Number((snappedDegrees * Math.PI / 180).toFixed(6));
    }
    this.simulation.updateStageObjectTransform(gesture.id, gesture.lastX, gesture.lastZ, gesture.lastRotation, { width: gesture.lastWidth, height: gesture.lastHeight, depth: gesture.lastDepth });
    this.syncInspectorLive(gesture);
    this.updateHandles();
  }

  private onStagePointerUp(event: PointerEvent): void {
    if (this.activePointerId >= 0 && event.pointerId !== this.activePointerId) return;
    const pointerId = this.activePointerId;
    this.activePointerId = -1;
    if (pointerId >= 0) {
      try { this.canvas.releasePointerCapture?.(pointerId); } catch { /* pointer already released */ }
    }
    this.canvas.classList.remove('dragging');
    const drag = this.cameraDrag;
    if (drag) {
      this.cameraDrag = null;
      this.dispatchAppEvent({ type: 'STAGE_GESTURE_CHANGED', active: false }, false);
      return;
    }
    const gesture = this.gesture;
    if (!gesture) return;
    this.gesture = null;
    this.dispatchAppEvent({ type: 'STAGE_GESTURE_CHANGED', active: false }, false);
    const next = clonePlayground(this.playground);
    const target = next.objects.find((candidate) => candidate.id === gesture.id);
    if (!target) return;
    target.position = { x: Number(gesture.lastX.toFixed(4)), z: Number(gesture.lastZ.toFixed(4)) };
    target.rotation = normalizeAngle(gesture.lastRotation);
    target.size = { width: Number(gesture.lastWidth.toFixed(3)), height: Number(gesture.lastHeight.toFixed(3)), depth: Number(gesture.lastDepth.toFixed(3)) };
    const verb = gesture.kind === 'move' ? '移動' : gesture.kind === 'rotate' ? '回転' : 'リサイズ';
    this.commitDefinition(next, gesture.snapshot, `${target.label}を${verb}しました。Mesh・Collider・LiDAR・Cameraへ同時反映しています。`, gesture.id);
  }

  private cancelGesture(rollback: boolean, pointerId?: number): void {
    if (pointerId !== undefined && this.activePointerId >= 0 && pointerId !== this.activePointerId) return;
    const gesture = this.gesture;
    this.gesture = null;
    this.cameraDrag = null;
    this.dispatchAppEvent({ type: 'STAGE_GESTURE_CHANGED', active: false }, false);
    const capturedPointerId = this.activePointerId;
    this.activePointerId = -1;
    if (capturedPointerId >= 0) {
      try { this.canvas.releasePointerCapture?.(capturedPointerId); } catch { /* pointer already released */ }
    }
    this.canvas.classList.remove('dragging');
    if (gesture && rollback) { this.applyPlaygroundToSimulation(); this.renderPlaygroundEditor(); }
  }

  private onStageWheel(event: WheelEvent): void {
    if (this.activeView !== 'stage' || !this.simulation) return;
    event.preventDefault();
    if (this.stageView === 'plan') this.simulation.planZoom(event.deltaY);
    else this.simulation.orbitZoom(event.deltaY);
    this.updateHandles();
  }


  private placeArmedObject(clientX: number, clientY: number): void {
    const kind = this.armedPlacement;
    if (!kind || !this.simulation) return;
    this.activePointerId = -1;
    const ground = this.simulation.groundPointAt(clientX, clientY);
    if (!ground) return;
    const snapshot = clonePlayground(this.playground);
    const count = this.playground.objects.filter((object) => object.kind === kind).length + 1;
    let id = `${kind.replace('_', '-')}-${count}`;
    while (this.playground.objects.some((object) => object.id === id)) id = `${kind.replace('_', '-')}-${count}-${crypto.randomUUID().slice(0, 4)}`;
    const defaults = playgroundDefaults(kind, count, this.armedVisionTargetAssetId);
    const position = clampPosition(this.snapped(ground.x, .1), this.snapped(ground.z, .1), this.stagePositionBounds());
    const next = clonePlayground(this.playground);
    next.objects.push({ id, kind, ...defaults, position });
    if (this.commitDefinition(next, snapshot, null)) {
      this.selectedPlaygroundId = id;
      this.applyPlaygroundToSimulation();
      this.renderPlaygroundEditor();
      this.setPlaygroundStatus(`${defaults.label}を (${position.x}, ${position.z}) mに配置しました。ドラッグで移動できます。`);
    }
    this.setArmedPlacement(null);
  }

  private applyInspectorValues(): void {
    const currentIndex = this.playground.objects.findIndex((object) => object.id === this.selectedPlaygroundId);
    if (currentIndex < 0) return;
    const snapshot = clonePlayground(this.playground);
    const next = clonePlayground(this.playground);
    const current = next.objects[currentIndex];
    const read = (selector: string): number => Number(this.find<HTMLInputElement>(selector).value);
    current.position = { x: this.snapped(read('#object-x'), .1), z: this.snapped(read('#object-z'), .1) };
    current.rotation = read('#object-rotation') * Math.PI / 180;
    current.size = { width: this.snapped(read('#object-width'), .05), height: this.snapped(read('#object-height'), .05), depth: this.snapped(read('#object-depth'), .01) };
    const labelInput = this.find<HTMLInputElement>('#object-label');
    if (labelInput.value.trim().length > 0) current.label = labelInput.value.trim();
    this.commitDefinition(next, snapshot, `${current.label}をMesh・Collider・LiDAR・RGB／Depthへ同時反映しました。`);
  }

  private applyVisionTargetAsset(value = this.find<HTMLSelectElement>('#vision-target-asset').value): void {
    const currentIndex = this.playground.objects.findIndex((object) => object.id === this.selectedPlaygroundId);
    if (currentIndex < 0) return;
    const asset = this.stageImageOptions().find((option) => option.value === value);
    if (!asset) { this.setPlaygroundStatus('選択した画像は登録されていません。', true); return; }
    const snapshot = clonePlayground(this.playground);
    const next = clonePlayground(this.playground);
    const current = next.objects[currentIndex];
    if (current.kind !== 'vision_target') return;
    current.asset = asset.reference;
    this.commitDefinition(next, snapshot, `${current.label}の画像を「${asset.label}」へ変更しました。`, current.id);
  }

  private savePlaygroundToLibrary(): void {
    const stageName = this.playgroundNameDraft.trim();
    let definition: PlaygroundDefinition;
    try {
      definition = parsePlayground({ ...this.playground, name: stageName });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStageLibraryMessage(message, true);
      this.setPlaygroundStatus(message, true);
      return;
    }
    const overwrite = this.playgroundLibrary.items.some((item) => item.definition.name === definition.name);
    if (overwrite && !window.confirm(`Stage「${definition.name}」は保存済みです。同じ名前で上書きしますか？`)) return;
    const nextLibrary = upsertPlaygroundLibrary(this.playgroundLibrary, definition);
    try {
      localStorage.setItem(PLAYGROUND_LIBRARY_STORAGE_KEY, JSON.stringify(nextLibrary));
    } catch {
      const message = '保存StageをBrowserへ保存できませんでした。Browserの保存容量を確認してください。';
      this.setStageLibraryMessage(message, true);
      this.setPlaygroundStatus(message, true);
      return;
    }
    let legacySaveFailed = false;
    try { localStorage.setItem(PLAYGROUND_STORAGE_KEY, JSON.stringify(definition)); } catch { legacySaveFailed = true; }
    this.playground = definition;
    this.playgroundLibrary = nextLibrary;
    this.playgroundNameDraft = definition.name;
    this.ensurePlaygroundSelection();
    this.applyPlaygroundToSimulation();
    this.renderPlaygroundEditor();
    const action = overwrite ? '上書き' : '新規保存';
    const message = `Stage「${definition.name}」をBrowserへ${action}し、保存一覧へ追加しました。`;
    this.setStageLibraryMessage(legacySaveFailed ? `${message}（旧Browser保存の更新はできませんでした）` : message, legacySaveFailed);
    this.setPlaygroundStatus(message, legacySaveFailed);
  }

  private loadPlaygroundFromLibrary(name: string): void {
    const saved = this.playgroundLibrary.items.find((item) => item.definition.name === name);
    if (!saved) {
      const message = '選択した保存Stageが見つかりません。';
      this.setStageLibraryMessage(message, true);
      this.setPlaygroundStatus(message, true);
      return;
    }
    const snapshot = clonePlayground(this.playground);
    if (!this.commitDefinition(saved.definition, snapshot, null)) return;
    this.playgroundLibrary = { ...this.playgroundLibrary, selected: saved.definition.name };
    this.playgroundNameDraft = this.playground.name;
    try { localStorage.setItem(PLAYGROUND_LIBRARY_STORAGE_KEY, JSON.stringify(this.playgroundLibrary)); } catch { /* 次回起動時の選択保存だけ失敗する。 */ }
    this.renderPlaygroundEditor();
    const message = `保存Stage「${saved.definition.name}」を読み込みました。`;
    this.setStageLibraryMessage(message);
    this.setPlaygroundStatus(message);
  }

  private loadPlaygroundFromBrowser(): void {
    let saved: string | null = null;
    try { saved = localStorage.getItem(PLAYGROUND_STORAGE_KEY); } catch { /* 下の未保存メッセージへ進む。 */ }
    if (!saved) {
      const message = 'Browserに保存したPlaygroundはまだありません。';
      this.setStageLibraryMessage(message, true);
      this.setPlaygroundStatus(message, true);
      return;
    }
    this.replacePlaygroundFromUnknown(saved, '旧Browser保存からPlaygroundを読み込みました。');
  }

  private deleteSelectedPlaygroundObject(): void {
    if (this.playground.objects.length <= 1 || !this.selectedPlaygroundId) return;
    const selected = this.playground.objects.find((object) => object.id === this.selectedPlaygroundId);
    if (!selected) return;
    const next = clonePlayground(this.playground);
    next.objects = next.objects.filter((object) => object.id !== selected.id);
    this.selectedPlaygroundId = '';
    if (this.commitDefinition(next, this.playground, null)) this.setPlaygroundStatus(`${selected.label}を削除しました。Undoで戻せます。`);
  }

  private replacePlaygroundFromUnknown(value: unknown, successMessage: string): void {
    const snapshot = clonePlayground(this.playground);
    let parsed: PlaygroundDefinition;
    try {
      parsed = parsePlayground(value);
    } catch (error) {
      this.setPlaygroundStatus(error instanceof Error ? error.message : String(error), true);
      return;
    }
    if (this.commitDefinition(parsed, snapshot, null)) {
      this.playgroundNameDraft = parsed.name;
      this.renderPlaygroundEditor();
      this.setPlaygroundStatus(successMessage);
    }
  }

  private commitDefinition(next: PlaygroundDefinition, snapshot: PlaygroundDefinition, message: string | null, changedId?: string, validateClearance = true): boolean {
    try {
      const parsed = parsePlayground(next);
      if (validateClearance) {
        const robot = this.simulation?.getRobotPlanarPosition() ?? { x: 0, z: 2.65 };
        if (changedId !== undefined) {
          const changed = parsed.objects.find((object) => object.id === changedId);
          if (changed) validateRobotClearance(changed, robot.x, robot.z);
        } else {
          parsed.objects.forEach((object) => validateRobotClearance(object, robot.x, robot.z));
        }
      }
      this.playgroundHistory.push(snapshot);
      this.playground = parsed;
      this.ensurePlaygroundSelection();
      this.applyPlaygroundToSimulation();
      this.renderPlaygroundEditor();
      this.updateHandles();
      if (message) this.setPlaygroundStatus(message);
      return true;
    } catch (error) {
      this.applyPlaygroundToSimulation();
      this.renderPlaygroundEditor();
      this.updateHandles();
      this.setPlaygroundStatus(error instanceof Error ? error.message : String(error), true);
      return false;
    }
  }

  private setArmedPlacement(kind: PlaygroundObjectKind | null, visionTargetAssetId: VisionTargetAssetId = 'yolox-dog'): void {
    this.armedPlacement = kind;
    this.armedVisionTargetAssetId = visionTargetAssetId;
    this.root.querySelectorAll<HTMLButtonElement>('[data-add-object]').forEach((button) => {
      const buttonAsset = getVisionTargetAssetById(button.dataset.visionTargetAsset ?? '')?.id ?? 'yolox-dog';
      button.classList.toggle('armed', kind !== null && button.dataset.addObject === kind && (kind !== 'vision_target' || buttonAsset === visionTargetAssetId));
    });
    if (kind) {
      const asset = kind === 'vision_target' ? getVisionTargetAssetById(visionTargetAssetId) : null;
      this.setPlaygroundStatus(`ステージ上の配置位置をクリックしてください（${asset?.label ?? KIND_LABELS[kind]}）。もう一度ツールを押すと解除されます。`);
    }
  }

  private setPlaygroundStageSize(stageSize: PlaygroundStageSize): void {
    if (this.activeView !== 'stage' || this.playground.stageSize === stageSize) return;
    const preset = PLAYGROUND_STAGE_PRESETS[stageSize];
    const snapshot = clonePlayground(this.playground);
    const next = clonePlayground(this.playground);
    next.stageSize = stageSize;
    const halfExtent = preset.halfExtent;
    const resizeBoundary = (id: string, x: number, z: number, rotation: number): void => {
      const wall = next.objects.find((object) => object.id === id);
      if (!wall || wall.kind !== 'wall') return;
      wall.position = { x, z };
      wall.rotation = rotation;
      wall.size.width = preset.worldSize;
    };
    resizeBoundary('wall-north', 0, -halfExtent, 0);
    resizeBoundary('wall-south', 0, halfExtent, 0);
    resizeBoundary('wall-west', -halfExtent, 0, Math.PI / 2);
    resizeBoundary('wall-east', halfExtent, 0, Math.PI / 2);
    if (this.commitDefinition(next, snapshot, null, undefined, false)) {
      this.setPlaygroundStatus(`${preset.label}へ変更しました。グリッド${preset.gridCells}マス・${preset.worldSize} m四方です。標準の四周壁も追随しました。`);
    }
  }

  private duplicateSelectedPlaygroundObject(): void {
    if (this.activeView !== 'stage') return;
    const selected = this.selectedPlaygroundObject();
    if (!selected) { this.setPlaygroundStatus('複製するオブジェクトを選択してください。', true); return; }
    if (this.playground.objects.length >= 64) { this.setPlaygroundStatus('objectは64個までです。先に不要なobjectを削除してください。', true); return; }
    const snapshot = clonePlayground(this.playground);
    const next = clonePlayground(this.playground);
    const id = this.nextDuplicateId(selected.id, next.objects.map((object) => object.id));
    const label = `${selected.label} コピー`.slice(0, 80);
    const bounds = this.stagePositionBounds();
    let x = selected.position.x + DUPLICATE_OFFSET_X;
    if (x > bounds) x = selected.position.x - DUPLICATE_OFFSET_X;
    if (x < -bounds || x > bounds) { this.setPlaygroundStatus('ステージ端のため、選択中のオブジェクトを横へ複製できません。', true); return; }
    const position = { x: this.snapped(x, .1), z: selected.position.z };
    const duplicate: PlaygroundObject = {
      ...selected,
      id,
      label,
      position,
      size: { ...selected.size },
    };
    next.objects.push(duplicate);
    const previousSelection = this.selectedPlaygroundId;
    this.selectedPlaygroundId = id;
    if (!this.commitDefinition(next, snapshot, `${selected.label}を水平方向へ少しずらして複製しました。`, id)) {
      this.selectedPlaygroundId = previousSelection;
      this.renderPlaygroundEditor();
    }
  }

  private nextDuplicateId(baseId: string, existingIds: string[]): string {
    const ids = new Set(existingIds);
    const makeId = (suffix: string): string => `${baseId.slice(0, 48 - suffix.length)}${suffix}`;
    let candidate = makeId('-copy');
    let index = 2;
    while (ids.has(candidate)) {
      const suffix = `-copy-${index}`;
      candidate = makeId(suffix);
      index += 1;
    }
    return candidate;
  }

  private setEditTool(tool: 'move' | 'rotate'): void {
    this.editTool = tool;
    const moveActive = tool === 'move';
    const moveButton = this.find<HTMLButtonElement>('#mode-move');
    const rotateButton = this.find<HTMLButtonElement>('#mode-rotate');
    moveButton.classList.toggle('active', moveActive);
    moveButton.setAttribute('aria-pressed', String(moveActive));
    rotateButton.classList.toggle('active', !moveActive);
    rotateButton.setAttribute('aria-pressed', String(!moveActive));
    this.updateHandles();
    this.setPlaygroundStatus(moveActive
      ? '移動モードです。オブジェクトをドラッグで移動、四隅のハンドルでリサイズできます。'
      : '回転モードです。オブジェクトをドラッグで回転します（snap ON時は5°間隔）。');
  }

  private setStageView(view: 'plan' | 'orbit'): void {
    if (!this.simulation) return;
    this.dispatchAppEvent({ type: 'STAGE_SURFACE_REQUESTED', surface: view });
  }

  private applyStageSurface(view: 'plan' | 'orbit'): void {
    if (!this.simulation) return;
    this.simulation.setStageView(view);
    this.syncStageViewButtons(view);
    this.cancelGesture(false);
    this.updateHandles();
    this.setPlaygroundStatus(view === 'plan'
      ? '図面ビュー（真上）です。ドラッグ移動・角リサイズ・回転・ホイールズームができます。'
      : 'カメラビューです。右ドラッグ=回転 / Space+左ドラッグ=水平移動 / 左ドラッグ=オブジェクト編集 / ホイール=ズーム / WASD=前後左右 / Q・R=上下。');
  }

  private syncStageViewButtons(view: 'plan' | 'orbit'): void {
    const planActive = view === 'plan';
    const planButton = this.find<HTMLButtonElement>('#view-plan');
    const cameraButton = this.find<HTMLButtonElement>('#view-camera');
    planButton.classList.toggle('active', planActive);
    planButton.setAttribute('aria-pressed', String(planActive));
    cameraButton.classList.toggle('active', !planActive);
    cameraButton.setAttribute('aria-pressed', String(!planActive));
  }

  private updateFlyInput(): void {
    const forward = (this.stageFlyKeys.has('w') ? 1 : 0) + (this.stageFlyKeys.has('s') ? -1 : 0);
    const strafe = (this.stageFlyKeys.has('d') ? 1 : 0) + (this.stageFlyKeys.has('a') ? -1 : 0);
    const vertical = (this.stageFlyKeys.has('r') ? 1 : 0) + (this.stageFlyKeys.has('q') ? -1 : 0);
    this.simulation?.setFlyInput(forward, strafe, vertical);
  }

  private stagePositionBounds(): number {
    return PLAYGROUND_STAGE_PRESETS[this.playground.stageSize].objectBounds;
  }

  private stageObjectSizeLimit(): number {
    return PLAYGROUND_STAGE_PRESETS[this.playground.stageSize].worldSize + .4;
  }

  private snapped(value: number, grid: number): number {
    const rounded = Math.round(value * 1000) / 1000;
    return this.snapEnabled ? snapToGrid(rounded, grid) : rounded;
  }

  private selectedPlaygroundObject(): PlaygroundObject | null {
    return this.playground.objects.find((object) => object.id === this.selectedPlaygroundId) ?? null;
  }

  private hitResizeHandle(clientX: number, clientY: number, object: PlaygroundObject): number {
    if (this.stageView === 'orbit') {
      const heightHandle = this.simulation?.projectToCanvas(object.position.x, object.size.height, object.position.z);
      if (heightHandle) {
        const shellRect = this.stageShell.getBoundingClientRect();
        if (Math.hypot(shellRect.left + heightHandle.x - clientX, shellRect.top + heightHandle.y - HEIGHT_HANDLE_OFFSET_PX - clientY) <= HANDLE_HIT_RADIUS) return HEIGHT_HANDLE;
      }
    }
    const corners = footprintCorners(object);
    for (let index = 0; index < corners.length; index += 1) {
      const projected = this.simulation?.projectToCanvas(corners[index].x, .02, corners[index].z);
      if (!projected) continue;
      const rect = this.stageShell.getBoundingClientRect();
      const handleX = rect.left + projected.x;
      const handleY = rect.top + projected.y;
      if (Math.hypot(handleX - clientX, handleY - clientY) <= HANDLE_HIT_RADIUS) return index;
    }
    return -1;
  }

  private updateHandles(): void {
    const container = this.stageHandles;
    const selected = this.activeView === 'stage' && this.editTool === 'move' ? this.selectedPlaygroundObject() : null;
    if (!selected || !this.simulation) { container.replaceChildren(); container.hidden = true; return; }
    const positions: Array<{ className: string; x: number; y: number }> = [];
    footprintCorners(selected).forEach((corner, index) => {
      const projected = this.simulation!.projectToCanvas(corner.x, .02, corner.z);
      if (!projected) return;
      positions.push({ className: `stage-handle stage-handle-${index}`, x: projected.x, y: projected.y });
    });
    if (this.stageView === 'orbit') {
      const top = this.simulation.projectToCanvas(selected.position.x, selected.size.height, selected.position.z);
      if (top) {
        positions.push({ className: 'stage-handle stage-handle-height', x: top.x, y: top.y - HEIGHT_HANDLE_OFFSET_PX });
      }
    }
    if (positions.length < (this.stageView === 'orbit' ? 5 : 4)) { container.replaceChildren(); container.hidden = true; return; }
    if (container.children.length !== positions.length) {
      container.replaceChildren(...positions.map((position) => {
        const handle = document.createElement('div');
        handle.className = position.className;
        return handle;
      }));
    }
    positions.forEach((position, index) => {
      const handle = container.children[index];
      if (!(handle instanceof HTMLElement)) return;
      handle.className = position.className;
      handle.style.left = `${position.x}px`;
      handle.style.top = `${position.y}px`;
    });
    container.hidden = false;
  }

  private syncInspectorLive(gesture: StageGesture): void {
    const write = (selector: string, value: number): void => { this.find<HTMLInputElement>(selector).value = String(Number(value.toFixed(3))); };
    write('#object-x', gesture.lastX);
    write('#object-z', gesture.lastZ);
    write('#object-rotation', gesture.lastRotation * 180 / Math.PI);
    if (gesture.kind === 'resize') {
      write('#object-width', gesture.lastWidth);
      write('#object-depth', gesture.lastDepth);
    }
    if (gesture.kind === 'resizeHeight') {
      write('#object-height', gesture.lastHeight);
    }
  }

  private ensurePlaygroundSelection(): void {
    if (!this.playground.objects.some((object) => object.id === this.selectedPlaygroundId)) this.selectedPlaygroundId = this.playground.objects[0].id;
  }

  private applyPlaygroundToSimulation(): void {
    this.simulation?.applyPlayground(this.playground, this.activeView === 'stage' ? this.selectedPlaygroundId : '');
  }

  private renderPlaygroundEditor(): void {
    this.find('#stage-title').textContent = `${this.playground.name}を編集する`;
    this.find<HTMLInputElement>('#stage-name-input').value = this.playgroundNameDraft;
    this.renderPlaygroundLibrary();
    const select = this.find<HTMLSelectElement>('#playground-object-select');
    select.replaceChildren(...this.playground.objects.map((object) => {
      const option = document.createElement('option');
      option.value = object.id;
      option.textContent = `${object.label} / ${KIND_LABELS[object.kind]}`;
      return option;
    }));
    this.ensurePlaygroundSelection();
    select.value = this.selectedPlaygroundId;
    const selected = this.playground.objects.find((object) => object.id === this.selectedPlaygroundId) ?? null;
    const labelInput = this.find<HTMLInputElement>('#object-label');
    const numericFields: Array<[string, number | null]> = [
      ['#object-x', selected?.position.x ?? null],
      ['#object-z', selected?.position.z ?? null],
      ['#object-rotation', selected ? selected.rotation * 180 / Math.PI : null],
      ['#object-width', selected?.size.width ?? null],
      ['#object-height', selected?.size.height ?? null],
      ['#object-depth', selected?.size.depth ?? null],
    ];
    for (const [selector, value] of numericFields) {
      const input = this.find<HTMLInputElement>(selector);
      input.value = value === null ? '' : String(Number(value.toFixed(3)));
      input.disabled = value === null;
    }
    const stagePreset = PLAYGROUND_STAGE_PRESETS[this.playground.stageSize];
    ['#object-x', '#object-z'].forEach((selector) => {
      const input = this.find<HTMLInputElement>(selector);
      input.min = String(-stagePreset.objectBounds);
      input.max = String(stagePreset.objectBounds);
    });
    ['#object-width', '#object-depth'].forEach((selector) => {
      this.find<HTMLInputElement>(selector).max = String(stagePreset.worldSize + .4);
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-stage-size]').forEach((button) => {
      const active = button.dataset.stageSize === this.playground.stageSize;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    labelInput.value = selected?.label ?? '';
    labelInput.disabled = selected === null;
    const assetField = this.find<HTMLElement>('#vision-target-asset-field');
    const assetSelect = this.find<HTMLSelectElement>('#vision-target-asset');
    const selectedAsset = selected?.kind === 'vision_target' ? this.stageImageOptionForReference(selected.asset) : null;
    const imageOptions = this.stageImageOptions();
    assetSelect.replaceChildren(...imageOptions.map((asset) => {
      const option = document.createElement('option');
      option.value = asset.value;
      option.textContent = asset.expectedClasses.length > 0 ? `${asset.label} / ${asset.expectedClasses.join(', ')}` : asset.label;
      return option;
    }), (() => {
      const option = document.createElement('option');
      option.value = STAGE_IMAGE_UPLOAD_OPTION;
      option.textContent = '画像Upload';
      return option;
    })());
    assetField.hidden = selected?.kind !== 'vision_target';
    assetSelect.disabled = selected?.kind !== 'vision_target';
    assetSelect.value = selectedAsset?.value ?? VISION_TARGET_ASSETS.yoloxDog.id;
    this.find<HTMLButtonElement>('#duplicate-object-button').disabled = !selected || this.playground.objects.length >= 64;
    this.find<HTMLButtonElement>('#undo-playground').disabled = !this.playgroundHistory.canUndo;
    this.find<HTMLButtonElement>('#redo-playground').disabled = !this.playgroundHistory.canRedo;
    this.find<HTMLButtonElement>('#delete-object-button').disabled = this.playground.objects.length <= 1 || !selected;
    this.updateHandles();
  }

  private setPlaygroundStatus(message: string, error = false): void {
    const status = this.find('#stage-status');
    status.textContent = message;
    status.classList.toggle('error-text', error);
    if (error) this.showNarration(message);
  }

  private setStageLibraryMessage(message: string, error = false): void {
    const status = this.find('#stage-library-message');
    status.textContent = message;
    status.classList.toggle('error-text', error);
  }

  private renderPlaygroundLibrary(): void {
    const select = this.find<HTMLSelectElement>('#playground-library-select');
    const selectedName = this.playgroundLibrary.selected && this.playgroundLibrary.items.some((item) => item.definition.name === this.playgroundLibrary.selected)
      ? this.playgroundLibrary.selected
      : '';
    const options = this.playgroundLibrary.items.map((item) => {
      const option = document.createElement('option');
      const name = item.definition.name;
      const modified = Number.isFinite(item.savedAt)
        ? new Date(item.savedAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '';
      option.value = name;
      option.textContent = name === selectedName && modified ? `${name}（選択中・${modified}）` : modified ? `${name}（${modified}）` : name;
      return option;
    });
    if (options.length === 0) {
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = '保存Stageはまだありません';
      options.push(empty);
    }
    select.replaceChildren(...options);
    select.value = selectedName;
    select.disabled = this.playgroundLibrary.items.length === 0;
    this.find('#stage-count').textContent = `${this.playgroundLibrary.items.length}件`;
  }


  private bindExplorationControls(): void {
    this.find<HTMLButtonElement>('#exploration-diversion-toggle').addEventListener('click', () => {
      this.explorationDiversionEnabled = !this.explorationDiversionEnabled;
      localStorage.setItem(EXPLORATION_DIVERSION_STORAGE_KEY, this.explorationDiversionEnabled ? 'on' : 'off');
      if (!this.explorationDiversionEnabled) {
        this.explorationDiversionAnchor = null;
        this.pendingBackupDiversionTaskId = null;
        this.backupTaskByGoalId.clear();
      }
      this.explorationLastReason = this.explorationDiversionEnabled
        ? 'BackUp成功後の遠方frontier変更を有効にしました。'
        : '遠方変更をOFFにしました。BackUp後はNav2の従来再計画を続けます。';
      this.renderExplorationControls();
      this.showNarration(this.explorationLastReason);
    });
    this.find<HTMLButtonElement>('#prepare-exploration-button').addEventListener('click', () => {
      this.dispatchAppEvent({ type: 'RUNTIME_SWITCH_REQUESTED', target: 'exploration' });
    });
    this.find<HTMLButtonElement>('#start-exploration-button').addEventListener('click', () => {
      if (this.dispatchAppEvent({ type: 'EXPLORATION_START_REQUESTED', mapGeneration: this.explorationMapGeneration, requestedAtMs: Date.now() })) {
        this.explorationLastReason = '探索を開始しました。fresh mapのfrontierを評価します。';
        this.renderExplorationControls();
      }
    });
    this.find<HTMLButtonElement>('#pause-exploration-button').addEventListener('click', () => {
      if (this.dispatchAppEvent({ type: 'EXPLORATION_PAUSE_REQUESTED', status: '探索を一時停止しました / 速度0' })) {
        this.explorationLastReason = 'ユーザー操作で探索を一時停止しました。';
        this.renderExplorationControls();
      }
    });
    this.find<HTMLButtonElement>('#resume-exploration-button').addEventListener('click', () => {
      const recoveringError = this.appState.exploration.status === 'error';
      if (this.dispatchAppEvent({ type: 'EXPLORATION_RESUME_REQUESTED', mapGeneration: this.explorationMapGeneration, requestedAtMs: Date.now() })) {
        this.explorationLastReason = recoveringError
          ? '探索エラーから再開し、失敗goalのblacklistを保持して候補を選び直します。'
          : '探索を再開し、停止前goalを再送せず候補を選び直します。';
        this.renderExplorationControls();
      }
    });
    this.find<HTMLButtonElement>('#stop-exploration-button').addEventListener('click', () => {
      const status = this.appState.exploration.status;
      const coverageReached = this.explorationCoverage !== null
        && explorationCoverageAllowsCompletion(this.explorationCoverage.exploredRatio);
      const message = status === 'error'
        ? '探索エラー状態を終了しました / 速度0'
        : status === 'completed'
          ? '完了した探索を終了しました / 速度0'
          : coverageReached
            ? '探索を終了しました（観測済み領域90%以上） / 速度0'
          : '探索を中止しました / 速度0';
      if (this.dispatchAppEvent({ type: 'EXPLORATION_STOP_REQUESTED', status: message })) {
        this.explorationLastReason = message;
        this.renderExplorationControls();
      }
    });
  }

  private bindNavigationControls(): void {
    this.find<HTMLButtonElement>('#manual-mode-button').addEventListener('click', () => this.setNavigationControl(false, true));
    this.find<HTMLButtonElement>('#navigation-mode-button').addEventListener('click', () => this.setNavigationControl(true, true));
    this.find<HTMLButtonElement>('#cancel-goal-button').addEventListener('click', () => {
      this.cancelCurrentGoal('目標を取り消しました / 停止中');
      this.showNarration('Nav2の目標を取り消して手動操作へ戻しました。');
    });
    this.find<HTMLButtonElement>('#reset-map-button').addEventListener('click', () => {
      const navigation = this.runtimeMode === 'navigation';
      const exploration = this.runtimeMode === 'exploration';
      if (this.dispatchAppEvent({ type: 'MAP_RESET_REQUESTED' })) {
        this.find('#nav-status').textContent = navigation ? '目標を取り消しました / mappingへ切替中…' : exploration ? '探索を終了 / live mapをリセット中…' : '現在マップをリセット中…';
        this.showNarration(navigation
          ? 'マップリセットを優先し、Nav2目標を取り消してmappingへ切り替えています。'
          : exploration
            ? '探索goal・候補・blacklistを消去し、新しいonline mapの配信完了まで操作をロックします。保存済み地図は削除しません。'
            : '現在マップを消去し、新しいmapの配信完了まで操作をロックします。保存済み地図は削除しません。');
      }
    });
    const changeMapZoom = (next: number): void => {
      this.mapZoom = Math.max(.5, Math.min(4, next));
      this.scheduleNavigationMap();
      this.showNarration(`地図表示を${Math.round(this.mapZoom * 100)}%にしました。Fitで全体表示へ戻せます。`);
    };
    this.find<HTMLButtonElement>('#map-zoom-in').addEventListener('click', () => changeMapZoom(this.mapZoom * 1.25));
    this.find<HTMLButtonElement>('#map-zoom-out').addEventListener('click', () => changeMapZoom(this.mapZoom / 1.25));
    this.find<HTMLButtonElement>('#map-fit').addEventListener('click', () => changeMapZoom(1));
    const mapSelect = this.find<HTMLSelectElement>('#map-select');
    const mapNameInput = this.find<HTMLInputElement>('#map-name-input');
    mapNameInput.addEventListener('input', () => this.updateSaveMapButton());
    mapSelect.addEventListener('change', () => {
      const name = mapSelect.value;
      if (!name) return;
      mapNameInput.value = name;
      this.updateSaveMapButton();
      this.requestMapLibrary('select', name);
    });
    this.find<HTMLButtonElement>('#delete-map-button').addEventListener('click', () => {
      const name = mapSelect.value;
      if (!name) return;
      if (window.confirm(`${name} のyaml・画像・開始位置を削除しますか？`)) this.requestMapLibrary('delete', name);
    });
    this.find<HTMLButtonElement>('#save-map-button').addEventListener('click', async () => {
      const unavailable = mapSaveUnavailableReason(this.appState);
      if (!this.transport || unavailable) {
        this.showNarration(unavailable ?? '地図を保存するTransportを利用できません。');
        return;
      }
      const mapName = mapNameInput.value.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(mapName)) {
        this.find('#map-library-message').textContent = '地図名は英数字・ハイフン・アンダースコアの48文字以内で入力してください。';
        return;
      }
      const overwrite = this.savedMapNames.has(mapName);
      if (overwrite && !window.confirm(`${mapName} は保存済みです。同じ名前の地図を上書きしますか？`)) return;
      this.mapSaveInProgress = true;
      this.updateSaveMapButton();
      this.find('#nav-status').textContent = '地図を保存中…';
      this.find('#map-library-message').textContent = `${mapName} を${overwrite ? '上書き' : '新規保存'}しています…`;
      let saved = false;
      try {
        saved = await this.transport.saveMap(`maps/${mapName}`);
      } finally {
        this.mapSaveInProgress = false;
        this.updateSaveMapButton();
      }
      this.find('#nav-status').textContent = saved ? `地図を maps/${mapName}.yaml に保存しました` : '地図保存に失敗しました / ROSログを確認';
      if (saved) {
        this.pendingSavedMap = { name: mapName, overwrite };
        this.lastMapSaveMessage = `保存完了：${mapName} を${overwrite ? '上書き' : 'プルダウンへ追加'}しました。`;
        const startPose = this.mapTrainingStartPose();
        window.setTimeout(() => {
          if (startPose) this.requestMapLibrary('set_start_pose', mapName, startPose);
          else this.requestMapLibrary('select', mapName);
        }, 120);
        window.setTimeout(() => this.requestMapLibrary('list'), 450);
        window.setTimeout(() => this.requestMapLibrary('list'), 1200);
      } else {
        this.pendingSavedMap = null;
        this.lastMapSaveMessage = '';
      }
      const source = this.runtimeMode === 'exploration' ? '探索で作ったlive map' : 'MAPPINGで作った地図';
      this.showNarration(saved ? `${source}を${mapName}として${overwrite ? '上書き' : '新規保存'}し、地図内の開始位置と一緒にNav2用へ選択しました。` : '地図を保存できませんでした。map_saverと/mapの状態を確認してください。');
    });
    this.mapCanvas.addEventListener('pointerdown', (event) => this.sendGoalFromMap(event));
  }

  private cancelCurrentGoal(status: string): void {
    this.dispatchAppEvent({ type: 'NAVIGATION_GOAL_CANCEL_REQUESTED', status });
  }

  private clearGoalData(): void {
    this.goalPose = null;
    this.publishNavigationGoalDistance();
    this.globalPath = null;
    this.localPath = null;
    this.find('#map-goal').textContent = '未指定';
    this.find('#path-status').textContent = '未受信';
    this.scheduleNavigationMap();
  }

  private publishNavigationGoalDistance(): void {
    if (!this.transport || this.transport.getConnectionState() !== 'CONNECTED') return;
    const navigationActive = this.appState.navigation.status === 'sending' || this.appState.navigation.status === 'moving';
    const distance = navigationActive && this.goalPose && this.currentPose
      ? Math.hypot(
        this.goalPose.pose.position.x - this.currentPose.pose.position.x,
        this.goalPose.pose.position.y - this.currentPose.pose.position.y,
      )
      : -1;
    this.transport.publish(
      '/control/navigation_goal_distance',
      topicType('/control/navigation_goal_distance'),
      { data: distance },
    );
  }

  private sendGoalFromMap(event: PointerEvent): void {
    if (!this.hasRuntimeControl()) {
      this.showNarration('目標を送るには「操作権を取得」でこの画面を操作側へ切り替えてください。');
      return;
    }
    if (!this.occupancyMap || !this.transport || this.transport.getConnectionState() !== 'CONNECTED') {
      this.showNarration('目標を送るにはROSへ接続し、保存地図を読み込んでください。');
      return;
    }
    const rect = this.mapCanvas.getBoundingClientRect();
    const viewport = this.mapViewport ?? createMapViewport(this.occupancyMap, this.mapCanvas.width, this.mapCanvas.height, this.mapZoom);
    const point = viewportCanvasToWorld(this.occupancyMap, {
      x: (event.clientX - rect.left) / rect.width * this.mapCanvas.width,
      y: (event.clientY - rect.top) / rect.height * this.mapCanvas.height,
    }, viewport);
    if (!point) {
      this.showNarration('地図の外側です。白い走行可能エリアをクリックしてください。');
      return;
    }
    const milliseconds = Date.now();
    const requestedGoal = { x: point.x, y: point.y, yaw: 0 };
    const adjusted = this.currentPose
      ? adjustNavigationGoalForObstacleBeyond(
        occupancyGridForGoalSelection(this.occupancyMap),
        { x: this.currentPose.pose.position.x, y: this.currentPose.pose.position.y },
        requestedGoal,
      )
      : null;
    const selectedGoal = adjusted?.goal ?? requestedGoal;
    const goal = {
      header: { frame_id: 'map', stamp: { sec: Math.floor(milliseconds / 1000), nanosec: milliseconds % 1000 * 1_000_000 } },
      pose: makePose(selectedGoal.x, selectedGoal.y, selectedGoal.yaw),
    };
    const accepted = this.dispatchAppEvent({ type: 'NAVIGATION_GOAL_REQUESTED', goal, requestedAtMs: milliseconds });
    if (accepted && adjusted?.adjusted && adjusted.obstacleKind) {
      this.showNarration(`目的地の奥に${GOAL_OBSTACLE_LABELS[adjusted.obstacleKind]}が近いため、${formatNumber(adjusted.retreatMeters)}m手前をNav2 goalにしました。`);
    }
  }

  private explainNavigationError(error: NavigationGoalError): string {
    if (error.status === 'aborted') return '経路を作れないか、走行を継続できませんでした';
    if (error.status === 'canceled') return '目標を取り消しました';
    return error.message.length > 90 ? `${error.message.slice(0, 87)}…` : error.message;
  }

  private setNavigationControl(enabled: boolean, publish: boolean): void {
    const timestampMs = Date.now();
    const accepted = this.dispatchAppEvent(publish
      ? { type: 'COMMAND_OWNER_REQUESTED', owner: enabled ? 'navigation' : 'manual', requestedAtMs: timestampMs }
      : { type: 'COMMAND_OWNER_OBSERVED', owner: enabled ? 'navigation' : 'manual', observedAtMs: timestampMs }, publish);
    if (publish && accepted) this.showNarration(enabled ? 'Nav2操作へ切り替えました。地図の白い走行可能領域をクリックして目標を送ってください。' : '手動Controllerだけが速度命令を出すモードです。');
  }

  private runtimeIdleStatus(): string {
    const statusByMode: Record<RuntimeMode, string> = {
      sim: 'SIMモード',
      base: 'ROS base接続済み',
      mapping: 'SLAM Toolboxで地図を作成中',
      navigation: 'AMCL / Nav2の操作待ち',
      exploration: 'Online SLAM / Frontier探索の開始待ち',
    };
    return statusByMode[this.runtimeMode];
  }

  private renderRuntimeModePresentation(previousMode: RuntimeMode): void {
    const nextMode = this.runtimeMode;
    if ((nextMode === 'mapping' || nextMode === 'exploration') && previousMode !== nextMode) {
      this.latestSlamPose = null;
      this.latestMapToOdom = null;
      this.latestExplorationPoseAt = 0;
    }
    if (this.renderedRuntimeMode === nextMode) return;
    this.renderedRuntimeMode = nextMode;
    this.missingGraphChecks = 0;
    this.explorationGraphFailureChecks = 0;
    const labels: Record<RuntimeMode, string> = { sim: 'SIM', base: 'ROS BASE', mapping: 'MAPPING', navigation: 'NAVIGATION', exploration: 'EXPLORATION' };
    this.find('#runtime-mode').textContent = labels[this.runtimeMode];
    this.find('#navigation-guide').textContent = this.runtimeMode === 'mapping'
      ? '手動操作で部屋を一周するとSLAM Toolboxが/mapを作ります。十分に見渡したら「地図を保存」を押します。'
      : this.runtimeMode === 'navigation'
        ? '青緑の現在位置を確認し、走れる白い場所をクリックするとNav2へ目標を送ります。'
        : this.runtimeMode === 'exploration'
          ? 'SLAM Toolboxのlive mapからfrontierを抽出し、既知free側の安全なgoalをNav2へ順次送ります。'
        : this.runtimeMode === 'base'
          ? 'base ROSではSafety・TF・Topic疎通を学べます。地図は --mapping、目標走行は --navigation で起動します。'
          : 'SIMはROS 2なしで動きます。地図を作るときは ./start.sh --mapping で起動してください。';
    if (this.runtimeMode === 'sim') this.occupancyMap = null;
    if (!this.occupancyMap) this.updateMapEmptyMessage();
    this.find('#nav-status').textContent = this.runtimeIdleStatus();
  }

  private requestMapLibrary(action: 'list' | 'select' | 'delete' | 'set_start_pose', name = '', pose?: { x: number; y: number; yaw: number }): void {
    if (!this.transport || this.transport.getConnectionState() !== 'CONNECTED') return;
    if (!this.hasRuntimeControl() && action !== 'list') return;
    if (action === 'delete') this.lastMapSaveMessage = '';
    this.transport.publish('/map_library/request', topicType('/map_library/request'), { data: JSON.stringify({ action, name, ...(pose ? { pose } : {}) }) });
  }

  private updateSaveMapButton(): void {
    const button = this.root.querySelector<HTMLButtonElement>('#save-map-button');
    const input = this.root.querySelector<HTMLInputElement>('#map-name-input');
    if (!button || !input) return;
    const mapName = input.value.trim();
    const validName = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(mapName);
    const connected = this.connectionState === 'CONNECTED';
    const mapping = this.runtimeMode === 'mapping';
    const exploration = this.runtimeMode === 'exploration';
    const explorationActive = exploration && (this.appState.exploration.status === 'evaluating'
      || this.appState.exploration.status === 'sending'
      || this.appState.exploration.status === 'moving'
      || this.appState.exploration.status === 'replanning');
    const saveUnavailable = mapSaveUnavailableReason(this.appState);
    const overwrite = validName && this.savedMapNames.has(mapName);
    button.disabled = !this.hasRuntimeControl() || this.mapSaveInProgress || !canSaveCurrentMap(this.appState) || !validName;
    button.textContent = this.mapSaveInProgress
      ? '保存中…'
      : !connected
        ? 'ROS2接続後に保存'
        : explorationActive
          ? '探索を一時停止して保存'
          : !mapping && !exploration
            ? 'MAPPING／探索で保存'
          : !validName
            ? '地図名を入力'
            : overwrite
              ? 'この地図を上書き'
              : '新しい地図として保存';
    button.title = saveUnavailable ?? (overwrite ? '同じ名前のyaml・画像・開始位置を上書きします' : '現在のlive mapを新しい保存地図として追加します');
  }

  private rememberStamped<T extends { header: { stamp: { sec: number; nanosec: number } } }>(history: T[], sample: T): void {
    history.push(sample);
    if (history.length > 80) history.splice(0, history.length - 80);
  }

  private mapTrainingStartPose(): { x: number; y: number; yaw: number } | null {
    const odomStart = makePose(TRAINING_START_ROS_POSE.x, TRAINING_START_ROS_POSE.y, TRAINING_START_ROS_POSE.yaw);
    const pose = this.latestMapToOdom
      ? applyPlanarTransform(this.latestMapToOdom, odomStart)
      : this.latestSlamPose && this.latestOdomPose
        ? transformOdomPoseToMap(this.latestSlamPose.pose, this.latestOdomPose.pose, odomStart)
        : null;
    if (!pose) return null;
    return { x: pose.position.x, y: pose.position.y, yaw: quaternionToYaw(pose.orientation) };
  }

  private renderMapLibraryState(serialized: string): void {
    try {
      const state = JSON.parse(serialized) as MapLibraryState;
      const maps = Array.isArray(state.maps) ? state.maps.filter((map) => typeof map.name === 'string') : [];
      this.savedMapNames = new Set(maps.map((map) => map.name));
      const nameInput = this.find<HTMLInputElement>('#map-name-input');
      if (state.selected && document.activeElement !== nameInput && !maps.some((map) => map.name === nameInput.value)) nameInput.value = state.selected;
      this.find('#map-count').textContent = `${maps.length}件`;
      const completedSave = this.pendingSavedMap && this.savedMapNames.has(this.pendingSavedMap.name) ? this.pendingSavedMap : null;
      if (completedSave) this.lastMapSaveMessage = `保存完了：${completedSave.name} を${completedSave.overwrite ? '上書き' : 'プルダウンへ追加'}しました。`;
      this.find('#map-library-message').textContent = state.error || this.lastMapSaveMessage || state.status || '保存地図を更新しました。';
      if (completedSave) this.pendingSavedMap = null;
      this.updateSaveMapButton();
      const select = this.find<HTMLSelectElement>('#map-select');
      const deleteButton = this.find<HTMLButtonElement>('#delete-map-button');
      const selectedName = state.selected && maps.some((map) => map.name === state.selected) ? state.selected : maps[0]?.name ?? '';
      const options = maps.map((map) => {
        const option = document.createElement('option');
        option.value = map.name;
        const modified = Number.isFinite(map.modifiedMs) ? new Date(map.modifiedMs).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
        const details = [map.name === selectedName ? '選択中' : '', modified].filter(Boolean);
        option.textContent = details.length > 0 ? `${map.name}（${details.join('・')}）` : map.name;
        return option;
      });
      if (options.length === 0) {
        const empty = document.createElement('option');
        empty.value = '';
        empty.textContent = '保存地図はまだありません';
        options.push(empty);
      }
      select.replaceChildren(...options);
      select.value = selectedName;
      select.disabled = maps.length === 0 || !this.hasRuntimeControl();
      deleteButton.disabled = maps.length === 0 || !this.hasRuntimeControl();
      deleteButton.setAttribute('aria-label', selectedName ? `${selectedName}を削除` : '選択した地図を削除');
    } catch {
      this.find('#map-library-message').textContent = '保存地図一覧を読み取れませんでした。';
    }
  }

  private updateMapEmptyMessage(): void {
    const messages: Record<RuntimeMode, [string, string]> = {
      sim: ['SIMモードでは/mapを使いません', '地図作成は ./start.sh --mapping で開始します'],
      base: ['ROS BASEは接続済みです', 'このモードは/mapを配信しません。./start.sh --mapping で切り替えます'],
      mapping: ['/mapを作成しています', 'WASDで部屋を見渡しながら数秒待ってください'],
      navigation: ['保存地図を読み込んでいます', 'Map ServerとAMCLの起動完了まで数秒待ってください'],
      exploration: ['Online SLAMのlive mapを作成しています', 'SLAM poseとNav2 Actionが揃うと探索を開始できます'],
    };
    const [title, detail] = messages[this.runtimeMode];
    const small = document.createElement('small');
    small.textContent = detail;
    this.mapEmpty.replaceChildren(document.createTextNode(title), document.createElement('br'), small);
    this.mapEmpty.hidden = false;
  }

  private syncNavigationPose(): void {
    if (this.appState.runtime.status !== 'stable' || this.runtimeMode !== 'navigation') return;
    const odom = this.latestOdomPose;
    const mapToOdom = odom
      ? closestStamped(this.mapToOdomHistory, odom.header.stamp, 1000) ?? this.latestMapToOdom
      : this.latestMapToOdom;
    const pose = odom && mapToOdom
      ? applyPlanarTransform(mapToOdom, odom.pose)
      : this.latestAmclPose?.pose;
    const header = mapToOdom?.header ?? this.latestAmclPose?.header;
    if (!pose || !header) return;
    this.currentPose = { header, pose };
    this.updatePoseText();
    this.scheduleNavigationMap();
    this.dispatchAppEvent({ type: 'POSE_READY', cycle: this.appState.map.cycle }, false);
  }

  private syncMappingPose(): void {
    if (this.appState.runtime.status !== 'stable' || (this.runtimeMode !== 'mapping' && this.runtimeMode !== 'exploration')) return;
    const selected = selectMappingPose(this.latestSlamPose, this.mapToOdomHistory, this.odomHistory, 500);
    if (!selected) return;
    if (this.runtimeMode === 'exploration'
      && (!Number.isFinite(selected.timestampMs) || selected.timestampMs <= this.explorationEvidenceNotBeforeMs)) return;
    this.currentPose = selected.pose;
    if (this.runtimeMode === 'exploration') {
      this.latestExplorationPoseAt = selected.timestampMs;
      const poseAgeMs = Date.now() - this.latestExplorationPoseAt;
      if (poseAgeMs >= -1000 && poseAgeMs <= EXPLORATION_POSE_FRESHNESS_MS) {
        const cycle = this.appState.map.cycle;
        if (this.dispatchAppEvent({ type: 'POSE_READY', cycle }, false)) {
          this.dispatchAppEvent({ type: 'EXPLORATION_POSE_OBSERVED', cycle, observedAtMs: selected.timestampMs }, false);
          this.evaluateWaitingExplorationOnFreshMap();
        }
      }
    }
    this.updatePoseText();
    this.scheduleNavigationMap();
  }

  private clearNavigationTracking(): void {
    this.currentPose = null;
    this.latestOdomPose = null;
    this.latestAmclPose = null;
    this.latestMapToOdom = null;
    this.explorationTasksWithStaleTransform.clear();
    this.latestScan = null;
    this.odomHistory.length = 0;
    this.mapToOdomHistory.length = 0;
    this.goalPose = null;
    this.globalPath = null;
    this.localPath = null;
    this.find('#map-pose').textContent = '-- / -- m';
    this.find('#map-goal').textContent = '未指定';
    this.find('#path-status').textContent = '未受信';
    if (!this.occupancyMap) this.updateMapEmptyMessage();
    this.scheduleNavigationMap();
  }

  private clearCurrentMap(): void {
    this.occupancyMap = null;
    this.currentPose = null;
    this.goalPose = null;
    this.globalPath = null;
    this.localPath = null;
    this.mapViewport = null;
    this.mapZoom = 1;
    this.mapRaster.width = 0;
    this.mapRaster.height = 0;
    const context = this.mapCanvas.getContext('2d');
    if (context) { context.fillStyle = '#d8dedb'; context.fillRect(0, 0, this.mapCanvas.width, this.mapCanvas.height); }
    this.find('#map-pose').textContent = '-- / -- m';
    this.find('#map-goal').textContent = '未指定';
    this.find('#path-status').textContent = '未受信';
    this.updateMapEmptyMessage();
  }

  private updatePoseText(): void {
    const position = this.currentPose?.pose.position;
    if (position) this.find('#map-pose').textContent = `${formatNumber(position.x)} / ${formatNumber(position.y)} m`;
  }

  private updatePathText(): void {
    const globalCount = this.globalPath?.poses.length ?? 0;
    const localCount = this.localPath?.poses.length ?? 0;
    this.find('#path-status').textContent = globalCount || localCount ? `Global ${globalCount}点 / Local ${localCount}点` : '未受信';
  }

  private scheduleNavigationMap(mapChanged = false): void {
    this.mapRasterDirty ||= mapChanged;
    if (this.navigationDrawFrame !== null) return;
    this.navigationDrawFrame = window.requestAnimationFrame(() => {
      this.navigationDrawFrame = null;
      if (this.mapRasterDirty) this.rebuildMapRaster();
      this.drawNavigationMap();
    });
  }

  private rebuildMapRaster(): void {
    const map = this.occupancyMap;
    if (!map?.info || !Array.isArray(map.data)) return;
    if (map.info.width <= 0 || map.info.height <= 0) return;
    this.mapRaster.width = map.info.width;
    this.mapRaster.height = map.info.height;
    const rasterContext = this.mapRaster.getContext('2d');
    if (!rasterContext) return;
    const image = rasterContext.createImageData(map.info.width, map.info.height);
    for (let index = 0; index < map.info.width * map.info.height; index += 1) {
      const occupancy = map.data[index] ?? -1;
      const shade = occupancy < 0 ? 207 : occupancy >= 65 ? 42 : Math.max(225, 255 - Math.round(occupancy * 1.5));
      const offset = index * 4;
      image.data[offset] = occupancy < 0 ? 205 : shade;
      image.data[offset + 1] = occupancy < 0 ? 214 : shade;
      image.data[offset + 2] = occupancy < 0 ? 210 : shade;
      image.data[offset + 3] = 255;
    }
    rasterContext.putImageData(image, 0, 0);
    this.mapRasterDirty = false;
  }

  private drawNavigationMap(): void {
    const map = this.occupancyMap;
    if (!map?.info || this.mapRaster.width <= 0 || this.mapRaster.height <= 0) return;
    const context = this.mapCanvas.getContext('2d');
    if (!context) return;
    context.fillStyle = '#d8dedb';
    context.fillRect(0, 0, this.mapCanvas.width, this.mapCanvas.height);
    const viewport = createMapViewport(map, this.mapCanvas.width, this.mapCanvas.height, this.mapZoom);
    this.mapViewport = viewport;
    context.save();
    context.translate(viewport.offsetX, viewport.offsetY + viewport.height);
    context.scale(viewport.scale, -viewport.scale);
    context.imageSmoothingEnabled = false;
    context.drawImage(this.mapRaster, 0, 0);
    context.restore();
    this.drawLiveNavigationScan(context);
    this.drawFrontierOverlay(context);
    this.drawPath(context, this.globalPath, '#3970d5', 3, []);
    this.drawPath(context, this.localPath, '#e88d46', 3, [7, 5]);
    if (this.goalPose) this.drawPoseMarker(context, this.goalPose, '#d9584d', true);
    if (this.currentPose) this.drawPoseMarker(context, this.currentPose, '#159b8b', false);
  }

  private drawFrontierOverlay(context: CanvasRenderingContext2D): void {
    const map = this.occupancyMap;
    const viewport = this.mapViewport;
    const analysis = this.frontierAnalysis;
    const analysisMap = this.frontierAnalysisMap;
    const exploration = this.appState.exploration;
    if (!map || !viewport || !analysis || !analysisMap) return;
    if (exploration.status === 'evaluating' && exploration.mapGeneration !== this.frontierAnalysisMapGeneration) return;
    const analysisOrigin = analysisMap.info.origin;
    const analysisYaw = quaternionToYaw(analysisOrigin.orientation);
    const cellPoint = (index: number): { x: number; y: number } => {
      const cellX = index % analysisMap.info.width;
      const cellY = Math.floor(index / analysisMap.info.width);
      const localX = (cellX + .5) * analysisMap.info.resolution;
      const localY = (cellY + .5) * analysisMap.info.resolution;
      return worldToViewportCanvas(map, {
        x: analysisOrigin.position.x + Math.cos(analysisYaw) * localX - Math.sin(analysisYaw) * localY,
        y: analysisOrigin.position.y + Math.sin(analysisYaw) * localX + Math.cos(analysisYaw) * localY,
      }, viewport);
    };
    context.save();
    context.fillStyle = '#8d67d6';
    context.globalAlpha = .55;
    const cellSize = Math.max(1.5, Math.min(5, viewport.scale));
    for (const index of analysis.frontierCellIndices) {
      const point = cellPoint(index);
      context.fillRect(point.x - cellSize / 2, point.y - cellSize / 2, cellSize, cellSize);
    }
    context.globalAlpha = 1;
    for (const candidate of analysis.candidates) {
      const point = worldToViewportCanvas(map, candidate.world, viewport);
      context.beginPath();
      context.arc(point.x, point.y, candidate === analysis.selected ? 7 : 4.5, 0, Math.PI * 2);
      context.fillStyle = candidate === analysis.selected ? '#d9584d' : '#dff4cf';
      context.strokeStyle = candidate === analysis.selected ? '#ffffff' : '#4f8f32';
      context.lineWidth = candidate === analysis.selected ? 2.5 : 2;
      context.fill();
      context.stroke();
    }
    context.lineWidth = 2;
    for (const rejection of analysis.rejected.slice(0, 64)) {
      const index = rejection.clusterCellIndices[0];
      const point = rejection.candidate
        ? worldToViewportCanvas(map, rejection.candidate.world, viewport)
        : index === undefined ? null : cellPoint(index);
      if (!point) continue;
      if (rejection.reason === 'blacklisted') {
        context.beginPath();
        context.arc(point.x, point.y, 5, 0, Math.PI * 2);
        context.fillStyle = '#fff4df';
        context.strokeStyle = '#d77c2c';
        context.fill();
        context.stroke();
        continue;
      }
      context.strokeStyle = '#65706e';
      context.beginPath();
      context.moveTo(point.x - 3, point.y - 3);
      context.lineTo(point.x + 3, point.y + 3);
      context.moveTo(point.x + 3, point.y - 3);
      context.lineTo(point.x - 3, point.y + 3);
      context.stroke();
    }
    context.restore();
  }

  private drawLiveNavigationScan(context: CanvasRenderingContext2D): void {
    if ((this.runtimeMode !== 'navigation' && this.runtimeMode !== 'exploration') || !this.occupancyMap || !this.mapViewport || !this.latestScan) return;
    const scan = this.latestScan;
    const odom = closestStamped(this.odomHistory, scan.header.stamp, 150);
    const mapToOdom = closestStamped(this.mapToOdomHistory, scan.header.stamp, 500);
    const pose = odom && mapToOdom ? applyPlanarTransform(mapToOdom, odom.pose) : this.currentPose?.pose;
    if (!pose) return;
    context.save();
    context.fillStyle = '#00a7c4';
    context.globalAlpha = .88;
    const visibleRayCount = Math.min(SIM_LIDAR_VISIBLE_RAY_COUNT, scan.ranges.length);
    for (let visibleIndex = 0; visibleIndex < visibleRayCount; visibleIndex += 1) {
      const index = lidarVisibleScanIndex(visibleIndex, scan.ranges.length, visibleRayCount);
      const range = scan.ranges[index];
      if (!Number.isFinite(range) || range < scan.range_min || range >= scan.range_max * .995) continue;
      const point = worldToViewportCanvas(this.occupancyMap, laserHitToWorld(pose, scan.angle_min + scan.angle_increment * index, range), this.mapViewport);
      context.fillRect(point.x - 1.5, point.y - 1.5, 3, 3);
    }
    context.restore();
  }

  private drawPath(context: CanvasRenderingContext2D, path: PathMessage | null, color: string, width: number, dash: number[]): void {
    if (!this.occupancyMap || !this.mapViewport || !path || path.poses.length === 0) return;
    context.beginPath();
    path.poses.forEach((pose, index) => {
      const point = worldToViewportCanvas(this.occupancyMap!, pose.pose.position, this.mapViewport!);
      if (index === 0) context.moveTo(point.x, point.y); else context.lineTo(point.x, point.y);
    });
    context.strokeStyle = color; context.lineWidth = width; context.setLineDash(dash); context.stroke(); context.setLineDash([]);
  }

  private drawPoseMarker(context: CanvasRenderingContext2D, pose: PoseStampedMessage, color: string, goal: boolean): void {
    if (!this.occupancyMap || !this.mapViewport) return;
    const point = worldToViewportCanvas(this.occupancyMap, pose.pose.position, this.mapViewport);
    const yaw = quaternionToYaw(pose.pose.orientation);
    context.save(); context.translate(point.x, point.y); context.rotate(-yaw);
    context.fillStyle = color; context.strokeStyle = '#ffffff'; context.lineWidth = 3;
    context.beginPath();
    if (goal) { context.arc(0, 0, 9, 0, Math.PI * 2); context.moveTo(-13, 0); context.lineTo(13, 0); context.moveTo(0, -13); context.lineTo(0, 13); }
    else {
      const marker = robotMarkerDimensionsForViewport(this.occupancyMap, this.mapViewport);
      const halfLength = marker.length / 2;
      const halfWidth = marker.width / 2;
      context.moveTo(halfLength, 0);
      context.lineTo(marker.length * .12, -halfWidth);
      context.lineTo(-halfLength, -halfWidth);
      context.lineTo(-halfLength, halfWidth);
      context.lineTo(marker.length * .12, halfWidth);
      context.closePath();
    }
    context.fill(); context.stroke(); context.restore();
  }

  private async refreshRosGraph(): Promise<void> {
    const transport = this.transport;
    if (!transport || !canQueryRosGraph(this.appState) || transport.getConnectionState() !== 'CONNECTED') return;
    const requestGeneration = ++this.rosGraphRequestGeneration;
    const runtimeMode = this.runtimeMode;
    const readinessCycle = this.appState.map.cycle;
    const graph = await transport.getGraphSnapshot();
    if (requestGeneration !== this.rosGraphRequestGeneration
      || transport !== this.transport
      || transport.getConnectionState() !== 'CONNECTED'
      || runtimeMode !== this.runtimeMode
      || readinessCycle !== this.appState.map.cycle) return;
    this.renderGraphList('#ros-node-list', graph.nodes);
    this.renderGraphList('#ros-topic-list', graph.topics);
    this.renderGraphList('#ros-action-list', graph.actions);
    this.find('#ros-graph-updated').textContent = `${new Date().toLocaleTimeString('ja-JP')} 更新`;
    const health = evaluateRuntimeRosGraphHealth(runtimeMode, graph.nodes, this.missingGraphChecks, graph.lifecycleManagers);
    this.missingGraphChecks = health.consecutiveMissingChecks;
    const hasNavigateToPose = graph.actions.some((action) => action.replace(/^\//, '') === 'navigate_to_pose');
    if (runtimeMode === 'exploration') {
      const readiness = this.appState.map;
      const readinessHasNavigationEvidence = (readiness.status === 'ready' && readiness.mode === 'exploration')
        || (readiness.status === 'initializing' && readiness.target === 'exploration' && readiness.navigationReceived);
      const explorationHealth = evaluateExplorationReadinessHealth(
        health,
        hasNavigateToPose,
        this.explorationGraphFailureChecks,
        readinessHasNavigationEvidence,
      );
      this.explorationGraphFailureChecks = explorationHealth.consecutiveFailureChecks;
      if (explorationHealth.ready) {
        this.dispatchAppEvent({ type: 'NAVIGATION_READY', cycle: readinessCycle }, false);
      } else {
        const problems = [
          ...health.missing.map((node) => `不足 ${node}`),
          ...health.forbidden.map((node) => `禁止Node残留 ${node}`),
          ...health.notActiveLifecycleManagers.map((node) => `Lifecycle未active ${node}`),
          ...(!hasNavigateToPose ? ['Action未準備 /navigate_to_pose'] : []),
        ];
        const wasReady = this.appState.map.status === 'ready' && this.appState.map.mode === 'exploration';
        if (explorationHealth.shouldInvalidateReadiness) {
          const invalidated = this.dispatchAppEvent({
            type: 'NAVIGATION_UNAVAILABLE',
            cycle: readinessCycle,
            status: `探索用Nav2構成を待機中: ${problems.join('、') || '準備中'}`,
          }, false);
          if (wasReady && invalidated) this.showNarration(`探索用Nav2構成が連続してreadyでないためgoalを取消し、速度を0にしました。${problems.join('、')}`);
        }
      }
    } else {
      this.explorationGraphFailureChecks = 0;
    }
    if (health.shouldStop && runtimeMode !== 'exploration') {
      if (this.dispatchAppEvent({ type: 'SAFE_STOP_REQUESTED', status: 'ROS構成Node停止 / 速度0' })) {
        const problem = [...health.missing.map((node) => `不足 ${node}`), ...health.forbidden.map((node) => `禁止Node残留 ${node}`)].join('、');
        this.showNarration(`ROS構成が不正（${problem}）なため停止しました。構成を再起動するか、SIMモードへ戻ってください。`);
      }
    }
  }

  private renderGraphList(selector: string, values: string[]): void {
    const list = this.find<HTMLUListElement>(selector);
    const visible = values.length > 0 ? values.slice(0, 40) : ['見つかりません'];
    list.replaceChildren(...visible.map((value) => { const item = document.createElement('li'); item.textContent = value; return item; }));
  }

  private bindInspectorTabs(): void { this.root.querySelectorAll<HTMLButtonElement>('.inspector-tab').forEach((tab) => tab.addEventListener('click', () => { this.root.querySelectorAll('.inspector-tab').forEach((item) => item.classList.remove('active')); tab.classList.add('active'); this.selectedTopic = tab.dataset.topic as TopicName; const message = this.eventLog.get(this.selectedTopic); if (message !== undefined) this.renderInspector(this.selectedTopic, message); })); }

  private bindMissions(): void {
    const explanations: Record<string, string> = {
      move: 'Wキーまたは画面下のパッドで、前進・旋回・停止を順番に試してみましょう。',
      lidar: '2Dスキャン上の点を選ぶと、そのRayと距離が3D画面でも強調されます。',
      safety: '中央のオレンジ色の箱へ近づくと、Safety Controllerが前進だけを止めます。',
      camera: 'RGBはロボット前面のoffscreen Cameraが、同じThree.js Sceneを5 Hzで撮影しています。',
      depth: '疑似カラーDepthを選ぶと、camera optical frameのZ方向距離をmで確認できます。',
      yolo: 'pixi run vision-assetsの後にROSを起動し、実YOLOX Nodeが返すbboxとconfidenceを確認します。',
      compare: 'Cameraは前面の画素ごと、LiDARは水平面のRayごとに距離を測ります。両方を選んで違いを比べます。',
    };
    this.root.querySelectorAll<HTMLElement>('.mission-item').forEach((item) => {
      const id = item.dataset.mission ?? '';
      if (this.missions.has(id)) item.classList.add('done');
      item.addEventListener('click', () => this.showNarration(explanations[id] ?? '学習ミッションです。'));
    });
  }
  private bindGlossary(): void { const explanations: Record<string, string> = { Node: 'Nodeは一つの仕事を担当する小さなプログラムです。ControllerやSafety ControllerがNodeです。', Topic: 'Topicはメッセージが流れる名前付きの通り道です。/scanや/cmd_velがTopicです。', Message: 'MessageはNode同士で送るデータのまとまりです。速度や距離が入ります。', Publisher: 'PublisherはTopicへMessageを送る側です。LiDARは/scanをPublishします。' }; this.root.querySelectorAll<HTMLElement>('.glossary-card').forEach((card) => card.addEventListener('click', () => this.showNarration(explanations[card.dataset.term ?? ''] ?? 'ROS 2の用語カードです。'))); }
  private bindLidarSelection(): void { this.lidarCanvas.addEventListener('pointerdown', (event) => { if (!this.simulation) return; const rect = this.lidarCanvas.getBoundingClientRect(); const x = (event.clientX - rect.left) / rect.width * this.lidarCanvas.width - this.lidarCanvas.width / 2; const y = (event.clientY - rect.top) / rect.height * this.lidarCanvas.height - this.lidarCanvas.height / 2; const angle = Math.atan2(x, -y); let index = Math.round(((angle + Math.PI) / (2 * Math.PI)) * this.rayCount) % this.rayCount; if (index < 0) index += this.rayCount; this.simulation.selectRay(index); this.markMission('lidar'); }); }

  private renderInspector(topic: TopicName, message: TopicMessage): void {
    this.inspectorTopic.textContent = topic;
    this.inspectorTopic.className = `topic-chip ${topic === '/scan' ? 'sensor-chip' : topic.startsWith('/safety') ? 'safety-chip' : 'command-chip'}`;
    this.rawMessage.textContent = JSON.stringify(message, null, 2);
    if (topic === '/cmd_vel' || topic === '/cmd_vel_raw') { const twist = message as TwistMessage; this.friendlyMessage.innerHTML = `前進速度：<strong>${formatNumber(twist.linear.x)} m/s</strong><br />旋回速度：<strong>${formatNumber(twist.angular.z)} rad/s</strong>`; }
    else if (topic === '/scan') { const scan = message as LaserScanMessage; const middle = scan.ranges[Math.floor(scan.ranges.length / 2)] ?? scan.range_max; this.friendlyMessage.innerHTML = `正面の距離：<strong>${formatNumber(middle)} m</strong><br />${scan.ranges.length}本の物差しが周囲を測っています`; }
    else if (topic === '/odom') { const odom = message as OdometryMessage; this.friendlyMessage.innerHTML = `ロボット位置：<strong>${formatNumber(odom.pose.pose.position.x)} / ${formatNumber(odom.pose.pose.position.y)} m</strong><br />移動した量を記録しています`; }
    else if (topic === '/camera/camera_info') { const info = message as CameraInfoMessage; this.friendlyMessage.textContent = `${info.width}×${info.height} / frame=${info.header.frame_id} / fx=${formatNumber(info.k[0], 1)} px`; }
    else if (topic === '/vision/detections') { const detections = message as Detection2DArrayMessage; this.friendlyMessage.textContent = `${detections.detections.length}件の実検出 / class・confidence・bboxを保持`; }
    else if (topic === '/vision/status') { this.friendlyMessage.textContent = `YOLOX Nodeの状態：${unwrapString(message)}`; }
  }

  private animateFlow(topic: TopicName): void {
    const selector = topic === '/cmd_vel_raw' ? '.command-connector' : topic === '/cmd_vel' ? '.safety-connector' : '';
    if (!selector) return;
    const now = performance.now();
    if (now - (this.flowAnimationAt.get(selector) ?? 0) < 1200) return;
    this.flowAnimationAt.set(selector, now);
    const element = this.root.querySelector(selector);
    if (!element) return;
    element.classList.remove('active');
    void (element as HTMLElement).offsetWidth;
    element.classList.add('active');
  }

  private drawLidar(scan: LaserScanMessage): void {
    const context = this.lidarCanvas.getContext('2d'); if (!context) return;
    const size = this.lidarCanvas.width; const center = size / 2; const radius = size * .42;
    context.clearRect(0, 0, size, size); context.fillStyle = '#edf9f4'; context.fillRect(0, 0, size, size);
    context.strokeStyle = '#c3e2d5'; context.lineWidth = 1;
    [1, .5, .25].forEach((scale) => { context.beginPath(); context.arc(center, center, radius * scale, 0, Math.PI * 2); context.stroke(); });
    context.beginPath(); context.moveTo(center, center - radius); context.lineTo(center, center + radius); context.moveTo(center - radius, center); context.lineTo(center + radius, center); context.stroke();
    context.fillStyle = '#287d75'; context.beginPath(); context.arc(center, center, 6, 0, Math.PI * 2); context.fill();
    const visibleRayCount = Math.min(SIM_LIDAR_VISIBLE_RAY_COUNT, scan.ranges.length);
    for (let visibleIndex = 0; visibleIndex < visibleRayCount; visibleIndex += 1) {
      const index = lidarVisibleScanIndex(visibleIndex, scan.ranges.length, visibleRayCount);
      const range = scan.ranges[index];
      const angle = scan.angle_min + scan.angle_increment * index;
      const scaled = Math.min(range / scan.range_max, 1) * radius;
      const x = center + Math.sin(angle) * scaled;
      const y = center - Math.cos(angle) * scaled;
      context.fillStyle = range < .65 ? '#e76f65' : '#28a88f';
      context.beginPath(); context.arc(x, y, 2.15, 0, Math.PI * 2); context.fill();
    }
    context.fillStyle = '#78958c'; context.font = '700 10px ui-monospace'; context.textAlign = 'center'; context.fillText('前', center, 13); context.fillText('後', center, size - 5); context.textAlign = 'left'; context.fillText('左', 8, center - 4); context.textAlign = 'right'; context.fillText('右', size - 8, center - 4);
  }

  showRaySelection(index: number, distance: number): void { this.raySelection.innerHTML = `<span class="selection-kicker">RAY ${index}</span><strong>ranges[${index}] = ${formatNumber(distance)}m<br />このRayが当たった場所までの距離です</strong>`; }

  private renderMissionProgress(): void { const count = this.root.querySelector<HTMLElement>('#mission-progress'); if (count) count.textContent = `${this.missions.size} / 7`; }
}
