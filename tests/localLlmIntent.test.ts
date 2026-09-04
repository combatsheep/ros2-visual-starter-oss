import { describe, expect, it } from 'vitest';
import {
  beginLocalLlmRequest,
  createLocalLlmRequestGuard,
  invalidateLocalLlmRequest,
  localLlmRequestIsPending,
  parseLocalLlmResult,
  parseLocalLlmStatus,
  resolveLocalLlmResult,
  type LocalLlmResultContext,
} from '../src/localLlmIntent';

const status = (changes: Record<string, unknown> = {}): string => JSON.stringify({
  schema_version: 1,
  state: 'ready',
  provider: 'local_llm',
  model_label: 'Optional Local LLM',
  model_id: 'mock-model',
  busy: false,
  last_latency_ms: 12.5,
  error: '',
  ...changes,
});

const result = (changes: Record<string, unknown> = {}): string => JSON.stringify({
  schema_version: 1,
  request_id: 1,
  generation: 1,
  status: 'accepted',
  intent: 'find_object',
  target_class: 'apple',
  display_name: 'りんご',
  reason: '',
  provider: 'local_llm',
  model_id: 'mock-model',
  latency_ms: 12.5,
  resolved_at_ms: 200,
  ...changes,
});

const context = (changes: Partial<LocalLlmResultContext> = {}): LocalLlmResultContext => ({
  transportCycle: 3,
  controlLeaseGeneration: 4,
  controlLeaseOwner: true,
  permittedIntents: ['find_object', 'unsupported'],
  ...changes,
});

function pending() {
  return beginLocalLlmRequest(createLocalLlmRequestGuard(), 'この部屋のりんごを見つけて', 100, {
    transportCycle: 3,
    controlLeaseGeneration: 4,
    controlLeaseOwner: true,
  }).state;
}

describe('Local LLM HTTP envelope', () => {
  it('accepts the strict status and result schemas', () => {
    expect(parseLocalLlmStatus(status())).toMatchObject({ state: 'ready', model_label: 'Optional Local LLM' });
    expect(parseLocalLlmStatus(status({ state: 'disabled', model_id: '', last_latency_ms: 0 }))).toMatchObject({ state: 'disabled' });
    expect(parseLocalLlmResult(result())).toMatchObject({ intent: 'find_object', target_class: 'apple' });
    expect(parseLocalLlmResult(result({ target_class: 'banana', display_name: 'バナナ' }))).toMatchObject({
      intent: 'find_object',
      target_class: 'banana',
      display_name: 'バナナ',
    });
  });

  it.each([
    status({ schema_version: 2 }),
    status({ provider: 'cloud' }),
    status({ extra: true }),
    status({ model_id: '' }),
  ])('rejects malformed or unknown status fields', (payload) => {
    expect(() => parseLocalLlmStatus(payload)).toThrow();
  });

  it.each([
    result({ schema_version: 2 }),
    result({ request_id: -1 }),
    result({ target_class: 'robot' }),
    result({ intent: 'find_object', target_class: 'none', display_name: '' }),
    result({ status: 'unsupported', intent: 'find_object' }),
    result({ extra: true }),
  ])('rejects malformed or control-bearing error results', (payload) => {
    expect(() => parseLocalLlmResult(payload)).toThrow();
  });
});

describe('Local LLM stale request guard', () => {
  it('creates one bounded request and converts only accepted apple intent', () => {
    const started = beginLocalLlmRequest(createLocalLlmRequestGuard(), 'この部屋のりんごを見つけて', 100, {
      transportCycle: 3,
      controlLeaseGeneration: 4,
      controlLeaseOwner: true,
    });
    expect(started.envelope).toEqual({
      schema_version: 1,
      request_id: 1,
      generation: 1,
      text: 'この部屋のりんごを見つけて',
      requested_at_ms: 100,
    });
    const resolved = resolveLocalLlmResult(started.state, result(), context());
    expect(resolved.accepted).toBe(true);
    expect(resolved.intent).toEqual({
      type: 'find_object',
      targetClass: 'apple',
      displayName: 'りんご',
      sourceText: 'この部屋のりんごを見つけて',
    });
    expect(localLlmRequestIsPending(resolved.state)).toBe(false);
  });

  it('converts an accepted banana result without rewriting it to apple', () => {
    const started = beginLocalLlmRequest(createLocalLlmRequestGuard(), 'バナナを探して', 100, {
      transportCycle: 3,
      controlLeaseGeneration: 4,
      controlLeaseOwner: true,
    });
    const resolved = resolveLocalLlmResult(
      started.state,
      result({ target_class: 'banana', display_name: 'バナナ' }),
      context(),
    );
    expect(resolved.intent).toEqual({
      type: 'find_object',
      targetClass: 'banana',
      displayName: 'バナナ',
      sourceText: 'バナナを探して',
    });
  });

  it('converts only a permitted high-level cancel without any control payload', () => {
    const started = beginLocalLlmRequest(createLocalLlmRequestGuard(), 'そろそろ終わりにしよう', 100, {
      transportCycle: 3,
      controlLeaseGeneration: 4,
      controlLeaseOwner: true,
    });
    const resolved = resolveLocalLlmResult(started.state, result({
      intent: 'cancel_object_search',
      target_class: 'none',
      display_name: '',
    }), context({ permittedIntents: ['cancel_object_search', 'unsupported'] }));
    expect(resolved.accepted).toBe(true);
    expect(resolved.intent).toEqual({
      type: 'cancel_object_search',
      sourceText: 'そろそろ終わりにしよう',
    });
  });

  it('rejects stale request id without consuming the current request', () => {
    const resolved = resolveLocalLlmResult(pending(), result({ request_id: 99 }), context());
    expect(resolved.accepted).toBe(false);
    expect(resolved.consumed).toBe(false);
    expect(localLlmRequestIsPending(resolved.state)).toBe(true);
  });

  it('rejects stale generation without consuming the current request', () => {
    const resolved = resolveLocalLlmResult(pending(), result({ generation: 99 }), context());
    expect(resolved.accepted).toBe(false);
    expect(resolved.consumed).toBe(false);
  });

  it('invalidates after Transport cycle change', () => {
    const resolved = resolveLocalLlmResult(pending(), result(), context({ transportCycle: 5 }));
    expect(resolved.accepted).toBe(false);
    expect(resolved.consumed).toBe(true);
    expect(localLlmRequestIsPending(resolved.state)).toBe(false);
  });

  it('invalidates after Control Lease loss or generation change', () => {
    for (const changed of [
      context({ controlLeaseOwner: false }),
      context({ controlLeaseGeneration: 5 }),
    ]) {
      const resolved = resolveLocalLlmResult(pending(), result(), changed);
      expect(resolved.accepted).toBe(false);
      expect(localLlmRequestIsPending(resolved.state)).toBe(false);
    }
  });

  it('does not start a mission for backend error or unsupported result', () => {
    for (const payload of [
      result({ status: 'error', intent: 'unsupported', target_class: 'none', display_name: '', reason: 'timeout' }),
      result({ status: 'unsupported', intent: 'unsupported', target_class: 'none', display_name: '', reason: '未対応' }),
    ]) {
      const resolved = resolveLocalLlmResult(pending(), payload, context());
      expect(resolved.accepted).toBe(false);
      expect(resolved.intent?.type).toBe('unsupported');
    }
  });

  it('accepts a fresh dog request after an unsupported target without poisoning the guard', () => {
    const first = beginLocalLlmRequest(createLocalLlmRequestGuard(), 'キュウリを探して', 100, {
      transportCycle: 3,
      controlLeaseGeneration: 4,
      controlLeaseOwner: true,
    });
    const unsupported = resolveLocalLlmResult(first.state, result({
      status: 'unsupported',
      intent: 'unsupported',
      target_class: 'none',
      display_name: '',
      reason: '現在のYOLOXでは識別できない対象です。',
    }), context());
    expect(unsupported.state).toMatchObject({ phase: 'idle', pending: null });

    const second = beginLocalLlmRequest(unsupported.state, '犬を探して', 200, {
      transportCycle: 3,
      controlLeaseGeneration: 4,
      controlLeaseOwner: true,
    });
    const acceptedDog = resolveLocalLlmResult(second.state, result({
      request_id: 2,
      generation: 2,
      target_class: 'dog',
      display_name: '犬',
    }), context());
    expect(acceptedDog.accepted).toBe(true);
    expect(acceptedDog.intent).toMatchObject({ type: 'find_object', targetClass: 'dog', displayName: '犬' });
    expect(acceptedDog.state).toMatchObject({ phase: 'idle', pending: null });
  });

  it('rejects an accepted intent that current App state does not permit', () => {
    const resolved = resolveLocalLlmResult(pending(), result(), context({ permittedIntents: ['unsupported'] }));
    expect(resolved.accepted).toBe(false);
    expect(resolved.intent).toBeNull();
  });

  it('rejects late accepted result after cancel invalidation', () => {
    const canceled = invalidateLocalLlmRequest(pending(), 'ユーザーcancel');
    const resolved = resolveLocalLlmResult(canceled, result(), context());
    expect(resolved.accepted).toBe(false);
    expect(resolved.intent).toBeNull();
  });

  it('refuses a request from a non-owner before publishing', () => {
    expect(() => beginLocalLlmRequest(createLocalLlmRequestGuard(), 'りんごを探して', 1, {
      transportCycle: 1,
      controlLeaseGeneration: 1,
      controlLeaseOwner: false,
    })).toThrow('操作権');
  });
});
