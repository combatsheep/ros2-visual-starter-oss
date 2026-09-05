import { afterEach, describe, expect, it, vi } from 'vitest';
import { disposeRegisteredStageImages, isStageVideoDurationValid, listStoredStageImages, readStageImageDimensions, registerStageImage, stageImageSizeError, stageImageStorageError, storeStageImage, STAGE_MEDIA_PROBE_TIMEOUT_MS, type StoredStageImage, isStageImageDimensionValid, makeUploadedStageImageReference, stageImageDimensionError, stageImageFormatForFile, uploadedStageImageIdFromReference } from '../src/stageImages';

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

// Probe and IndexedDB doubles exercise asynchronous events without adding a DOM dependency.
class MediaDouble extends EventTarget {
  duration = 60;
  videoWidth = 100;
  videoHeight = 100;
  naturalWidth = 100;
  naturalHeight = 100;
  src = '';
  removeAttribute = vi.fn();
  load = vi.fn();
}

function probeFixture(duration = 60) {
  const media = new MediaDouble();
  media.duration = duration;
  vi.stubGlobal('document', { createElement: () => media });
  vi.stubGlobal('Image', class { constructor() { return media; } });
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:media-test');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  return { media, create, revoke };
}

function record(blob = new Blob(['image'], { type: 'image/png' })): StoredStageImage {
  return { id: 'media-test', blob, fileName: 'test.png', mimeType: 'image/png', width: 100, height: 100, createdAt: 1 };
}

function databaseFixture(records: StoredStageImage[] = [], failure?: 'open' | 'put' | 'request' | 'abort' | 'error') {
  const quota = new DOMException('quota', 'QuotaExceededError');
  const transaction = Object.assign(new EventTarget(), { error: null as DOMException | null, objectStore: () => ({
    getAll: () => {
      const request = Object.assign(new EventTarget(), { result: records });
      queueMicrotask(() => request.dispatchEvent(new Event('success')));
      return request;
    },
    put: () => {
      if (failure === 'put') throw quota;
      const request = Object.assign(new EventTarget(), { error: quota });
      queueMicrotask(() => {
        if (failure === 'request') request.dispatchEvent(new Event('error'));
        else if (failure === 'abort' || failure === 'error') {
          transaction.error = quota;
          transaction.dispatchEvent(new Event(failure));
        } else transaction.dispatchEvent(new Event('complete'));
      });
      return request;
    },
  }) });
  const close = vi.fn();
  const open = vi.fn(() => {
    if (failure === 'open') throw quota;
    const request = Object.assign(new EventTarget(), { result: { transaction: () => transaction, close } });
    queueMicrotask(() => request.dispatchEvent(new Event('success')));
    return request;
  });
  vi.stubGlobal('indexedDB', { open });
  return { close, open };
}

afterEach(() => {
  disposeRegisteredStageImages();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('STAGE media resource limits', () => {
  it.each([['test.png', 'image/png', 10], ['test.webm', 'video/webm', 25]])('checks the exact byte boundary for %s', (name, type, mib) => {
    const limit = Number(mib) * 1024 * 1024;
    expect(stageImageSizeError({ name: String(name), type: String(type), size: limit })).toBeNull();
    expect(stageImageSizeError({ name: String(name), type: String(type), size: limit + 1 })).toContain(`${mib} MiB`);
  });
  it.each([60, 0.01])('accepts valid duration %s', (duration) => expect(isStageVideoDurationValid(duration)).toBe(true));
  it.each([60.001, 0, -1, NaN, Infinity])('rejects duration %s', (duration) => expect(isStageVideoDurationValid(duration)).toBe(false));
  it('rejects oversized bytes before creating a URL or opening storage', async () => {
    const { create } = probeFixture();
    const { open } = databaseFixture();
    const file = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'test.png', { type: 'image/png' });
    await expect(readStageImageDimensions(file)).rejects.toThrow('10 MiB');
    await expect(storeStageImage(record(file))).rejects.toThrow('10 MiB');
    expect(() => registerStageImage(record(file))).toThrow('10 MiB');
    expect(create).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
  it.each([60, 60.001, NaN, Infinity])('validates actual video metadata and revokes exactly once (%s)', async (duration) => {
    const { media, revoke } = probeFixture(duration);
    const pending = readStageImageDimensions(new File(['webm'], 'test.webm', { type: 'video/webm' }));
    media.dispatchEvent(new Event('loadedmetadata'));
    media.dispatchEvent(new Event('error'));
    if (duration === 60) await expect(pending).resolves.toEqual({ width: 100, height: 100 });
    else await expect(pending).rejects.toThrow('60秒');
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(media.removeAttribute).toHaveBeenCalledWith('src');
  });
  it('preserves empty-MIME image uploads and releases a successful probe URL', async () => {
    const { media, revoke } = probeFixture();
    const pending = readStageImageDimensions(new File(['png'], 'test.png'));
    media.dispatchEvent(new Event('load'));
    await expect(pending).resolves.toEqual({ width: 100, height: 100 });
    expect(revoke).toHaveBeenCalledTimes(1);
  });
  it('releases URLs on decode error', async () => {
    const { media, revoke } = probeFixture();
    const pending = readStageImageDimensions(new File(['bad'], 'test.png', { type: 'image/png' }));
    media.dispatchEvent(new Event('error'));
    await expect(pending).rejects.toThrow('読み込めません');
    expect(revoke).toHaveBeenCalledTimes(1);
  });
  it('releases URLs when setting up the decoder throws', async () => {
    const { media, revoke } = probeFixture();
    Object.defineProperty(media, 'src', { set: () => { throw new Error('decoder'); } });
    await expect(readStageImageDimensions(new File(['bad'], 'test.png'))).rejects.toThrow('読み込めません');
    expect(revoke).toHaveBeenCalledTimes(1);
  });
  it('times out and removes late event handlers', async () => {
    vi.useFakeTimers();
    const { media, revoke } = probeFixture();
    const pending = readStageImageDimensions(new File(['bad'], 'test.webm'));
    const assertion = expect(pending).rejects.toThrow('タイムアウト');
    await vi.advanceTimersByTimeAsync(STAGE_MEDIA_PROBE_TIMEOUT_MS);
    await assertion;
    media.dispatchEvent(new Event('loadedmetadata'));
    expect(revoke).toHaveBeenCalledTimes(1);
  });
  it.each(['open', 'put', 'request', 'abort', 'error'] as const)('converts %s quota failures into a Japanese error', async (failure) => {
    const { close } = databaseFixture([], failure);
    await expect(storeStageImage(record())).rejects.toThrow('保存容量が不足');
    expect(close).toHaveBeenCalledTimes(failure === 'open' ? 0 : 1);
  });
  it('retains non-quota errors and successful storage', async () => {
    const error = new Error('unavailable');
    expect(stageImageStorageError(error)).toBe(error);
    const { close } = databaseFixture();
    await expect(storeStageImage(record())).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  });
  it('revalidates persisted video bytes and ignores oversized legacy images', async () => {
    const { media, revoke } = probeFixture(61);
    const good = record();
    const video = { ...record(new Blob(['video'])), id: 'video', mimeType: 'video/webm' as const, fileName: 'old.webm' };
    databaseFixture([good, record(new Blob([new Uint8Array(10 * 1024 * 1024 + 1)])), video]);
    const pending = listStoredStageImages();
    // Opening the database and reading its records settle before metadata is delivered.
    await new Promise((resolve) => setTimeout(resolve, 0));
    media.dispatchEvent(new Event('loadedmetadata'));
    await expect(pending).resolves.toEqual([good]);
    expect(revoke).toHaveBeenCalledOnce();
    expect(() => registerStageImage(video)).toThrow('再確認');
  });
  it('restores valid legacy videos without requiring new stored metadata', async () => {
    const { media } = probeFixture(60);
    const video = { ...record(new Blob(['video'])), mimeType: 'video/webm' as const, fileName: 'old.webm' };
    databaseFixture([video]);
    const pending = listStoredStageImages();
    await new Promise((resolve) => setTimeout(resolve, 0));
    media.dispatchEvent(new Event('loadedmetadata'));
    await expect(pending).resolves.toEqual([video]);
    expect(registerStageImage(video).reference).toBe('uploaded:media-test');
  });
  it('releases registered URLs on replacement and disposal', () => {
    const { revoke } = probeFixture();
    registerStageImage(record());
    registerStageImage(record());
    expect(revoke).toHaveBeenCalledTimes(1);
    disposeRegisteredStageImages();
    disposeRegisteredStageImages();
    expect(revoke).toHaveBeenCalledTimes(2);
  });
});
