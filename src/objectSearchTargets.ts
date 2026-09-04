/*
 * SPDX-License-Identifier: Apache-2.0
 * Copyright (c) Megvii, Inc. and its affiliates.
 * Modifications Copyright (c) 2026 ROS2 Visual Starter contributors.
 *
 * COCO_OBJECT_SEARCH_CLASSES preserves the class names and order from YOLOX
 * 0.3.0, yolox/data/datasets/coco_classes.py, at commit
 * 419778480ab6ec0590e5d3831b3afb3b46ab2aa3.
 * Japanese display names and aliases, TypeScript types, normalization, and
 * matching are project modifications.
 * See docs/DEPENDENCY_LICENSE_AUDIT.md and LICENSES/Apache-2.0.txt.
 */

export const COCO_OBJECT_SEARCH_CLASSES = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
  'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog',
  'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella',
  'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball', 'kite',
  'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket', 'bottle',
  'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich',
  'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch',
  'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote',
  'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'book',
  'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush',
] as const;

export type ObjectSearchTargetClass = (typeof COCO_OBJECT_SEARCH_CLASSES)[number];

export interface ObjectSearchTargetDefinition {
  classId: ObjectSearchTargetClass;
  displayName: string;
  aliases: readonly string[];
}

const entry = (
  classId: ObjectSearchTargetClass,
  displayName: string,
  aliases: readonly string[] = [],
): ObjectSearchTargetDefinition => ({ classId, displayName, aliases });

export const OBJECT_SEARCH_TARGETS: readonly ObjectSearchTargetDefinition[] = [
  entry('person', '人', ['人物', 'ひと']), entry('bicycle', '自転車', ['じてんしゃ']),
  entry('car', '車', ['自動車', 'くるま']), entry('motorcycle', 'バイク', ['オートバイ', '二輪車']),
  entry('airplane', '飛行機', ['航空機']), entry('bus', 'バス'), entry('train', '電車', ['列車']),
  entry('truck', 'トラック'), entry('boat', 'ボート', ['船']), entry('traffic light', '信号機', ['信号']),
  entry('fire hydrant', '消火栓'), entry('stop sign', '一時停止標識', ['停止標識']),
  entry('parking meter', 'パーキングメーター'), entry('bench', 'ベンチ'), entry('bird', '鳥', ['とり']),
  entry('cat', '猫', ['ねこ']), entry('dog', '犬', ['いぬ']), entry('horse', '馬', ['うま']),
  entry('sheep', '羊', ['ひつじ']), entry('cow', '牛', ['うし']), entry('elephant', '象', ['ゾウ']),
  entry('bear', '熊', ['クマ']), entry('zebra', 'シマウマ'), entry('giraffe', 'キリン'),
  entry('backpack', 'リュック', ['バックパック']), entry('umbrella', '傘', ['かさ']),
  entry('handbag', 'ハンドバッグ', ['かばん', 'バッグ']), entry('tie', 'ネクタイ'),
  entry('suitcase', 'スーツケース', ['旅行かばん']), entry('frisbee', 'フリスビー'),
  entry('skis', 'スキー'), entry('snowboard', 'スノーボード'), entry('sports ball', 'ボール', ['スポーツボール']),
  entry('kite', '凧', ['たこ']), entry('baseball bat', 'バット', ['野球バット']),
  entry('baseball glove', 'グローブ', ['野球グローブ']), entry('skateboard', 'スケートボード'),
  entry('surfboard', 'サーフボード'), entry('tennis racket', 'テニスラケット', ['ラケット']),
  entry('bottle', 'ボトル', ['瓶', 'びん']), entry('wine glass', 'ワイングラス'),
  entry('cup', 'カップ', ['コップ']), entry('fork', 'フォーク'), entry('knife', 'ナイフ', ['包丁']),
  entry('spoon', 'スプーン'), entry('bowl', 'ボウル', ['器']), entry('banana', 'バナナ'),
  entry('apple', 'りんご', ['リンゴ', '林檎']), entry('sandwich', 'サンドイッチ'),
  entry('orange', 'オレンジ', ['みかん']), entry('broccoli', 'ブロッコリー'),
  entry('carrot', 'にんじん', ['人参']), entry('hot dog', 'ホットドッグ'), entry('pizza', 'ピザ'),
  entry('donut', 'ドーナツ', ['ドーナッツ']), entry('cake', 'ケーキ'), entry('chair', '椅子', ['いす', 'イス']),
  entry('couch', 'ソファ', ['ソファー']), entry('potted plant', '観葉植物', ['鉢植え']),
  entry('bed', 'ベッド'), entry('dining table', 'テーブル', ['食卓']), entry('toilet', 'トイレ', ['便器']),
  entry('tv', 'テレビ', ['テレビジョン']), entry('laptop', 'ノートパソコン', ['ラップトップ']),
  entry('mouse', 'マウス'), entry('remote', 'リモコン', ['リモートコントローラー']),
  entry('keyboard', 'キーボード'), entry('cell phone', '携帯電話', ['スマホ', 'スマートフォン']),
  entry('microwave', '電子レンジ', ['レンジ']), entry('oven', 'オーブン'), entry('toaster', 'トースター'),
  entry('sink', 'シンク', ['流し台']), entry('refrigerator', '冷蔵庫', ['冷蔵器']),
  entry('book', '本', ['書籍']), entry('clock', '時計'), entry('vase', '花瓶'),
  entry('scissors', 'はさみ', ['ハサミ']), entry('teddy bear', 'テディベア', ['ぬいぐるみ']),
  entry('hair drier', 'ドライヤー', ['ヘアドライヤー']), entry('toothbrush', '歯ブラシ'),
];

const TARGET_CLASS_SET = new Set<string>(COCO_OBJECT_SEARCH_CLASSES);
const TARGET_BY_CLASS = new Map(OBJECT_SEARCH_TARGETS.map((target) => [target.classId, target]));
const TARGET_BY_IDENTIFIER = new Map<string, ObjectSearchTargetDefinition>();
const AMBIGUOUS_TARGET_IDENTIFIERS = new Set<string>();
OBJECT_SEARCH_TARGETS.forEach((target) => {
  [target.classId, target.displayName, ...target.aliases].forEach((identifier) => {
    const normalized = normalizeObjectSearchTargetText(identifier);
    const previous = TARGET_BY_IDENTIFIER.get(normalized);
    if (previous && previous.classId !== target.classId) AMBIGUOUS_TARGET_IDENTIFIERS.add(normalized);
    else TARGET_BY_IDENTIFIER.set(normalized, target);
  });
});
AMBIGUOUS_TARGET_IDENTIFIERS.forEach((identifier) => TARGET_BY_IDENTIFIER.delete(identifier));

export function isObjectSearchTargetClass(value: unknown): value is ObjectSearchTargetClass {
  return typeof value === 'string' && TARGET_CLASS_SET.has(value);
}

export function getObjectSearchTarget(classId: ObjectSearchTargetClass): ObjectSearchTargetDefinition {
  const target = TARGET_BY_CLASS.get(classId);
  if (!target) throw new Error(`Object Search target registryに${classId}がありません。`);
  return target;
}

export function resolveObjectSearchTargetIdentifier(value: string): ObjectSearchTargetDefinition | undefined {
  return TARGET_BY_IDENTIFIER.get(normalizeObjectSearchTargetText(value));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function aliasPattern(alias: string): RegExp {
  const normalized = normalizeObjectSearchTargetText(alias);
  const escaped = escapeRegExp(normalized);
  return /^[a-z0-9 -]+$/.test(normalized)
    ? new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'giu')
    // Japanese has no generic word boundary. Require a particle, punctuation,
    // whitespace, or end-of-input after an alias so compounds such as 人気,
    // 車輪, and 本棚 cannot masquerade as person, car, and book.
    : new RegExp(`${escaped}(?=$|[\\s、。,.!?！？をがはもとにへで]|の(?:場所|居場所|位置))`, 'giu');
}

const TARGET_PATTERNS = OBJECT_SEARCH_TARGETS.map((target) => ({
  target,
  patterns: [...new Set([target.classId, target.displayName, ...target.aliases])].map(aliasPattern),
}));

export function normalizeObjectSearchTargetText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function matchedObjectSearchTargets(value: string): readonly ObjectSearchTargetDefinition[] {
  const normalized = normalizeObjectSearchTargetText(value);
  const matches: Array<{ start: number; end: number; target: ObjectSearchTargetDefinition }> = [];
  TARGET_PATTERNS.forEach(({ target, patterns }) => patterns.forEach((pattern) => {
    pattern.lastIndex = 0;
    for (const match of normalized.matchAll(pattern)) {
      const start = match.index;
      matches.push({ start, end: start + match[0].length, target });
    }
  }));
  const selected: typeof matches = [];
  matches
    .sort((left, right) => left.start - right.start || (right.end - right.start) - (left.end - left.start))
    .forEach((match) => {
      if (!selected.some((chosen) => match.start < chosen.end && match.end > chosen.start)) selected.push(match);
    });
  return [...new Map(selected.map((match) => [match.target.classId, match.target])).values()];
}
