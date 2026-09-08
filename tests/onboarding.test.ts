import { describe, expect, it } from 'vitest';
import { readTipProgress, selectTip, type TipContext } from '../src/onboarding';
const context: TipContext = { blocked: false, sim: true, explorationReady: false, manual: true, idle: true };
describe('progressive onboarding', () => {
  it('recovers from malformed and old storage', () => {
    for (const raw of [null, '{', 'null', '{"explorationStarts":-1,"dismissed":42}']) {
      expect(readTipProgress(raw)).toEqual({ explorationStarts: 0, dismissed: [] });
    }
    expect(readTipProgress('{"explorationStarts":3,"dismissed":["ros","unknown"]}')).toEqual({ explorationStarts: 3, dismissed: ['ros'] });
  });
  it('waits for readiness and hides during blocking operations', () => {
    const progress = readTipProgress(null);
    expect(selectTip(progress, new Set(), context)).toBe('ros');
    expect(selectTip(progress, new Set(), { ...context, sim: false })).toBeNull();
    expect(selectTip(progress, new Set(), { ...context, sim: false, explorationReady: true })).toBe('exploration');
    expect(selectTip(progress, new Set(), { ...context, blocked: true })).toBeNull();
  });
  it('distinguishes OK for this session from permanent suppression', () => {
    expect(selectTip(readTipProgress(null), new Set(['ros']), context)).toBeNull();
    expect(selectTip(readTipProgress(null), new Set(), context)).toBe('ros');
    expect(selectTip(readTipProgress('{"dismissed":["ros"]}'), new Set(), context)).toBeNull();
  });
  it('unlocks sequential feature tips after three accepted starts, when idle', () => {
    const closed = new Set<'ros' | 'exploration' | 'keyboard'>(['ros', 'exploration']);
    expect(selectTip({ explorationStarts: 2, dismissed: [] }, closed, context)).toBeNull();
    const progress = { explorationStarts: 3, dismissed: [] };
    expect(selectTip(progress, closed, context)).toBe('keyboard');
    expect(selectTip(progress, closed, { ...context, idle: false })).toBeNull();
    closed.add('keyboard');
    expect(selectTip(progress, closed, context)).toBe('camera');
  });
});
