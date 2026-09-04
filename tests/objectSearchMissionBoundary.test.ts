import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appState = readFileSync(new URL('../src/appState.ts', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../src/ui.ts', import.meta.url), 'utf8');

describe('Object Search mission ownership boundary', () => {
  it('routes mission start and resume through the existing exploration transitions', () => {
    const startBoundary = appState.slice(
      appState.indexOf('function startOrAttachObjectSearch'),
      appState.indexOf('function objectSearchPauseReasonForUnavailable'),
    );
    const missionReducer = appState.slice(
      appState.indexOf("case 'OBJECT_SEARCH_COMMAND_REQUESTED'"),
      appState.indexOf("case 'SAFETY_CHANGED'"),
    );
    expect(startBoundary).toContain("type: 'EXPLORATION_START_REQUESTED'");
    expect(startBoundary).toContain("type: 'EXPLORATION_RESUME_REQUESTED'");
    expect(missionReducer).toContain('startOrAttachObjectSearch');
    expect(`${startBoundary}\n${missionReducer}`).not.toMatch(/cmd_vel|publish\s*\(/);
  });

  it('keeps chat handlers free of direct runtime, Nav2, and velocity publishing', () => {
    const chatHandlers = ui.slice(
      ui.indexOf('private bindObjectSearchChat'),
      ui.indexOf('private currentObjectSearchCandidate'),
    );
    expect(chatHandlers).toContain("type: 'OBJECT_SEARCH_COMMAND_REQUESTED'");
    expect(chatHandlers).toContain("type: 'OBJECT_SEARCH_CANCEL_REQUESTED'");
    expect(chatHandlers).toContain("type: 'OBJECT_SEARCH_RESUME_REQUESTED'");
    expect(chatHandlers).toContain("fetch(appPath('api/llm/intent')");
    expect(chatHandlers).not.toMatch(/\.publish\s*\(/);
    expect(chatHandlers).not.toMatch(/cmd_vel|sendNavigationGoal|requestRuntimeMode/);
  });

  it('routes stable candidates through Nav2 approach, exploration pause, and safe-stop effects', () => {
    const approach = appState.slice(
      appState.indexOf('function requestObjectSearchApproach'),
      appState.indexOf('function rejectObjectSearchApproach'),
    );
    const safeStop = appState.slice(
      appState.indexOf('function beginObjectSearchStop'),
      appState.indexOf('function requestObjectSearchSafeStop'),
    );
    expect(approach).toContain("pausedExploration(state, 'object-found-candidate')");
    expect(approach).toContain("source: 'object-search'");
    expect(approach).toContain("type: 'SEND_NAVIGATION_GOAL'");
    expect(approach).toContain('...stoppedEffects()');
    expect(safeStop).toContain("pausedExploration(state, 'object-found-candidate')");
    expect(safeStop).toContain('...stoppedEffects()');
    expect(`${approach}\n${safeStop}`).not.toMatch(/cmd_vel|publish\s*\(/);
  });

  it('observes Detection and final /cmd_vel without taking over runtime or velocity publishing', () => {
    const detectionObserver = ui.slice(
      ui.indexOf('private objectSearchDetectionInputs'),
      ui.indexOf('private renderObjectSearchSummary'),
    );
    const motionObserver = ui.slice(
      ui.indexOf("if (event.topic === '/cmd_vel')"),
      ui.indexOf("if (event.topic === '/backup/_action/status')"),
    );
    expect(detectionObserver).toContain("type: 'OBJECT_SEARCH_DETECTION_OBSERVED'");
    expect(detectionObserver).toContain('sampleDetectionDepth');
    expect(motionObserver).toContain("type: 'ROBOT_MOTION_OBSERVED'");
    expect(`${detectionObserver}\n${motionObserver}`).not.toMatch(/sendNavigationGoal|requestRuntimeMode|\.publish\s*\(/);
  });
});
