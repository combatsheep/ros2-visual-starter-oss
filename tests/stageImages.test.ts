import { describe, expect, it } from 'vitest';
import { isStageImageDimensionValid, makeUploadedStageImageReference, stageImageDimensionError, stageImageFormatForFile, uploadedStageImageIdFromReference } from '../src/stageImages';

describe('STAGE image upload validation', () => {
  it('accepts jpg, png, and webm only when the name and MIME agree', () => {
    expect(stageImageFormatForFile({ name: 'dog.JPG', type: 'image/jpeg' })?.format).toBe('jpeg');
    expect(stageImageFormatForFile({ name: 'apple.png', type: 'image/png' })?.format).toBe('png');
    expect(stageImageFormatForFile({ name: 'motion.webm', type: 'video/webm' })?.format).toBe('webm');
    expect(stageImageFormatForFile({ name: 'image.gif', type: 'image/gif' })).toBeNull();
    expect(stageImageFormatForFile({ name: 'image.png', type: 'image/jpeg' })).toBeNull();
  });

  it('enforces the 50px to 5000px range on both dimensions', () => {
    expect(isStageImageDimensionValid({ width: 50, height: 5000 })).toBe(true);
    expect(isStageImageDimensionValid({ width: 49, height: 100 })).toBe(false);
    expect(isStageImageDimensionValid({ width: 100, height: 5001 })).toBe(false);
    expect(stageImageDimensionError({ width: 49, height: 100 })).toContain('50〜5000px');
  });

  it('round-trips an uploaded image reference id', () => {
    expect(makeUploadedStageImageReference('image-123')).toBe('uploaded:image-123');
    expect(uploadedStageImageIdFromReference('uploaded:image-123')).toBe('image-123');
    expect(uploadedStageImageIdFromReference('uploaded:../image')).toBeNull();
  });
});
