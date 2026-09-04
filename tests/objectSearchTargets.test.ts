import { describe, expect, it } from 'vitest';
import {
  COCO_OBJECT_SEARCH_CLASSES,
  getObjectSearchTarget,
  matchedObjectSearchTargets,
} from '../src/objectSearchTargets';

describe('YOLOX Object Search target registry', () => {
  it('exposes all 80 COCO classes with deterministic Japanese display names', () => {
    expect(COCO_OBJECT_SEARCH_CLASSES).toHaveLength(80);
    expect(getObjectSearchTarget('banana').displayName).toBe('バナナ');
    expect(getObjectSearchTarget('dog').displayName).toBe('犬');
    expect(getObjectSearchTarget('chair').displayName).toBe('椅子');
  });

  it('matches explicit Japanese and English targets without substring collisions', () => {
    expect(matchedObjectSearchTargets('バナナを探して').map((target) => target.classId)).toEqual(['banana']);
    expect(matchedObjectSearchTargets('find a banana').map((target) => target.classId)).toEqual(['banana']);
    expect(matchedObjectSearchTargets('自転車を探して').map((target) => target.classId)).toEqual(['bicycle']);
    expect(matchedObjectSearchTargets('carrotを探して').map((target) => target.classId)).toEqual(['carrot']);
  });

  it('preserves multiple non-overlapping targets so the intent gate can reject ambiguity', () => {
    expect(matchedObjectSearchTargets('犬と猫を探して').map((target) => target.classId)).toEqual(['dog', 'cat']);
  });

  it.each(['人気スポットを探して', '車輪を探して', '本棚を探して', '人形を探して', 'たこ焼きを探して'])(
    'does not resolve an unsupported Japanese compound as a shorter COCO alias: %s',
    (sourceText) => {
      expect(matchedObjectSearchTargets(sourceText)).toEqual([]);
    },
  );
});
