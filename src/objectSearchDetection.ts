import { isObjectSearchTargetClass, type ObjectSearchTargetClass } from './objectSearchTargets';

export const APPLE_MIN_CONFIDENCE = .4;
export const APPLE_MIN_BBOX_AREA_RATIO = .015;
export const APPLE_MAX_BBOX_AREA_RATIO = .85;
export const APPLE_MIN_DISTANCE_METERS = .25;
export const APPLE_MAX_DISTANCE_METERS = 6;
/** A visible apple within this optical-Z range completes the search candidate. */
export const APPLE_SEARCH_MAX_DISTANCE_METERS = 5;
export const APPLE_GOAL_DESIRED_DISTANCE_METERS = .9;
export const APPLE_GOAL_MIN_DISTANCE_METERS = .72;
export const APPLE_GOAL_MAX_DISTANCE_METERS = 1.15;
/** Horizontal bbox center may deviate by at most 20% of the image half-width. */
export const APPLE_GOAL_MAX_HORIZONTAL_OFFSET_RATIO = .2;
export const APPLE_MAX_DETECTION_AGE_MS = 500;
export const APPLE_PRESTOP_WINDOW_FRAMES = 5;
export const APPLE_PRESTOP_REQUIRED_HITS = 3;
export const APPLE_POSTSTOP_WINDOW_FRAMES = 3;
export const APPLE_POSTSTOP_REQUIRED_HITS = 2;
export const APPLE_POSTSTOP_LOST_AFTER_FRAMES = 5;

export interface AppleDetectionCycle {
  missionGeneration: number;
  visionCycle: number;
  transportCycle: number;
}

export interface AppleDetectionInput {
  classId: string;
  confidence: number;
  bbox: {
    centerX: number;
    centerY: number;
    width: number;
    height: number;
  };
  distanceMeters: number | null;
  index: number;
}

export interface AppleDetectionEvidence extends AppleDetectionInput {
  bboxAreaRatio: number;
  centerDistanceSquared: number;
  imageWidth: number;
  imageHeight: number;
  frameStampMs: number;
  observedAtMs: number;
}

export interface AppleDetectionFrameInput extends AppleDetectionCycle {
  frameStampMs: number;
  cameraFrameStampMs: number;
  observedAtMs: number;
  imageWidth: number;
  imageHeight: number;
  detections: readonly AppleDetectionInput[];
}

export interface AppleDetectionFrameEvidence {
  frameStampMs: number;
  observedAtMs: number;
  hit: boolean;
  selected: AppleDetectionEvidence | null;
}

export interface AppleDetectionTracker extends AppleDetectionCycle {
  targetClass: ObjectSearchTargetClass;
  phase: 'prestop' | 'poststop';
  notBeforeFrameStampMs: number;
  frames: readonly AppleDetectionFrameEvidence[];
  lastFrameStampMs: number | null;
  acceptedFrameCount: number;
}

export interface CreateAppleDetectionTrackerInput extends AppleDetectionCycle {
  targetClass?: ObjectSearchTargetClass;
  phase: 'prestop' | 'poststop';
  notBeforeFrameStampMs: number;
}

export interface AppleDetectionObservation {
  accepted: boolean;
  rejection?: string;
  tracker: AppleDetectionTracker;
  selected: AppleDetectionEvidence | null;
  hitCount: number;
  windowSize: number;
  requiredHits: number;
  candidateConfirmed: boolean;
  postStopConfirmed: boolean;
  postStopLost: boolean;
}

const MAX_TRACKED_FRAMES = Math.max(APPLE_PRESTOP_WINDOW_FRAMES, APPLE_POSTSTOP_LOST_AFTER_FRAMES);

function validCycleValue(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function validateTrackerInput(input: CreateAppleDetectionTrackerInput): void {
  if (!validCycleValue(input.missionGeneration)
    || !validCycleValue(input.visionCycle)
    || !validCycleValue(input.transportCycle)
    || !Number.isFinite(input.notBeforeFrameStampMs)
    || input.notBeforeFrameStampMs < 0
    || (input.targetClass !== undefined && !isObjectSearchTargetClass(input.targetClass))) {
    throw new RangeError('Apple detection tracker cycle and time values must be finite and non-negative.');
  }
}

export function createAppleDetectionTracker(input: CreateAppleDetectionTrackerInput): AppleDetectionTracker {
  validateTrackerInput(input);
  return {
    ...input,
    targetClass: input.targetClass ?? 'apple',
    frames: [],
    lastFrameStampMs: null,
    acceptedFrameCount: 0,
  };
}

export function resetAppleDetectionTrackerForPostStop(
  tracker: AppleDetectionTracker,
  stoppedAtMs: number,
): AppleDetectionTracker {
  return createAppleDetectionTracker({
    phase: 'poststop',
    missionGeneration: tracker.missionGeneration,
    visionCycle: tracker.visionCycle,
    transportCycle: tracker.transportCycle,
    targetClass: tracker.targetClass,
    notBeforeFrameStampMs: stoppedAtMs,
  });
}

function eligibleAppleDetection(
  detection: AppleDetectionInput,
  imageWidth: number,
  imageHeight: number,
  targetClass: ObjectSearchTargetClass,
): AppleDetectionEvidence | null {
  const { bbox } = detection;
  if (detection.classId !== targetClass
    || !Number.isFinite(detection.confidence)
    || detection.confidence < APPLE_MIN_CONFIDENCE
    || !Number.isInteger(detection.index)
    || detection.index < 0
    || !Number.isFinite(bbox.centerX)
    || !Number.isFinite(bbox.centerY)
    || !Number.isFinite(bbox.width)
    || !Number.isFinite(bbox.height)
    || bbox.width <= 0
    || bbox.height <= 0
    || bbox.centerX < 0
    || bbox.centerX > imageWidth
    || bbox.centerY < 0
    || bbox.centerY > imageHeight) return null;
  const bboxAreaRatio = bbox.width * bbox.height / (imageWidth * imageHeight);
  if (!Number.isFinite(bboxAreaRatio)
    || bboxAreaRatio < APPLE_MIN_BBOX_AREA_RATIO
    || bboxAreaRatio > APPLE_MAX_BBOX_AREA_RATIO) return null;
  const dx = bbox.centerX - imageWidth / 2;
  const dy = bbox.centerY - imageHeight / 2;
  const distanceMeters = detection.distanceMeters !== null && Number.isFinite(detection.distanceMeters)
    ? detection.distanceMeters
    : null;
  return {
    ...detection,
    distanceMeters,
    bboxAreaRatio,
    centerDistanceSquared: dx * dx + dy * dy,
    imageWidth,
    imageHeight,
    frameStampMs: 0,
    observedAtMs: 0,
  };
}

function compareAppleDetections(left: AppleDetectionEvidence, right: AppleDetectionEvidence): number {
  if (left.confidence !== right.confidence) return left.confidence > right.confidence ? -1 : 1;
  if (left.bboxAreaRatio !== right.bboxAreaRatio) return left.bboxAreaRatio > right.bboxAreaRatio ? -1 : 1;
  if (left.centerDistanceSquared !== right.centerDistanceSquared) return left.centerDistanceSquared < right.centerDistanceSquared ? -1 : 1;
  return left.index - right.index;
}

export function selectAppleDetection(
  detections: readonly AppleDetectionInput[],
  imageWidth: number,
  imageHeight: number,
  targetClass: ObjectSearchTargetClass = 'apple',
): AppleDetectionEvidence | null {
  if (!Number.isInteger(imageWidth) || imageWidth <= 0 || !Number.isInteger(imageHeight) || imageHeight <= 0) return null;
  const eligible = detections.flatMap((detection) => {
    const candidate = eligibleAppleDetection(detection, imageWidth, imageHeight, targetClass);
    return candidate ? [candidate] : [];
  });
  eligible.sort(compareAppleDetections);
  return eligible[0] ?? null;
}

function rejectionForFrame(tracker: AppleDetectionTracker, input: AppleDetectionFrameInput): string | null {
  if (input.missionGeneration !== tracker.missionGeneration) return '古いObject Search mission cycleのDetectionは使用しません。';
  if (input.visionCycle !== tracker.visionCycle) return '古いVision cycleのDetectionは使用しません。';
  if (input.transportCycle !== tracker.transportCycle) return '古いTransport cycleのDetectionは使用しません。';
  if (!Number.isFinite(input.frameStampMs)
    || !Number.isFinite(input.cameraFrameStampMs)
    || !Number.isFinite(input.observedAtMs)) return 'Detection frameの時刻を確認できません。';
  if (!Number.isInteger(input.imageWidth) || input.imageWidth <= 0
    || !Number.isInteger(input.imageHeight) || input.imageHeight <= 0) return 'Detection frameの画像サイズを確認できません。';
  if (tracker.phase === 'poststop'
    ? input.frameStampMs <= tracker.notBeforeFrameStampMs
    : input.frameStampMs < tracker.notBeforeFrameStampMs) {
    return tracker.phase === 'poststop'
      ? '停止前のDetection frameは成功確認へ使用しません。'
      : 'mission開始前のDetection frameは使用しません。';
  }
  if (tracker.lastFrameStampMs !== null && input.frameStampMs <= tracker.lastFrameStampMs) {
    return '同一または古いDetection frameは重複して数えません。';
  }
  const ageMs = input.observedAtMs - input.frameStampMs;
  if (ageMs < 0 || ageMs > APPLE_MAX_DETECTION_AGE_MS) return 'staleまたは未来時刻のDetection frameは使用しません。';
  if (Math.abs(input.cameraFrameStampMs - input.frameStampMs) > APPLE_MAX_DETECTION_AGE_MS) {
    return '現在Camera frameと同期していないDetectionは使用しません。';
  }
  return null;
}

export function appleDetectionHasValidDepth(detection: AppleDetectionEvidence | null | undefined): boolean {
  const distance = detection?.distanceMeters;
  return distance !== null
    && distance !== undefined
    && distance >= APPLE_MIN_DISTANCE_METERS
    && distance <= APPLE_MAX_DISTANCE_METERS;
}

/**
 * The selected detection is visible in the current camera frame. This helper
 * adds the explicit range gate used by Object Search; camera centering is not
 * part of the search completion condition.
 */
export function appleDetectionIsWithinSearchRange(detection: AppleDetectionEvidence | null | undefined): boolean {
  if (!appleDetectionHasValidDepth(detection)) return false;
  const distance = detection?.distanceMeters as number;
  return distance <= APPLE_SEARCH_MAX_DISTANCE_METERS;
}

/**
 * Legacy geometric helper retained for callers that need to inspect the bbox.
 * Object Search completion no longer uses camera centering as a gate.
 */
export function appleDetectionIsCentered(detection: AppleDetectionEvidence | null | undefined): boolean {
  if (!detection
    || !Number.isFinite(detection.imageWidth)
    || detection.imageWidth <= 0
    || !Number.isFinite(detection.bbox.centerX)) return false;
  const maximumCenterOffset = detection.imageWidth / 2 * APPLE_GOAL_MAX_HORIZONTAL_OFFSET_RATIO;
  return Math.abs(detection.bbox.centerX - detection.imageWidth / 2) <= maximumCenterOffset;
}

export function appleDetectionIsAtGoal(detection: AppleDetectionEvidence | null | undefined): boolean {
  if (!detection || !appleDetectionIsCentered(detection) || !appleDetectionHasValidDepth(detection)) return false;
  const distance = detection.distanceMeters as number;
  return distance >= APPLE_GOAL_MIN_DISTANCE_METERS
    && distance <= APPLE_GOAL_MAX_DISTANCE_METERS;
}

function observationSummary(
  tracker: AppleDetectionTracker,
  selected: AppleDetectionEvidence | null,
  accepted: boolean,
  rejection?: string,
): AppleDetectionObservation {
  const windowSize = tracker.phase === 'prestop' ? APPLE_PRESTOP_WINDOW_FRAMES : APPLE_POSTSTOP_WINDOW_FRAMES;
  const requiredHits = tracker.phase === 'prestop' ? APPLE_PRESTOP_REQUIRED_HITS : APPLE_POSTSTOP_REQUIRED_HITS;
  const window = tracker.frames.slice(-windowSize);
  const hitCount = window.reduce((count, evidence) => count + Number(evidence.hit), 0);
  const latestHit = window.at(-1)?.hit === true;
  const latestTwoHit = window.length >= 2 && window.at(-2)?.hit === true && latestHit;
  const latestWithinSearchRange = appleDetectionIsWithinSearchRange(window.at(-1)?.selected);
  const candidateConfirmed = tracker.phase === 'prestop'
    && window.length === APPLE_PRESTOP_WINDOW_FRAMES
    && hitCount >= APPLE_PRESTOP_REQUIRED_HITS
    && latestTwoHit;
  const postStopConfirmed = tracker.phase === 'poststop'
    && window.length === APPLE_POSTSTOP_WINDOW_FRAMES
    && hitCount >= APPLE_POSTSTOP_REQUIRED_HITS
    && latestHit
    && latestWithinSearchRange;
  const postStopLost = tracker.phase === 'poststop'
    && tracker.acceptedFrameCount >= APPLE_POSTSTOP_LOST_AFTER_FRAMES
    && !postStopConfirmed;
  return {
    accepted,
    ...(rejection ? { rejection } : {}),
    tracker,
    selected,
    hitCount,
    windowSize,
    requiredHits,
    candidateConfirmed,
    postStopConfirmed,
    postStopLost,
  };
}

export function observeAppleDetectionFrame(
  tracker: AppleDetectionTracker,
  input: AppleDetectionFrameInput,
): AppleDetectionObservation {
  const rejection = rejectionForFrame(tracker, input);
  if (rejection) return observationSummary(tracker, null, false, rejection);
  const selectedBase = selectAppleDetection(input.detections, input.imageWidth, input.imageHeight, tracker.targetClass);
  const selected = selectedBase ? {
    ...selectedBase,
    frameStampMs: input.frameStampMs,
    observedAtMs: input.observedAtMs,
  } : null;
  const evidence: AppleDetectionFrameEvidence = {
    frameStampMs: input.frameStampMs,
    observedAtMs: input.observedAtMs,
    hit: selected !== null,
    selected,
  };
  const next: AppleDetectionTracker = {
    ...tracker,
    frames: [...tracker.frames, evidence].slice(-MAX_TRACKED_FRAMES),
    lastFrameStampMs: input.frameStampMs,
    acceptedFrameCount: tracker.acceptedFrameCount + 1,
  };
  return observationSummary(next, selected, true);
}
