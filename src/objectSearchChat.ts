import { normalizeObjectSearchInput, parseObjectSearchIntent, type MissionIntent } from './objectSearchIntent';
import { getObjectSearchTarget, type ObjectSearchTargetClass } from './objectSearchTargets';

export const OBJECT_SEARCH_MESSAGE_LIMIT = 100;

export type ObjectSearchChatRole = 'user' | 'robot' | 'system' | 'error';
export type ObjectSearchChatStatus = 'idle' | 'accepted' | 'paused';

export interface ObjectSearchChatMessage {
  id: number;
  role: ObjectSearchChatRole;
  text: string;
}

export interface ObjectSearchChatState {
  status: ObjectSearchChatStatus;
  targetClass: ObjectSearchTargetClass | null;
  messages: ObjectSearchChatMessage[];
  nextMessageId: number;
  acceptedMissionCount: number;
}

export interface ObjectSearchChatResult {
  state: ObjectSearchChatState;
  intent: MissionIntent;
}

export function createObjectSearchChatState(): ObjectSearchChatState {
  return {
    status: 'idle',
    targetClass: null,
    messages: [{
      id: 1,
      role: 'system',
      text: '自然言語を安全なObject Search Missionへ変換し、既存のFrontier Explorationで探索します。速度命令はCommand GateとSafetyを通ります。',
    }],
    nextMessageId: 2,
    acceptedMissionCount: 0,
  };
}

function appendMessages(
  state: ObjectSearchChatState,
  additions: Array<Omit<ObjectSearchChatMessage, 'id'>>,
  changes: Partial<Omit<ObjectSearchChatState, 'messages' | 'nextMessageId'>> = {},
): ObjectSearchChatState {
  let nextMessageId = state.nextMessageId;
  const appended = additions.map((message) => ({ ...message, id: nextMessageId++ }));
  const messages = [...state.messages, ...appended].slice(-OBJECT_SEARCH_MESSAGE_LIMIT);
  return { ...state, ...changes, messages, nextMessageId };
}

export function synchronizeObjectSearchChat(
  state: ObjectSearchChatState,
  status: ObjectSearchChatStatus,
  targetClass: ObjectSearchTargetClass | null,
  message?: { role: ObjectSearchChatRole; text: string },
): ObjectSearchChatState {
  const changes = { status, targetClass };
  return message ? appendMessages(state, [message], changes) : { ...state, ...changes };
}

export function applyObjectSearchIntent(
  state: ObjectSearchChatState,
  intent: MissionIntent,
  options: { recordUser?: boolean } = {},
): ObjectSearchChatResult {
  const userMessage = options.recordUser === false ? [] : [{ role: 'user' as const, text: intent.sourceText }];
  if (intent.type === 'find_object') {
    if (state.status === 'accepted') {
      const activeDisplayName = state.targetClass ? getObjectSearchTarget(state.targetClass).displayName : '物体';
      const message = state.targetClass === intent.targetClass
        ? `すでに${activeDisplayName}を探索中です。`
        : `${activeDisplayName}を探索中です。${intent.displayName}へ切り替える場合は「探索を中止」してから、もう一度依頼してください。`;
      return {
        intent,
        state: appendMessages(state, [
          ...userMessage,
          { role: 'robot', text: message },
        ]),
      };
    }
    if (state.status === 'paused' && state.targetClass === intent.targetClass) {
      return {
        intent,
        state: appendMessages(state, [
          ...userMessage,
          { role: 'robot', text: `${intent.displayName}探索は一時停止中です。「探索を再開」と入力してください。` },
        ]),
      };
    }
    return {
      intent,
      state: appendMessages(state, [
        ...userMessage,
        { role: 'robot', text: `${intent.displayName}探索命令を受け付けました` },
      ], {
        status: 'accepted',
        targetClass: intent.targetClass,
        acceptedMissionCount: state.acceptedMissionCount + 1,
      }),
    };
  }
  if (intent.type === 'cancel_object_search') {
    const active = state.status === 'accepted' || state.status === 'paused';
    const activeDisplayName = state.targetClass ? getObjectSearchTarget(state.targetClass).displayName : '物体';
    return {
      intent,
      state: appendMessages(state, [
        ...userMessage,
        active
          ? { role: 'robot', text: `${activeDisplayName}探索を中止しました。Robotは停止状態です。` }
          : { role: 'error', text: '実行中の物体探索はありません。' },
      ], active ? { status: 'idle', targetClass: null } : {}),
    };
  }
  if (intent.type === 'resume_object_search') {
    const paused = state.status === 'paused' && state.targetClass !== null;
    const activeDisplayName = state.targetClass ? getObjectSearchTarget(state.targetClass).displayName : '物体';
    return {
      intent,
      state: appendMessages(state, [
        ...userMessage,
        paused
          ? { role: 'robot', text: `${activeDisplayName}探索の再開命令を受け付けました。fresh map・pose・Visionを確認して再開します。` }
          : { role: 'error', text: '再開できる一時停止中の物体探索はありません。' },
      ], paused ? { status: 'accepted' } : {}),
    };
  }
  if (intent.type === 'help') {
    return {
      intent,
      state: appendMessages(state, [
        ...userMessage,
        { role: 'robot', text: '「バナナを探して」「犬を探して」のように、YOLOX COCO対象を1つ指定できます。中止と再開にも対応しています。' },
      ]),
    };
  }
  return {
    intent,
    state: appendMessages(state, [
      ...userMessage,
      { role: 'error', text: intent.reason },
    ]),
  };
}

export function submitObjectSearchText(state: ObjectSearchChatState, input: string): ObjectSearchChatResult {
  const intent = parseObjectSearchIntent(input);
  if (!normalizeObjectSearchInput(input)) return { state, intent };
  return applyObjectSearchIntent(state, intent);
}

export function cancelObjectSearchChat(state: ObjectSearchChatState): ObjectSearchChatResult {
  return applyObjectSearchIntent(state, parseObjectSearchIntent('探索を中止'));
}

export function resumeObjectSearchChat(state: ObjectSearchChatState): ObjectSearchChatResult {
  return applyObjectSearchIntent(state, parseObjectSearchIntent('探索を再開して'));
}
