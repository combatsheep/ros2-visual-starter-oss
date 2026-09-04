import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_PLAYGROUND,
  PlaygroundHistory,
  VISION_TARGET_ASSETS,
  VISION_TARGET_ASSET,
  clonePlayground,
  createPlaygroundLibrary,
  getVisionTargetAssetByUrl,
  parsePlayground,
  parsePlaygroundLibrary,
  snapToGrid,
  upsertPlaygroundLibrary,
  validateRobotClearance,
} from '../src/playground';

describe('Playground schema', () => {
  it('accepts the versioned default Training Room', () => {
    const parsed = parsePlayground(JSON.stringify(DEFAULT_PLAYGROUND));
    expect(parsed.version).toBe(1);
    expect(parsed.stageSize).toBe('medium');
    expect(parsed.objects.some((object) => object.kind === 'vision_target')).toBe(true);
  });

  it('keeps legacy JSON compatible and validates stage size presets', () => {
    const legacy = { ...DEFAULT_PLAYGROUND } as { version: 1; name: string; objects: typeof DEFAULT_PLAYGROUND.objects };
    delete (legacy as unknown as Record<string, unknown>).stageSize;
    expect(parsePlayground(legacy).stageSize).toBe('medium');
    expect(parsePlayground({ ...DEFAULT_PLAYGROUND, stageSize: 'small' }).stageSize).toBe('small');
    expect(parsePlayground({ ...DEFAULT_PLAYGROUND, stageSize: 'large' }).stageSize).toBe('large');
    expect(() => parsePlayground({ ...DEFAULT_PLAYGROUND, stageSize: 'wide' })).toThrow('stageSize');
  });

  it('round-trips the downloaded dog allowlist without accepting arbitrary URLs', () => {
    expect(getVisionTargetAssetByUrl('/vision/dog.jpg')?.id).toBe('yolox-dog');

    const legacyDog = clonePlayground(DEFAULT_PLAYGROUND);
    legacyDog.objects.find((object) => object.kind === 'vision_target')!.asset = '/vision/dog.jpg';
    expect(parsePlayground(legacyDog).objects.find((object) => object.kind === 'vision_target')?.asset).toBe(VISION_TARGET_ASSET);

    const remote = clonePlayground(DEFAULT_PLAYGROUND);
    remote.objects.find((object) => object.kind === 'vision_target')!.asset = 'https://example.com/apple.jpg';
    expect(() => parsePlayground(remote)).toThrow('許可されたローカル検証asset');
  });

  it('loads the reproducible Object Search example stage through schema v1', () => {
    const fixture = readFileSync(new URL('../examples/stages/object_search_room.json', import.meta.url), 'utf8');
    const stage = parsePlayground(fixture);
    expect(stage.stageSize).toBe('large');
    expect(stage.objects.some((object) => object.kind === 'box')).toBe(true);
    expect(stage.objects.find((object) => object.kind === 'vision_target')?.asset).toBe(VISION_TARGET_ASSETS.yoloxDog.url);
  });

  it('rejects broken JSON, unknown versions, fields, and unsafe ranges in Japanese', () => {
    expect(() => parsePlayground('{')).toThrow('JSONの構文');
    expect(() => parsePlayground({ ...DEFAULT_PLAYGROUND, version: 2 })).toThrow('未対応');
    expect(() => parsePlayground({ ...DEFAULT_PLAYGROUND, unexpected: true })).toThrow('schema');
    const invalid = clonePlayground(DEFAULT_PLAYGROUND);
    invalid.objects[0].size.height = 30;
    expect(() => parsePlayground(invalid)).toThrow('寸法が範囲外');
  });

  it('keeps a browser-uploaded image reference in schema v1 without accepting arbitrary URLs', () => {
    const uploaded = clonePlayground(DEFAULT_PLAYGROUND);
    uploaded.objects.find((object) => object.kind === 'vision_target')!.asset = 'uploaded:example-image';
    expect(parsePlayground(uploaded).objects.find((object) => object.kind === 'vision_target')?.asset).toBe('uploaded:example-image');
    uploaded.objects.find((object) => object.kind === 'vision_target')!.asset = 'https://example.com/image.png';
    expect(() => parsePlayground(uploaded)).toThrow('assetは許可');
  });

  it('stores multiple named stages and replaces an existing name', () => {
    const first = parsePlaygroundLibrary({
      version: 1,
      selected: 'Training Room',
      items: [{ definition: DEFAULT_PLAYGROUND, savedAt: 100 }],
    });
    const second = clonePlayground(DEFAULT_PLAYGROUND);
    second.name = 'Object Search Room';
    second.stageSize = 'large';
    const withSecond = upsertPlaygroundLibrary(first, second, 200);
    expect(withSecond.items.map((item) => item.definition.name)).toEqual(['Object Search Room', 'Training Room']);
    expect(withSecond.selected).toBe('Object Search Room');

    const replacement = clonePlayground(second);
    replacement.objects[0].label = '更新した壁';
    const replaced = upsertPlaygroundLibrary(withSecond, replacement, 300);
    expect(replaced.items).toHaveLength(2);
    expect(replaced.items[0].savedAt).toBe(300);
    expect(replaced.items[0].definition.objects[0].label).toBe('更新した壁');
    expect(() => parsePlaygroundLibrary({ ...createPlaygroundLibrary(), selected: 'missing' })).toThrow('選択項目');
  });

  it('snaps edits and prevents trapping the robot', () => {
    expect(snapToGrid(.26)).toBeCloseTo(.3);
    expect(snapToGrid(1.15)).toBeCloseTo(1.2);
    expect(snapToGrid(-1.15)).toBeCloseTo(-1.2);
    const box = clonePlayground(DEFAULT_PLAYGROUND).objects.find((object) => object.kind === 'box')!;
    box.position = { x: 0, z: 2.65 };
    expect(() => validateRobotClearance(box, 0, 2.65)).toThrow('閉じ込める');
  });
});

describe('Playground undo and redo', () => {
  it('restores complete definitions without shared mutation', () => {
    const history = new PlaygroundHistory();
    const initial = clonePlayground(DEFAULT_PLAYGROUND);
    const edited = clonePlayground(initial);
    edited.name = 'edited';
    history.push(initial);
    const undo = history.undo(edited)!;
    expect(undo.name).toBe('Training Room');
    expect(history.canRedo).toBe(true);
    const redo = history.redo(undo)!;
    expect(redo.name).toBe('edited');
  });
});
