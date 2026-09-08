import { describe, expect, it, vi } from 'vitest';
import { LearningUI } from '../src/ui';
import type { PlaygroundObject } from '../src/playground';

function createHeightDrag(snapEnabled: boolean) {
  const object: PlaygroundObject = {
    id: 'box', kind: 'box', label: 'Box', color: '#ffffff',
    position: { x: 0, z: 0 }, rotation: 0,
    size: { width: 1, height: 1, depth: 1 },
  };
  const ui = Object.create(LearningUI.prototype) as {
    beginGesture(object: PlaygroundObject, kind: string, corner: number, ground: undefined, clientY: number): void;
    onStagePointerMove(event: PointerEvent): void;
    gesture: { lastHeight: number };
  } & Record<string, unknown>;
  Object.defineProperty(ui, 'activeView', { value: 'stage' });
  Object.assign(ui, {
    snapEnabled,
    playground: { version: 1, name: 'Test', stageSize: 10, objects: [object] },
    canvas: { setPointerCapture: vi.fn(), classList: { add: vi.fn() } },
    dispatchAppEvent: vi.fn(), syncInspectorLive: vi.fn(), updateHandles: vi.fn(),
    simulation: {
      groundPointAt: () => ({ x: 0, z: 0 }),
      screenDeltaToHeightDelta: (dy: number) => -dy * .01,
      updateStageObjectTransform: vi.fn(),
    },
  });
  ui.beginGesture(object, 'resizeHeight', 4, undefined, 100);
  return {
    move(y: number) {
      ui.onStagePointerMove({ clientX: 0, clientY: y } as PointerEvent);
      return ui.gesture.lastHeight;
    },
  };
}

describe('stage height handle drag', () => {
  it.each([false, true])('depends on displacement, not pointer event count (snap=%s)', (snap) => {
    const drag = createHeightDrag(snap);
    for (let y = 99; y >= 90; y--) drag.move(y);
    expect(drag.move(90)).toBeCloseTo(1.1);
    expect(drag.move(90)).toBe(createHeightDrag(snap).move(90));
    expect(drag.move(100)).toBe(1);
    expect(drag.move(110)).toBeCloseTo(.9);
  });

  it('returns to the original height after reaching either size limit', () => {
    const drag = createHeightDrag(false);
    expect(drag.move(-400)).toBe(3);
    expect(drag.move(100)).toBe(1);
    expect(drag.move(500)).toBe(.1);
    expect(drag.move(100)).toBe(1);
  });
});
