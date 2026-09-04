import {
  matchedObjectSearchTargets,
  resolveObjectSearchTargetIdentifier,
  type ObjectSearchTargetClass,
} from './objectSearchTargets';

export const OBJECT_SEARCH_INPUT_MAX_LENGTH = 200;
export const YOLOX_TARGET_REASON = '実YOLOXが識別できるCOCO対象を1つ指定してください。';

export type MissionIntent =
  | {
      type: 'find_object';
      targetClass: ObjectSearchTargetClass;
      displayName: string;
      sourceText: string;
    }
  | { type: 'cancel_object_search'; sourceText: string }
  | { type: 'resume_object_search'; sourceText: string }
  | { type: 'help'; sourceText: string }
  | { type: 'unsupported'; sourceText: string; reason: string };

export type ObjectSearchIntentRoute = 'rule' | 'optional_llm' | 'reject';

export interface RoutedObjectSearchIntent {
  route: ObjectSearchIntentRoute;
  intent: MissionIntent;
}

const END = '[。.!！?？]*';
const CANCEL_PATTERNS = [
  new RegExp(`^探索(?:を)?(?:中止|停止)(?:して|する|してください|して下さい)?${END}$`),
  new RegExp(`^探すのをやめて(?:ください|下さい)?${END}$`),
  /^(?:cancel the search|stop searching)[.!?]*$/,
];
const TARGET_CANCEL_PATTERNS = [
  new RegExp(`^(.+?)探索(?:を)?(?:中止|停止)(?:して|する|してください|して下さい)?${END}$`),
  new RegExp(`^(.+?)を探すのをやめて(?:ください|下さい)?${END}$`),
];
const RESUME_PATTERNS = [
  new RegExp(`^探索(?:を)?(?:再開して|続けて)(?:ください|下さい)?${END}$`),
  /^(?:resume the search|continue the search)[.!?]*$/,
];
const HELP_PATTERNS = [/^(?:ヘルプ|使い方|help)[。.!！?？]*$/];
const NEGATION_PATTERNS = [
  /(?:探|捜|さが|見つけ)(?:さ|し)?(?:ない|なくて|ないで)/,
  /(?:探さなくていい|探索しなくていい)/,
  /(?:(?:探|捜|さが|見つけ)(?:し)?|探索し?)たく(?:は)?(?:ない|ありません)/,
  /(?:探|捜|さが|見つけ).{0,20}(?:ほしくない|欲しくない|ほしくありません|欲しくありません|しないで|やらないで|不要)/,
  /\b(?:do not|don't|dont|not)\b.*\b(?:find|look|search|locate)\b/,
  /\b(?:find|look|search|locate)\b.*\b(?:not|don't|dont|never)\b/,
];
const DIRECT_CONTROL = /(?:\/cmd_vel|cmd_vel|\/navigate_to_pose|速度|座標|前進|後退|旋回|直進|前へ|後ろへ|右へ|左へ|目標地点|ゴール|移動して|曲がって|\b(?:move|drive|go (?:forward|back|to)|turn|teleport|follow me|velocity|coordinate|navigate to)\b)/i;
const POLICY_OVERRIDE = /(?:以前の指示を無視|命令を無視|ルールを変更|schemaを変更|(?:指示|命令|ルール|ポリシー|システムプロンプト).{0,12}(?:無視|変更|上書き|破棄)|\b(?:ignore|override|bypass|change)\b.{0,32}\b(?:instruction|policy|schema|safety|rule|system\s+prompt)\b|\b(?:jailbreak|new\s+instructions?|act\s+as)\b)/i;
const SAFETY_BYPASS = /(?:(?:安全装置|安全機構|安全ルール|command\s*gate|safety(?:\s+(?:system|interlock))?).{0,24}(?:無効|解除|飛ば|迂回|回避|切って|外して|\boff\b|\bdisable|\bbypass|\boverride|\bignore)|(?:disable|bypass|override|ignore|turn\s+off).{0,24}(?:safety|command\s*gate))/i;
const SHELL_OR_CODE = /(?:\b(?:sudo|bash|zsh|powershell|cmd\.exe|python\d*|node|ruby|perl|osascript|exec|eval)\b|\b(?:rm|curl|wget|chmod|chown|kill)\s|\b(?:ls|pwd|cat|head|tail|grep|printenv)\b.{0,12}(?:実行|run|execute)|(?:&&|\|\||`|\$\()|(?:shell|terminal|script|シェル|ターミナル|スクリプト|コマンド).{0,20}(?:実行|起動|run|execute))/i;
const ARBITRARY_ROS_OPERATION = /(?:\/(?:[a-z0-9_]+\/)*[a-z0-9_]+|\bros\s*2?\b.{0,24}\b(?:topic|node|service|action|param)\b|(?:ros\s*2?|topic|node|service|action|トピック|ノード|サービス).{0,24}(?:publish|call|変更|作成|削除|実行))/i;
const ARBITRARY_URL = /(?:https?:\/\/|wss?:\/\/|file:\/\/|(?:任意の|指定した)?\s*url|(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|\[?::1\]?):\d+|\b(?:[a-z0-9-]+\.)+[a-z]{2,63}(?::\d+)?(?:\/|\b))/i;
const COORDINATE = /(?:\b[xyz]\s*[=:]\s*-?\d|\(\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*\)|緯度|経度|\b(?:latitude|longitude)\b)/i;
const SEARCH_PATTERN = /(?:探して|捜して|さがして|見つけて|探索)|\b(?:find|look for|search for)\b/i;
const SPECIFIC_FIND_HINT = /(?:探して|捜して|さがして|見つけて|見つけに|探しに|捜しに|さがしに|どこ|場所)|\b(?:find|look for|search for|locate|where)\b/i;
const OPTIONAL_LLM_CANCEL_HINT = /(?:やめ|終わり|終わろ|中断|取り消|ストップ|\b(?:stop|cancel|quit|end|enough)\b)/i;
const RESUME_HINT = /(?:再開|続けて|\b(?:resume|continue)\b)/i;
const RULE_JAPANESE_FIND = new RegExp(`^(.+?)を(?:探して|捜して|さがして|見つけて)(?:ください|下さい)?${END}$`);
const RULE_ENGLISH_FIND = /^(?:find|look for|search for)\s+(?:(?:a|an|the)\s+)?(.+?)[.!?]*$/i;
const COMPOSITE_FIND_COMMAND = /(?:探して|捜して|さがして|見つけて)(?!(?:ください|下さい)?[。.!！?？]*$).+|\b(?:and|or|then|afterwards)\b/i;
const SAFE_OPTIONAL_FIND_FRAMES = [
  /^(?:この部屋の)?(?:どこかにある)?(.+?)(?:を|、ちょっと)(?:見つけに|探しに|捜しに|さがしに)(?:行って|いって)(?:くれる|くれますか|もらえる|ください|下さい)?[。.!！?？]*$/,
  /^(?:この部屋の)?(.+?)(?:は|が)どこ(?:かな|ですか|にある(?:の|かな|んですか)?)?[。.!！?？]*$/,
  /^(?:この部屋の)?(.+?)の(?:場所|居場所|位置)を(?:確認して|教えて)(?:くれる|くれますか|もらえる|ください|下さい)?[。.!！?？]*$/,
  /^(?:(?:(?:could|can|would) you(?: please)?|please) )?(?:locate|find|look for|search for) (?:(?:a|an|the) )?(.+?)(?: (?:for me|in (?:this|the) room))?[.!?]*$/i,
  /^(?:please )?(?:tell me )?where (?:is|are) (?:(?:a|an|the) )?(.+?)(?: in (?:this|the) room)?[.!?]*$/i,
];
const SAFE_OPTIONAL_CANCEL_FRAMES = [
  /^(?:そろそろ|もう)?(?:探索を|探すのを)?(?:終わりにしよう|やめよう|終了しよう|中断しよう|取り消して|終わりにして)[。.!！?？]*$/,
  /^(?:(?:(?:could|can|would) you(?: please)?|please) )?(?:stop|cancel|end|quit)(?: (?:the )?search| searching| now)?[.!?]*$/i,
  /^(?:that is|that's) enough[.!?]*$/i,
];

type OptionalLlmAdmission =
  | { intent: 'find_object'; targetClass: ObjectSearchTargetClass }
  | { intent: 'cancel_object_search' };

function optionalLlmAdmission(sourceText: string): OptionalLlmAdmission | undefined {
  const explicitTargets = matchedObjectSearchTargets(sourceText);
  for (const pattern of SAFE_OPTIONAL_FIND_FRAMES) {
    const match = pattern.exec(sourceText);
    if (!match) continue;
    const target = resolveObjectSearchTargetIdentifier(match[1]);
    if (target && explicitTargets.length === 1 && explicitTargets[0].classId === target.classId) {
      return { intent: 'find_object', targetClass: target.classId };
    }
  }
  if (explicitTargets.length === 0 && SAFE_OPTIONAL_CANCEL_FRAMES.some((pattern) => pattern.test(sourceText))) {
    return { intent: 'cancel_object_search' };
  }
  return undefined;
}

function isRuleCancel(sourceText: string): boolean {
  if (CANCEL_PATTERNS.some((pattern) => pattern.test(sourceText))) return true;
  return TARGET_CANCEL_PATTERNS.some((pattern) => {
    const match = pattern.exec(sourceText);
    return Boolean(match && resolveObjectSearchTargetIdentifier(match[1]));
  });
}

function containsUnsafeOptionalLlmInput(sourceText: string): boolean {
  return DIRECT_CONTROL.test(sourceText)
    || POLICY_OVERRIDE.test(sourceText)
    || SAFETY_BYPASS.test(sourceText)
    || SHELL_OR_CODE.test(sourceText)
    || ARBITRARY_ROS_OPERATION.test(sourceText)
    || ARBITRARY_URL.test(sourceText)
    || COORDINATE.test(sourceText)
    || RESUME_HINT.test(sourceText);
}

export function normalizeObjectSearchInput(input: string): string {
  return input.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function parseObjectSearchIntent(input: string): MissionIntent {
  const sourceText = normalizeObjectSearchInput(input);
  if (!sourceText) return { type: 'unsupported', sourceText, reason: '入力が空です。' };
  if (sourceText.length > OBJECT_SEARCH_INPUT_MAX_LENGTH) {
    return { type: 'unsupported', sourceText, reason: `入力は${OBJECT_SEARCH_INPUT_MAX_LENGTH}文字以内にしてください。` };
  }
  if (DIRECT_CONTROL.test(sourceText) || POLICY_OVERRIDE.test(sourceText) || SAFETY_BYPASS.test(sourceText) || COORDINATE.test(sourceText)) {
    return { type: 'unsupported', sourceText, reason: '直接制御や安全ルール変更を含む命令は実行しません。' };
  }
  if (SHELL_OR_CODE.test(sourceText) || ARBITRARY_ROS_OPERATION.test(sourceText) || ARBITRARY_URL.test(sourceText)) {
    return { type: 'unsupported', sourceText, reason: 'shell・任意のROS操作・URLを含む命令は実行しません。' };
  }
  if (NEGATION_PATTERNS.some((pattern) => pattern.test(sourceText))) {
    return { type: 'unsupported', sourceText, reason: '否定の探索命令は実行しません。' };
  }
  const targets = matchedObjectSearchTargets(sourceText);
  if (targets.length > 1) {
    return { type: 'unsupported', sourceText, reason: '一度に探索できる対象は1つだけです。' };
  }
  const hasCancelHint = OPTIONAL_LLM_CANCEL_HINT.test(sourceText);
  const matchesRuleCancel = isRuleCancel(sourceText);
  if (SPECIFIC_FIND_HINT.test(sourceText) && (hasCancelHint || matchesRuleCancel)) {
    return { type: 'unsupported', sourceText, reason: '探索開始と中止が同時に含まれる曖昧な命令は実行しません。' };
  }
  if (COMPOSITE_FIND_COMMAND.test(sourceText)) {
    return { type: 'unsupported', sourceText, reason: '探索以外の動作を続けて指定した命令は実行しません。' };
  }
  if (matchesRuleCancel) return { type: 'cancel_object_search', sourceText };
  if (RESUME_PATTERNS.some((pattern) => pattern.test(sourceText))) return { type: 'resume_object_search', sourceText };
  if (HELP_PATTERNS.some((pattern) => pattern.test(sourceText))) return { type: 'help', sourceText };
  const ruleMatch = RULE_JAPANESE_FIND.exec(sourceText) ?? RULE_ENGLISH_FIND.exec(sourceText);
  if (ruleMatch) {
    const target = resolveObjectSearchTargetIdentifier(ruleMatch[1]);
    if (!target) return { type: 'unsupported', sourceText, reason: YOLOX_TARGET_REASON };
    return {
      type: 'find_object',
      targetClass: target.classId,
      displayName: target.displayName,
      sourceText,
    };
  }
  if (SEARCH_PATTERN.test(sourceText) && targets.length === 0) return { type: 'unsupported', sourceText, reason: YOLOX_TARGET_REASON };
  return { type: 'unsupported', sourceText, reason: '対応していない命令です。「バナナを探して」のように入力してください。' };
}

export function routeObjectSearchIntent(input: string): RoutedObjectSearchIntent {
  const intent = parseObjectSearchIntent(input);
  if (intent.type !== 'unsupported') return { route: 'rule', intent };
  const sourceText = intent.sourceText;
  if (!sourceText
    || sourceText.length > OBJECT_SEARCH_INPUT_MAX_LENGTH
    || containsUnsafeOptionalLlmInput(sourceText)
    || NEGATION_PATTERNS.some((pattern) => pattern.test(sourceText))) {
    return { route: 'reject', intent };
  }
  if (RULE_JAPANESE_FIND.test(sourceText) || RULE_ENGLISH_FIND.test(sourceText)) {
    // A full deterministic grammar match that did not produce a mission above
    // is an unsupported target/expression, not an LLM fallback candidate.
    return { route: 'reject', intent };
  }
  return optionalLlmAdmission(sourceText)
    ? { route: 'optional_llm', intent }
    : { route: 'reject', intent };
}
