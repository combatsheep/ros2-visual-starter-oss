import { describe, expect, it } from 'vitest';
import {
  APPLE_POSTSTOP_LOST_AFTER_FRAMES,
  APPLE_POSTSTOP_REQUIRED_HITS,
  APPLE_POSTSTOP_WINDOW_FRAMES,
  APPLE_PRESTOP_REQUIRED_HITS,
  APPLE_PRESTOP_WINDOW_FRAMES,
  appleDetectionIsWithinSearchRange,
  createAppleDetectionTracker,
  observeAppleDetectionFrame,
  resetAppleDetectionTrackerForPostStop,
  selectAppleDetection,
  type AppleDetectionFrameInput,
  type AppleDetectionInput,
  type AppleDetectionTracker,
} from '../src/objectSearchDetection';

const CYCLE = { missionGeneration: 7, visionCycle: 3, transportCycle: 4 } as const;
const MISSION_STARTED_AT_MS = 1_000;

function apple(overrides: Partial<AppleDetectionInput> = {}): AppleDetectionInput {
  return {
    classId: 'apple',
    confidence: .8,
    bbox: { centerX: 160, centerY: 120, width: 64, height: 48 },
    distanceMeters: 1.2,
    index: 0,
    ...overrides,
  };
}

function frame(
  frameStampMs: number,
  detections: readonly AppleDetectionInput[],
  overrides: Partial<AppleDetectionFrameInput> = {},
): AppleDetectionFrameInput {
  return {
    ...CYCLE,
    frameStampMs,
    cameraFrameStampMs: frameStampMs,
    observedAtMs: frameStampMs + 20,
    imageWidth: 320,
    imageHeight: 240,
    detections,
    ...overrides,
  };
}

function prestopTracker(): AppleDetectionTracker {
  return createAppleDetectionTracker({
    phase: 'prestop',
    ...CYCLE,
    notBeforeFrameStampMs: MISSION_STARTED_AT_MS,
  });
}

function observeSequence(
  tracker: AppleDetectionTracker,
  sequence: readonly (readonly AppleDetectionInput[])[],
  startAtMs = MISSION_STARTED_AT_MS + 100,
): ReturnType<typeof observeAppleDetectionFrame> {
  let result = observeAppleDetectionFrame(tracker, frame(startAtMs, sequence[0] ?? []));
  for (let index = 1; index < sequence.length; index += 1) {
    result = observeAppleDetectionFrame(result.tracker, frame(startAtMs + index * 100, sequence[index]));
  }
  return result;
}

describe('bounded apple detection tracker', () => {
  it('does not confirm one-frame noise and requires 3/5 hits with the latest two consecutive', () => {
    const noise = observeSequence(prestopTracker(), [[apple()], [], [], [], []]);
    expect(noise.tracker.frames).toHaveLength(APPLE_PRESTOP_WINDOW_FRAMES);
    expect(noise.hitCount).toBe(1);
    expect(noise.candidateConfirmed).toBe(false);

    const interruptedTail = observeSequence(prestopTracker(), [[apple()], [apple()], [], [apple()], []]);
    expect(interruptedTail.hitCount).toBe(3);
    expect(interruptedTail.candidateConfirmed).toBe(false);

    const stable = observeSequence(prestopTracker(), [[apple()], [], [apple()], [apple()], [apple()]]);
    expect(stable.windowSize).toBe(APPLE_PRESTOP_WINDOW_FRAMES);
    expect(stable.requiredHits).toBe(APPLE_PRESTOP_REQUIRED_HITS);
    expect(stable.hitCount).toBe(4);
    expect(stable.candidateConfirmed).toBe(true);
    expect(stable.selected?.distanceMeters).toBe(1.2);
  });

  it('uses confidence, bbox area, center distance, then source index as deterministic ties', () => {
    const selected = selectAppleDetection([
      apple({ confidence: .7, bbox: { centerX: 160, centerY: 120, width: 100, height: 80 }, index: 0 }),
      apple({ confidence: .9, bbox: { centerX: 160, centerY: 120, width: 40, height: 40 }, index: 8 }),
      apple({ confidence: .9, bbox: { centerX: 160, centerY: 120, width: 60, height: 40 }, index: 7 }),
      apple({ confidence: .9, bbox: { centerX: 250, centerY: 120, width: 60, height: 40 }, index: 6 }),
      apple({ confidence: .9, bbox: { centerX: 160, centerY: 120, width: 60, height: 40 }, index: 3 }),
    ], 320, 240);

    expect(selected?.index).toBe(3);
  });

  it('rejects wrong class, low confidence, invalid bbox ratios and centers without rejecting the fresh frame', () => {
    const invalidDetections = [
      apple({ classId: 'orange' }),
      apple({ confidence: .399 }),
      apple({ bbox: { centerX: 160, centerY: 120, width: 8, height: 8 } }),
      apple({ bbox: { centerX: 160, centerY: 120, width: 310, height: 220 } }),
      apple({ bbox: { centerX: -1, centerY: 120, width: 64, height: 48 } }),
    ];
    const result = observeAppleDetectionFrame(prestopTracker(), frame(1_100, invalidDetections));

    expect(result.accepted).toBe(true);
    expect(result.selected).toBeNull();
    expect(result.hitCount).toBe(0);
  });

  it('tracks the mission target class instead of accepting apple unconditionally', () => {
    const tracker = createAppleDetectionTracker({
      phase: 'prestop',
      targetClass: 'banana',
      ...CYCLE,
      notBeforeFrameStampMs: MISSION_STARTED_AT_MS,
    });
    const result = observeAppleDetectionFrame(tracker, frame(1_100, [
      apple({ classId: 'apple', index: 0 }),
      apple({ classId: 'banana', index: 1 }),
    ]));
    expect(result.accepted).toBe(true);
    expect(result.tracker.targetClass).toBe('banana');
    expect(result.selected?.classId).toBe('banana');
    expect(result.selected?.index).toBe(1);
  });

  it('rejects mission-before, stale, duplicate, future, and old mission/Vision/Transport cycle frames', () => {
    const cases: AppleDetectionFrameInput[] = [
      frame(999, [apple()], { observedAtMs: 1_000 }),
      frame(1_100, [apple()], { observedAtMs: 1_601 }),
      frame(1_100, [apple()], { observedAtMs: 1_099 }),
      frame(1_100, [apple()], { missionGeneration: CYCLE.missionGeneration - 1 }),
      frame(1_100, [apple()], { visionCycle: CYCLE.visionCycle - 1 }),
      frame(1_100, [apple()], { transportCycle: CYCLE.transportCycle - 1 }),
    ];
    for (const input of cases) {
      const result = observeAppleDetectionFrame(prestopTracker(), input);
      expect(result.accepted).toBe(false);
      expect(result.tracker.frames).toHaveLength(0);
    }

    const first = observeAppleDetectionFrame(prestopTracker(), frame(1_100, [apple()]));
    const duplicate = observeAppleDetectionFrame(first.tracker, frame(1_100, [apple()]));
    expect(duplicate.accepted).toBe(false);
    expect(duplicate.tracker.frames).toHaveLength(1);
  });

  it('keeps only the bounded ring window', () => {
    const result = observeSequence(prestopTracker(), Array.from({ length: 12 }, () => []));
    expect(result.tracker.frames).toHaveLength(APPLE_PRESTOP_WINDOW_FRAMES);
    expect(result.tracker.acceptedFrameCount).toBe(12);
  });

  it('requires a visible apple to have valid optical-Z distance within 5 m after stopping', () => {
    const candidate = observeSequence(prestopTracker(), [
      [apple({ distanceMeters: null })],
      [],
      [apple({ distanceMeters: null })],
      [apple({ distanceMeters: null })],
      [apple({ distanceMeters: null })],
    ]);
    expect(candidate.candidateConfirmed).toBe(true);

    const stoppedAtMs = 2_000;
    let tracker = resetAppleDetectionTrackerForPostStop(candidate.tracker, stoppedAtMs);
    const oldFrame = observeAppleDetectionFrame(tracker, frame(stoppedAtMs, [apple()]));
    expect(oldFrame.accepted).toBe(false);

    tracker = oldFrame.tracker;
    const noDepth = observeSequence(tracker, [
      [apple({ bbox: { centerX: 60, centerY: 120, width: 64, height: 48 }, distanceMeters: null })],
      [],
      [apple({ bbox: { centerX: 60, centerY: 120, width: 64, height: 48 }, distanceMeters: null })],
    ], stoppedAtMs + 100);
    expect(noDepth.windowSize).toBe(APPLE_POSTSTOP_WINDOW_FRAMES);
    expect(noDepth.requiredHits).toBe(APPLE_POSTSTOP_REQUIRED_HITS);
    expect(noDepth.postStopConfirmed).toBe(false);
    expect(appleDetectionIsWithinSearchRange(noDepth.selected)).toBe(false);

    tracker = resetAppleDetectionTrackerForPostStop(candidate.tracker, stoppedAtMs);
    const withinRange = observeSequence(tracker, [
      [apple({ bbox: { centerX: 60, centerY: 120, width: 64, height: 48 }, distanceMeters: 4.99 })],
      [],
      [apple({ bbox: { centerX: 60, centerY: 120, width: 64, height: 48 }, distanceMeters: 4.99 })],
    ], stoppedAtMs + 100);
    expect(withinRange.hitCount).toBe(2);
    expect(withinRange.postStopConfirmed).toBe(true);
    expect(appleDetectionIsWithinSearchRange(withinRange.selected)).toBe(true);

    tracker = resetAppleDetectionTrackerForPostStop(candidate.tracker, stoppedAtMs);
    const tooFar = observeSequence(tracker, [
      [apple({ bbox: { centerX: 60, centerY: 120, width: 64, height: 48 }, distanceMeters: 5.01 })],
      [],
      [apple({ bbox: { centerX: 60, centerY: 120, width: 64, height: 48 }, distanceMeters: 5.01 })],
    ], stoppedAtMs + 100);
    expect(tooFar.postStopConfirmed).toBe(false);
    expect(appleDetectionIsWithinSearchRange(tooFar.selected)).toBe(false);
  });

  it('reports a lost post-stop target only after five accepted fresh frames without success', () => {
    const tracker = resetAppleDetectionTrackerForPostStop(prestopTracker(), 2_000);
    const fourFrames = observeSequence(tracker, [[apple({ distanceMeters: null })], [], [], []], 2_100);
    expect(fourFrames.postStopLost).toBe(false);

    const fiveFrames = observeAppleDetectionFrame(fourFrames.tracker, frame(2_500, []));
    expect(fiveFrames.tracker.acceptedFrameCount).toBe(APPLE_POSTSTOP_LOST_AFTER_FRAMES);
    expect(fiveFrames.postStopConfirmed).toBe(false);
    expect(fiveFrames.postStopLost).toBe(true);
  });
});
