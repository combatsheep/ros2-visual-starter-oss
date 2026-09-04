import { appPath } from './appPaths';

export const PLAYGROUND_SCHEMA_VERSION = 1 as const;
export const PLAYGROUND_STORAGE_KEY = 'ros2-visual-starter-playground-v1';
export const PLAYGROUND_LIBRARY_SCHEMA_VERSION = 1 as const;
export const PLAYGROUND_LIBRARY_STORAGE_KEY = 'ros2-visual-starter-playground-library-v1';
export const PLAYGROUND_LIBRARY_MAX_ITEMS = 64;
export const UPLOADED_VISION_TARGET_ASSET_PREFIX = 'uploaded:';

export const VISION_TARGET_ASSETS = {
  yoloxDog: {
    id: 'yolox-dog',
    label: '犬と自転車',
    url: appPath('vision/dog.jpg'),
    localPath: 'vision/dog.jpg',
    expectedClasses: ['dog', 'bicycle', 'car'],
  },
} as const;

export type VisionTargetAsset = typeof VISION_TARGET_ASSETS[keyof typeof VISION_TARGET_ASSETS];
export type VisionTargetAssetId = VisionTargetAsset['id'];
export const VISION_TARGET_ASSET = VISION_TARGET_ASSETS.yoloxDog.url;

export function getVisionTargetAssetByUrl(url: string | undefined): VisionTargetAsset | null {
  if (!url) return null;
  return Object.values(VISION_TARGET_ASSETS).find((asset) => asset.url === url || `/${asset.localPath}` === url) ?? null;
}

export function getVisionTargetAssetById(id: string): VisionTargetAsset | null {
  return Object.values(VISION_TARGET_ASSETS).find((asset) => asset.id === id) ?? null;
}

export function isUploadedVisionTargetAssetReference(value: unknown): value is string {
  return typeof value === 'string'
    && /^uploaded:[a-z0-9][a-z0-9-]{0,127}$/.test(value);
}

export type PlaygroundObjectKind = 'wall' | 'box' | 'gate' | 'vision_target';

export const PLAYGROUND_STAGE_PRESETS = {
  small: { label: 'Small', worldSize: 6, gridCells: 12, halfExtent: 3, objectBounds: 3.2 },
  medium: { label: '標準', worldSize: 8, gridCells: 16, halfExtent: 4, objectBounds: 4.2 },
  large: { label: 'Large', worldSize: 10, gridCells: 20, halfExtent: 5, objectBounds: 5.2 },
} as const;

export type PlaygroundStageSize = keyof typeof PLAYGROUND_STAGE_PRESETS;
export const DEFAULT_PLAYGROUND_STAGE_SIZE: PlaygroundStageSize = 'medium';
export const PLAYGROUND_OBJECT_POSITION_LIMIT = PLAYGROUND_STAGE_PRESETS.large.objectBounds;
export const PLAYGROUND_OBJECT_SIZE_LIMIT = PLAYGROUND_STAGE_PRESETS.large.worldSize + .4;

export interface PlaygroundObject {
  id: string;
  kind: PlaygroundObjectKind;
  label: string;
  position: { x: number; z: number };
  rotation: number;
  size: { width: number; height: number; depth: number };
  color: string;
  asset?: string;
}

export interface PlaygroundDefinition {
  version: typeof PLAYGROUND_SCHEMA_VERSION;
  name: string;
  stageSize: PlaygroundStageSize;
  objects: PlaygroundObject[];
}

export interface SavedPlayground {
  definition: PlaygroundDefinition;
  savedAt: number;
}

export interface PlaygroundLibrary {
  version: typeof PLAYGROUND_LIBRARY_SCHEMA_VERSION;
  selected: string | null;
  items: SavedPlayground[];
}

const WALL_COLOR = '#95c9bd';

export const DEFAULT_PLAYGROUND: PlaygroundDefinition = {
  version: PLAYGROUND_SCHEMA_VERSION,
  name: 'Training Room',
  stageSize: DEFAULT_PLAYGROUND_STAGE_SIZE,
  objects: [
    { id: 'wall-north', kind: 'wall', label: '北の壁', position: { x: 0, z: -4 }, rotation: 0, size: { width: 8, height: 1, depth: .18 }, color: WALL_COLOR },
    { id: 'wall-south', kind: 'wall', label: '南の壁', position: { x: 0, z: 4 }, rotation: 0, size: { width: 8, height: 1, depth: .18 }, color: WALL_COLOR },
    { id: 'wall-west', kind: 'wall', label: '西の壁', position: { x: -4, z: 0 }, rotation: Math.PI / 2, size: { width: 8, height: 1, depth: .18 }, color: WALL_COLOR },
    { id: 'wall-east', kind: 'wall', label: '東の壁', position: { x: 4, z: 0 }, rotation: Math.PI / 2, size: { width: 8, height: 1, depth: .18 }, color: WALL_COLOR },
    { id: 'safety-box', kind: 'box', label: 'SAFETY BOX', position: { x: 0, z: -.35 }, rotation: 0, size: { width: 1.15, height: .65, depth: .9 }, color: '#f19b55' },
    { id: 'blue-box', kind: 'box', label: 'BLUE BOX', position: { x: -1.75, z: -1.8 }, rotation: 0, size: { width: 1.25, height: .85, depth: .7 }, color: '#6a91df' },
    { id: 'red-box', kind: 'box', label: 'RED BOX', position: { x: 1.75, z: -1.65 }, rotation: 0, size: { width: .8, height: .55, depth: 1.35 }, color: '#e76f65' },
    { id: 'training-gate', kind: 'gate', label: 'GATE', position: { x: -2.38, z: 1.15 }, rotation: 0, size: { width: .95, height: 1.15, depth: .12 }, color: '#a3b9ec' },
    { id: 'vision-target', kind: 'vision_target', label: 'YOLOX検証ターゲット', position: { x: 0, z: 1.15 }, rotation: 0, size: { width: 1.6, height: 1.2, depth: .05 }, color: '#ffffff', asset: VISION_TARGET_ASSET },
  ],
};

const ROOT_FIELDS = new Set(['version', 'name', 'stageSize', 'objects']);
const OBJECT_FIELDS = new Set(['id', 'kind', 'label', 'position', 'rotation', 'size', 'color', 'asset']);
const POSITION_FIELDS = new Set(['x', 'z']);
const SIZE_FIELDS = new Set(['width', 'height', 'depth']);
const KINDS = new Set<PlaygroundObjectKind>(['wall', 'box', 'gate', 'vision_target']);
const PLAYGROUND_LIBRARY_FIELDS = new Set(['version', 'selected', 'items']);
const SAVED_PLAYGROUND_FIELDS = new Set(['definition', 'savedAt']);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasOnlyFields = (value: Record<string, unknown>, fields: Set<string>): boolean => Object.keys(value).every((key) => fields.has(key));
const isFiniteRange = (value: unknown, minimum: number, maximum: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;

export function clonePlayground(definition: PlaygroundDefinition): PlaygroundDefinition {
  return structuredClone(definition);
}

export function parsePlayground(input: string | unknown): PlaygroundDefinition {
  let value: unknown = input;
  if (typeof input === 'string') {
    try { value = JSON.parse(input) as unknown; } catch { throw new Error('JSONの構文が壊れています。exportしたファイルを選び直してください。'); }
  }
  if (!isRecord(value) || !hasOnlyFields(value, ROOT_FIELDS)) throw new Error('Playground JSONの項目がschemaと一致しません。');
  if (value.version !== PLAYGROUND_SCHEMA_VERSION) throw new Error(`未対応のPlayground versionです。対応versionは${PLAYGROUND_SCHEMA_VERSION}です。`);
  if (typeof value.name !== 'string' || value.name.trim().length < 1 || value.name.length > 80) throw new Error('Playground名は1〜80文字で指定してください。');
  const stageSizeValue = value.stageSize === undefined ? DEFAULT_PLAYGROUND_STAGE_SIZE : value.stageSize;
  if (typeof stageSizeValue !== 'string' || !Object.prototype.hasOwnProperty.call(PLAYGROUND_STAGE_PRESETS, stageSizeValue)) throw new Error('stageSizeはsmall、medium、largeのいずれかで指定してください。');
  const stageSize = stageSizeValue as PlaygroundStageSize;
  if (!Array.isArray(value.objects) || value.objects.length < 1 || value.objects.length > 64) throw new Error('objectは1〜64個で指定してください。');

  const ids = new Set<string>();
  const objects = value.objects.map((candidate, index): PlaygroundObject => {
    if (!isRecord(candidate) || !hasOnlyFields(candidate, OBJECT_FIELDS)) throw new Error(`object ${index + 1} に未知の項目があります。`);
    if (typeof candidate.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(candidate.id) || ids.has(candidate.id)) throw new Error(`object ${index + 1} のidが不正または重複しています。`);
    ids.add(candidate.id);
    if (typeof candidate.kind !== 'string' || !KINDS.has(candidate.kind as PlaygroundObjectKind)) throw new Error(`${candidate.id} の種類は未対応です。`);
    if (typeof candidate.label !== 'string' || candidate.label.trim().length < 1 || candidate.label.length > 80) throw new Error(`${candidate.id} のlabelは1〜80文字で指定してください。`);
    if (!isRecord(candidate.position) || !hasOnlyFields(candidate.position, POSITION_FIELDS)) throw new Error(`${candidate.id} のpositionが不正です。`);
    if (!isFiniteRange(candidate.position.x, -PLAYGROUND_OBJECT_POSITION_LIMIT, PLAYGROUND_OBJECT_POSITION_LIMIT) || !isFiniteRange(candidate.position.z, -PLAYGROUND_OBJECT_POSITION_LIMIT, PLAYGROUND_OBJECT_POSITION_LIMIT)) throw new Error(`${candidate.id} の位置はステージ範囲内にしてください。`);
    if (!isFiniteRange(candidate.rotation, -Math.PI * 2, Math.PI * 2)) throw new Error(`${candidate.id} の回転値が範囲外です。`);
    if (!isRecord(candidate.size) || !hasOnlyFields(candidate.size, SIZE_FIELDS)) throw new Error(`${candidate.id} のsizeが不正です。`);
    if (!isFiniteRange(candidate.size.width, .05, PLAYGROUND_OBJECT_SIZE_LIMIT) || !isFiniteRange(candidate.size.height, .1, 3) || !isFiniteRange(candidate.size.depth, .03, PLAYGROUND_OBJECT_SIZE_LIMIT)) throw new Error(`${candidate.id} の寸法が範囲外です。`);
    if (typeof candidate.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(candidate.color)) throw new Error(`${candidate.id} の色は#RRGGBBで指定してください。`);
    const visionTargetAsset = typeof candidate.asset === 'string' ? getVisionTargetAssetByUrl(candidate.asset) : null;
    const uploadedVisionTargetAsset = isUploadedVisionTargetAssetReference(candidate.asset) ? candidate.asset : null;
    if (candidate.asset !== undefined && (candidate.kind !== 'vision_target' || (!visionTargetAsset && !uploadedVisionTargetAsset))) throw new Error(`${candidate.id} のassetは許可されたローカル検証assetではありません。`);
    return {
      id: candidate.id,
      kind: candidate.kind as PlaygroundObjectKind,
      label: candidate.label,
      position: { x: candidate.position.x, z: candidate.position.z },
      rotation: candidate.rotation,
      size: { width: candidate.size.width, height: candidate.size.height, depth: candidate.size.depth },
      color: candidate.color,
      ...(visionTargetAsset ? { asset: visionTargetAsset.url } : uploadedVisionTargetAsset ? { asset: uploadedVisionTargetAsset } : {}),
    };
  });
  return { version: PLAYGROUND_SCHEMA_VERSION, name: value.name.trim(), stageSize, objects };
}

export function createPlaygroundLibrary(): PlaygroundLibrary {
  return { version: PLAYGROUND_LIBRARY_SCHEMA_VERSION, selected: null, items: [] };
}

export function clonePlaygroundLibrary(library: PlaygroundLibrary): PlaygroundLibrary {
  return structuredClone(library);
}

export function parsePlaygroundLibrary(input: string | unknown): PlaygroundLibrary {
  let value: unknown = input;
  if (typeof input === 'string') {
    try { value = JSON.parse(input) as unknown; } catch { throw new Error('保存Stage JSONの構文が壊れています。'); }
  }
  if (!isRecord(value) || !hasOnlyFields(value, PLAYGROUND_LIBRARY_FIELDS)) throw new Error('保存Stage一覧の項目がschemaと一致しません。');
  if (value.version !== PLAYGROUND_LIBRARY_SCHEMA_VERSION) throw new Error(`未対応の保存Stage versionです。対応versionは${PLAYGROUND_LIBRARY_SCHEMA_VERSION}です。`);
  if (value.selected !== null && (typeof value.selected !== 'string' || value.selected.trim().length < 1 || value.selected.length > 80)) throw new Error('保存Stageの選択名が不正です。');
  if (!Array.isArray(value.items) || value.items.length > PLAYGROUND_LIBRARY_MAX_ITEMS) throw new Error(`保存Stageは${PLAYGROUND_LIBRARY_MAX_ITEMS}件以内で指定してください。`);

  const names = new Set<string>();
  const items = value.items.map((candidate, index): SavedPlayground => {
    if (!isRecord(candidate) || !hasOnlyFields(candidate, SAVED_PLAYGROUND_FIELDS)) throw new Error(`保存Stage ${index + 1} の項目が不正です。`);
    if (!isFiniteRange(candidate.savedAt, 0, Number.MAX_SAFE_INTEGER)) throw new Error(`保存Stage ${index + 1} の保存日時が不正です。`);
    const definition = parsePlayground(candidate.definition);
    if (names.has(definition.name)) throw new Error(`保存Stage名「${definition.name}」が重複しています。`);
    names.add(definition.name);
    return { definition, savedAt: candidate.savedAt };
  });
  const selected = typeof value.selected === 'string' ? value.selected.trim() : null;
  if (selected && !names.has(selected)) throw new Error('保存Stageの選択項目が一覧にありません。');
  return { version: PLAYGROUND_LIBRARY_SCHEMA_VERSION, selected, items };
}

export function upsertPlaygroundLibrary(library: PlaygroundLibrary, definition: PlaygroundDefinition, savedAt = Date.now()): PlaygroundLibrary {
  if (!isFiniteRange(savedAt, 0, Number.MAX_SAFE_INTEGER)) throw new Error('保存Stageの保存日時が不正です。');
  const parsed = parsePlayground(definition);
  const items = [
    { definition: clonePlayground(parsed), savedAt },
    ...library.items.filter((item) => item.definition.name !== parsed.name).map((item) => ({ definition: clonePlayground(item.definition), savedAt: item.savedAt })),
  ].slice(0, PLAYGROUND_LIBRARY_MAX_ITEMS);
  return { version: PLAYGROUND_LIBRARY_SCHEMA_VERSION, selected: parsed.name, items };
}

export function snapToGrid(value: number, grid = .1): number {
  if (!Number.isFinite(value) || !Number.isFinite(grid) || grid <= 0) return value;
  const snappedMagnitude = Math.round(Math.abs(value) / grid + 1e-9) * grid;
  return Math.sign(value) * snappedMagnitude;
}

export function validateRobotClearance(object: PlaygroundObject, robotX: number, robotZ: number): void {
  const deltaX = robotX - object.position.x;
  const deltaZ = robotZ - object.position.z;
  const cosine = Math.cos(-object.rotation);
  const sine = Math.sin(-object.rotation);
  const localX = deltaX * cosine + deltaZ * sine;
  const localZ = -deltaX * sine + deltaZ * cosine;
  if (Math.abs(localX) < object.size.width / 2 + .35 && Math.abs(localZ) < object.size.depth / 2 + .35) {
    throw new Error('ロボットを物体内へ閉じ込める位置・寸法には変更できません。');
  }
}

export class PlaygroundHistory {
  private undoStack: PlaygroundDefinition[] = [];
  private redoStack: PlaygroundDefinition[] = [];

  push(previous: PlaygroundDefinition): void {
    this.undoStack.push(clonePlayground(previous));
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(current: PlaygroundDefinition): PlaygroundDefinition | null {
    const previous = this.undoStack.pop();
    if (!previous) return null;
    this.redoStack.push(clonePlayground(current));
    return clonePlayground(previous);
  }

  redo(current: PlaygroundDefinition): PlaygroundDefinition | null {
    const next = this.redoStack.pop();
    if (!next) return null;
    this.undoStack.push(clonePlayground(current));
    return clonePlayground(next);
  }

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
}
