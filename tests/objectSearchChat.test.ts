import { describe, expect, it } from 'vitest';
import {
  cancelObjectSearchChat,
  createObjectSearchChatState,
  resumeObjectSearchChat,
  submitObjectSearchText,
  synchronizeObjectSearchChat,
} from '../src/objectSearchChat';

describe('Object Search chat model', () => {
  it('accepts apple intent without starting runtime or robot movement', () => {
    const result = submitObjectSearchText(createObjectSearchChatState(), 'りんごを探して');
    expect(result.intent).toMatchObject({ type: 'find_object', targetClass: 'apple' });
    expect(result.state.status).toBe('accepted');
    expect(result.state.targetClass).toBe('apple');
    expect(result.state.messages.at(-1)).toMatchObject({
      role: 'robot',
      text: 'りんご探索命令を受け付けました',
    });
  });

  it('does not create a second run for a duplicate apple command', () => {
    const active = submitObjectSearchText(createObjectSearchChatState(), 'りんごを探して').state;
    const duplicate = submitObjectSearchText(active, 'find the apple');
    expect(duplicate.state.status).toBe('accepted');
    expect(duplicate.state.acceptedMissionCount).toBe(1);
    expect(duplicate.state.messages.at(-1)?.text).toBe('すでにりんごを探索中です。');
  });

  it('explains how to switch targets without starting a second active mission', () => {
    const active = submitObjectSearchText(createObjectSearchChatState(), '犬を探して').state;
    const switched = submitObjectSearchText(active, '猫を探して');
    expect(switched.state).toMatchObject({ status: 'accepted', targetClass: 'dog', acceptedMissionCount: 1 });
    expect(switched.state.messages.at(-1)?.text).toBe('犬を探索中です。猫へ切り替える場合は「探索を中止」してから、もう一度依頼してください。');
  });

  it('keeps a paused mission paused when the find command is repeated', () => {
    const active = submitObjectSearchText(createObjectSearchChatState(), 'りんごを探して').state;
    const paused = synchronizeObjectSearchChat(active, 'paused', 'apple');
    const duplicate = submitObjectSearchText(paused, 'find the apple');
    expect(duplicate.state.status).toBe('paused');
    expect(duplicate.state.acceptedMissionCount).toBe(1);
    expect(duplicate.state.messages.at(-1)?.text).toContain('探索を再開');
  });

  it.each(['りんごを探さないで', '鍵を探して', 'りんごを描いて'])('keeps the mission idle for %s', (sourceText) => {
    const result = submitObjectSearchText(createObjectSearchChatState(), sourceText);
    expect(result.state.status).toBe('idle');
    expect(result.state.acceptedMissionCount).toBe(0);
    expect(result.state.messages.at(-1)?.role).toBe('error');
  });

  it('accepts a banana mission and preserves the target in chat state', () => {
    const result = submitObjectSearchText(createObjectSearchChatState(), 'バナナを探して');
    expect(result.intent).toMatchObject({ type: 'find_object', targetClass: 'banana', displayName: 'バナナ' });
    expect(result.state).toMatchObject({ status: 'accepted', targetClass: 'banana', acceptedMissionCount: 1 });
    expect(result.state.messages.at(-1)?.text).toBe('バナナ探索命令を受け付けました');
  });

  it('treats cancel as terminal and resumes only a separately paused mission', () => {
    const active = submitObjectSearchText(createObjectSearchChatState(), 'りんごを探して').state;
    const canceled = cancelObjectSearchChat(active);
    expect(canceled.intent.type).toBe('cancel_object_search');
    expect(canceled.state.status).toBe('idle');
    expect(canceled.state.targetClass).toBeNull();
    expect(resumeObjectSearchChat(canceled.state).state.messages.at(-1)?.role).toBe('error');

    const paused = synchronizeObjectSearchChat(active, 'paused', 'apple');
    const resumed = resumeObjectSearchChat(paused);
    expect(resumed.intent.type).toBe('resume_object_search');
    expect(resumed.state.status).toBe('accepted');
    expect(resumed.state.acceptedMissionCount).toBe(1);
  });

  it('keeps at most 100 literal-text messages in memory', () => {
    let state = createObjectSearchChatState();
    for (let index = 0; index < 70; index += 1) {
      state = submitObjectSearchText(state, `<img src=x onerror=alert(${index})>`).state;
    }
    expect(state.messages).toHaveLength(100);
    expect(state.messages.at(-2)?.text).toBe('<img src=x onerror=alert(69)>');
    expect(state.messages.at(-1)?.role).toBe('error');
  });
});
