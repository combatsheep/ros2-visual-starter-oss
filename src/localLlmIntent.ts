import type { MissionIntent } from './objectSearchIntent';
import {
  getObjectSearchTarget,
  isObjectSearchTargetClass,
  type ObjectSearchTargetClass,
} from './objectSearchTargets';

export const LOCAL_LLM_SCHEMA_VERSION = 1;
export const LOCAL_LLM_MODEL_LABEL = 'Optional Local LLM';
export const LOCAL_LLM_REQUEST_TIMEOUT_MS = 25_000;

export type LocalLlmIntentName = 'find_object' | 'cancel_object_search' | 'unsupported';
export type LocalLlmResultStatus = 'accepted' | 'unsupported' | 'error';
export type LocalLlmStatusState = 'disabled' | 'initializing' | 'ready' | 'unavailable' | 'error';

export interface LocalLlmStatusEnvelope {
  schema_version: 1;
  state: LocalLlmStatusState;
  provider: 'local_llm';
  model_label: 'Optional Local LLM';
  model_id: string;
  busy: boolean;
  last_latency_ms: number;
  error: string;
}

export interface LocalLlmResultEnvelope {
  schema_version: 1;
  request_id: number;
  generation: number;
  status: LocalLlmResultStatus;
  intent: LocalLlmIntentName;
  target_class: ObjectSearchTargetClass | 'none';
  display_name: string;
  reason: string;
  provider: 'local_llm';
  model_id: string;
  latency_ms: number;
  resolved_at_ms: number;
}

export interface LocalLlmRequestEnvelope {
  schema_version: 1;
  request_id: number;
  generation: number;
  text: string;
  requested_at_ms: number;
}

export interface PendingLocalLlmRequest {
  requestId: number;
  generation: number;
  text: string;
  requestedAtMs: number;
  transportCycle: number;
  controlLeaseGeneration: number;
}

export interface LocalLlmRequestGuard {
  phase: 'idle' | 'pending' | 'error';
  generation: number;
  nextRequestId: number;
  pending: PendingLocalLlmRequest | null;
  lastRejection: string;
}

export interface LocalLlmRequestContext {
  transportCycle: number;
  controlLeaseGeneration: number;
  controlLeaseOwner: boolean;
}

export interface LocalLlmResultContext extends LocalLlmRequestContext {
  permittedIntents: readonly LocalLlmIntentName[];
}

export interface LocalLlmResolution {
  state: LocalLlmRequestGuard;
  accepted: boolean;
  consumed: boolean;
  result: LocalLlmResultEnvelope | null;
  intent: MissionIntent | null;
  rejection: string;
}

const STATUS_FIELDS = new Set(['schema_version', 'state', 'provider', 'model_label', 'model_id', 'busy', 'last_latency_ms', 'error']);
const RESULT_FIELDS = new Set(['schema_version', 'request_id', 'generation', 'status', 'intent', 'target_class', 'display_name', 'reason', 'provider', 'model_id', 'latency_ms', 'resolved_at_ms']);
const STATUS_STATES = new Set<LocalLlmStatusState>(['disabled', 'initializing', 'ready', 'unavailable', 'error']);
const RESULT_STATUSES = new Set<LocalLlmResultStatus>(['accepted', 'unsupported', 'error']);
const INTENTS = new Set<LocalLlmIntentName>(['find_object', 'cancel_object_search', 'unsupported']);

export class LocalLlmEnvelopeError extends Error {}

function parseObject(serialized: string, label: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { throw new LocalLlmEnvelopeError(`${label} JSONを読み取れません。`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LocalLlmEnvelopeError(`${label}はJSON objectである必要があります。`);
  return value as Record<string, unknown>;
}

function hasExactFields(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function boundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.length <= maximumLength;
}

export function parseLocalLlmStatus(serialized: string): LocalLlmStatusEnvelope {
  const value = parseObject(serialized, 'Local LLM status');
  if (!hasExactFields(value, STATUS_FIELDS)) throw new LocalLlmEnvelopeError('Local LLM status schemaが一致しません。');
  if (value.schema_version !== LOCAL_LLM_SCHEMA_VERSION) throw new LocalLlmEnvelopeError('未対応のLocal LLM status schema_versionです。');
  if (!STATUS_STATES.has(value.state as LocalLlmStatusState)
    || value.provider !== 'local_llm'
    || value.model_label !== LOCAL_LLM_MODEL_LABEL
    || !boundedString(value.model_id, 300)
    || typeof value.busy !== 'boolean'
    || !nonNegativeFinite(value.last_latency_ms)
    || !boundedString(value.error, 240)) {
    throw new LocalLlmEnvelopeError('Local LLM status fieldが不正です。');
  }
  if (value.state === 'ready' && (!value.model_id || value.error)) throw new LocalLlmEnvelopeError('ready statusにmodel_idがないかerrorが残っています。');
  if (value.state === 'disabled' && (value.model_id || value.busy || value.error)) throw new LocalLlmEnvelopeError('disabled statusに実行状態が残っています。');
  return value as unknown as LocalLlmStatusEnvelope;
}

export function parseLocalLlmResult(serialized: string): LocalLlmResultEnvelope {
  const value = parseObject(serialized, 'Local LLM result');
  if (!hasExactFields(value, RESULT_FIELDS)) throw new LocalLlmEnvelopeError('Local LLM result schemaが一致しません。');
  if (value.schema_version !== LOCAL_LLM_SCHEMA_VERSION) throw new LocalLlmEnvelopeError('未対応のLocal LLM result schema_versionです。');
  if (!nonNegativeInteger(value.request_id)
    || !nonNegativeInteger(value.generation)
    || !RESULT_STATUSES.has(value.status as LocalLlmResultStatus)
    || !INTENTS.has(value.intent as LocalLlmIntentName)
    || (!isObjectSearchTargetClass(value.target_class) && value.target_class !== 'none')
    || !boundedString(value.display_name, 100)
    || !boundedString(value.reason, 240)
    || value.provider !== 'local_llm'
    || !boundedString(value.model_id, 300)
    || !nonNegativeFinite(value.latency_ms)
    || !nonNegativeInteger(value.resolved_at_ms)) {
    throw new LocalLlmEnvelopeError('Local LLM result fieldが不正です。');
  }
  if (value.status === 'accepted') {
    if (!value.model_id) throw new LocalLlmEnvelopeError('accepted resultにmodel_idがありません。');
    if (value.intent === 'find_object') {
      if (!isObjectSearchTargetClass(value.target_class)
        || value.display_name !== getObjectSearchTarget(value.target_class).displayName) {
        throw new LocalLlmEnvelopeError('find_object resultの対象がYOLOX registryと一致しません。');
      }
    } else if (value.target_class !== 'none' || value.display_name !== '' || value.intent === 'unsupported') {
      throw new LocalLlmEnvelopeError('accepted resultのintentとtargetが一致しません。');
    }
  } else if (value.intent !== 'unsupported' || value.target_class !== 'none' || value.display_name !== '') {
    throw new LocalLlmEnvelopeError('unsupported/error resultは制御Intentを持てません。');
  }
  return value as unknown as LocalLlmResultEnvelope;
}

export function createLocalLlmRequestGuard(): LocalLlmRequestGuard {
  return { phase: 'idle', generation: 0, nextRequestId: 1, pending: null, lastRejection: '' };
}

export function beginLocalLlmRequest(
  state: LocalLlmRequestGuard,
  text: string,
  requestedAtMs: number,
  context: LocalLlmRequestContext,
): { state: LocalLlmRequestGuard; envelope: LocalLlmRequestEnvelope } {
  const normalized = text.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > 200) throw new LocalLlmEnvelopeError('Local LLM入力は1〜200文字で指定してください。');
  if (!nonNegativeInteger(requestedAtMs)) throw new LocalLlmEnvelopeError('Local LLM requestedAtMsが不正です。');
  if (!context.controlLeaseOwner) throw new LocalLlmEnvelopeError('この端末に操作権がないためLocal LLM requestを送信しません。');
  const generation = state.generation + 1;
  const requestId = state.nextRequestId;
  const pending: PendingLocalLlmRequest = {
    requestId,
    generation,
    text: normalized,
    requestedAtMs,
    transportCycle: context.transportCycle,
    controlLeaseGeneration: context.controlLeaseGeneration,
  };
  return {
    state: { phase: 'pending', generation, nextRequestId: requestId + 1, pending, lastRejection: '' },
    envelope: {
      schema_version: LOCAL_LLM_SCHEMA_VERSION,
      request_id: requestId,
      generation,
      text: normalized,
      requested_at_ms: requestedAtMs,
    },
  };
}

export function invalidateLocalLlmRequest(state: LocalLlmRequestGuard, reason: string): LocalLlmRequestGuard {
  if (!state.pending) return state;
  return {
    ...state,
    phase: reason ? 'error' : 'idle',
    generation: state.generation + 1,
    pending: null,
    lastRejection: reason,
  };
}

function toMissionIntent(result: LocalLlmResultEnvelope, sourceText: string): MissionIntent {
  if (result.status !== 'accepted' || result.intent === 'unsupported') {
    return { type: 'unsupported', sourceText, reason: result.reason || (result.status === 'error' ? 'Local LLM requestに失敗しました。' : '対応していない命令です。') };
  }
  if (result.intent === 'find_object' && result.target_class !== 'none') {
    return {
      type: 'find_object',
      targetClass: result.target_class,
      displayName: result.display_name,
      sourceText,
    };
  }
  if (result.intent === 'cancel_object_search') return { type: 'cancel_object_search', sourceText };
  return { type: 'unsupported', sourceText, reason: result.reason || '対応していない命令です。' };
}

function rejectedResolution(
  state: LocalLlmRequestGuard,
  rejection: string,
  result: LocalLlmResultEnvelope | null,
  consumed = false,
): LocalLlmResolution {
  return {
    state: consumed ? invalidateLocalLlmRequest(state, rejection) : state,
    accepted: false,
    consumed,
    result,
    intent: null,
    rejection,
  };
}

export function resolveLocalLlmResult(
  state: LocalLlmRequestGuard,
  serialized: string,
  context: LocalLlmResultContext,
): LocalLlmResolution {
  let result: LocalLlmResultEnvelope;
  try { result = parseLocalLlmResult(serialized); } catch (error) {
    const rejection = error instanceof Error ? error.message : 'Local LLM resultを読み取れません。';
    return rejectedResolution(state, rejection, null, Boolean(state.pending));
  }
  const pending = state.pending;
  if (state.phase !== 'pending' || !pending) return rejectedResolution(state, 'pendingではないLocal LLM resultを拒否しました。', result);
  if (result.request_id !== pending.requestId) return rejectedResolution(state, 'stale Local LLM request_idを拒否しました。', result);
  if (result.generation !== pending.generation || result.generation !== state.generation) return rejectedResolution(state, 'stale Local LLM generationを拒否しました。', result);
  if (context.transportCycle !== pending.transportCycle) return rejectedResolution(state, 'Transport cycle変更後のLocal LLM resultを拒否しました。', result, true);
  if (!context.controlLeaseOwner || context.controlLeaseGeneration !== pending.controlLeaseGeneration) {
    return rejectedResolution(state, 'Control Lease変更後のLocal LLM resultを拒否しました。', result, true);
  }
  if (result.status === 'accepted' && !context.permittedIntents.includes(result.intent)) {
    return rejectedResolution(state, '現在のApp stateではLocal LLM Intentを実行できません。', result, true);
  }
  const nextState: LocalLlmRequestGuard = { ...state, phase: result.status === 'error' ? 'error' : 'idle', pending: null, lastRejection: result.status === 'error' ? result.reason : '' };
  return {
    state: nextState,
    accepted: result.status === 'accepted',
    consumed: true,
    result,
    intent: toMissionIntent(result, pending.text),
    rejection: result.status === 'accepted' ? '' : result.reason,
  };
}

export function localLlmRequestIsPending(state: LocalLlmRequestGuard): boolean {
  return state.phase === 'pending' && state.pending !== null;
}
