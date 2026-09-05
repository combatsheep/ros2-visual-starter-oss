import { UPLOADED_VISION_TARGET_ASSET_PREFIX } from './playground';

const STAGE_IMAGE_DATABASE_NAME = 'ros2-visual-starter-stage-images-v1';
const STAGE_IMAGE_STORE_NAME = 'images';
const STAGE_IMAGE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;

export const STAGE_IMAGE_UPLOAD_OPTION = '__stage_image_upload__';
export const STAGE_IMAGE_MIN_DIMENSION = 50;
export const STAGE_IMAGE_MAX_DIMENSION = 5000;
export const STAGE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const STAGE_VIDEO_MAX_BYTES = 25 * 1024 * 1024;
export const STAGE_VIDEO_MAX_DURATION_SECONDS = 60;
export const STAGE_MEDIA_PROBE_TIMEOUT_MS = 15_000;

const verifiedMedia = new WeakMap<Blob, StageImageDimensions>();

export type StageImageFormat = 'jpeg' | 'png' | 'webm';
export type StageImageMimeType = 'image/jpeg' | 'image/png' | 'video/webm';

export interface StageImageFileLike {
  name: string;
  type: string;
}

export interface StageImageDimensions {
  width: number;
  height: number;
}

export interface StoredStageImage {
  id: string;
  fileName: string;
  mimeType: StageImageMimeType;
  blob: Blob;
  width: number;
  height: number;
  createdAt: number;
}

export interface RegisteredStageImage extends StoredStageImage {
  reference: string;
  url: string;
}

interface StageImageFormatInfo {
  format: StageImageFormat;
  mimeType: StageImageMimeType;
  video: boolean;
}

const FORMAT_BY_EXTENSION: Record<string, StageImageFormatInfo> = {
  jpg: { format: 'jpeg', mimeType: 'image/jpeg', video: false },
  jpeg: { format: 'jpeg', mimeType: 'image/jpeg', video: false },
  png: { format: 'png', mimeType: 'image/png', video: false },
  webm: { format: 'webm', mimeType: 'video/webm', video: true },
};

const FORMAT_BY_MIME: Record<string, StageImageFormatInfo> = {
  'image/jpeg': FORMAT_BY_EXTENSION.jpg,
  'image/png': FORMAT_BY_EXTENSION.png,
  'video/webm': FORMAT_BY_EXTENSION.webm,
};

const registeredStageImages = new Map<string, RegisteredStageImage>();

export function stageImageFormatForFile(file: StageImageFileLike): StageImageFormatInfo | null {
  const extension = file.name.toLowerCase().split('.').pop() ?? '';
  const byExtension = FORMAT_BY_EXTENSION[extension];
  const mime = file.type.toLowerCase();
  const byMime = mime ? FORMAT_BY_MIME[mime] : undefined;
  if (!byExtension || (mime && (!byMime || byMime.format !== byExtension.format))) return null;
  return byExtension;
}

export function isStageImageDimensionValid(dimensions: StageImageDimensions): boolean {
  return Number.isInteger(dimensions.width)
    && Number.isInteger(dimensions.height)
    && dimensions.width >= STAGE_IMAGE_MIN_DIMENSION
    && dimensions.height >= STAGE_IMAGE_MIN_DIMENSION
    && dimensions.width <= STAGE_IMAGE_MAX_DIMENSION
    && dimensions.height <= STAGE_IMAGE_MAX_DIMENSION;
}

export function stageImageDimensionError(dimensions: StageImageDimensions): string {
  return `画像の解像度は幅・高さともに${STAGE_IMAGE_MIN_DIMENSION}〜${STAGE_IMAGE_MAX_DIMENSION}pxにしてください（選択画像: ${dimensions.width}×${dimensions.height}px）。`;
}

export function makeUploadedStageImageReference(id: string): string {
  return `${UPLOADED_VISION_TARGET_ASSET_PREFIX}${id}`;
}

export function uploadedStageImageIdFromReference(reference: string | undefined): string | null {
  if (!reference || !reference.startsWith(UPLOADED_VISION_TARGET_ASSET_PREFIX)) return null;
  const id = reference.slice(UPLOADED_VISION_TARGET_ASSET_PREFIX.length);
  return STAGE_IMAGE_ID_PATTERN.test(id) ? id : null;
}

export function isStageImageVideo(reference: string | undefined): boolean {
  const image = getRegisteredStageImageByReference(reference);
  return image?.mimeType === 'video/webm';
}

export function getRegisteredStageImageByReference(reference: string | undefined): RegisteredStageImage | null {
  const id = uploadedStageImageIdFromReference(reference);
  return id ? registeredStageImages.get(id) ?? null : null;
}

export function registerStageImage(record: StoredStageImage): RegisteredStageImage {
  validateStoredStageImage(record);
  const previous = registeredStageImages.get(record.id);
  if (previous && previous.url.startsWith('blob:')) URL.revokeObjectURL(previous.url);
  const registered: RegisteredStageImage = {
    ...record,
    reference: makeUploadedStageImageReference(record.id),
    url: URL.createObjectURL(record.blob),
  };
  registeredStageImages.set(record.id, registered);
  return registered;
}

export function resolveStageImageUrl(reference: string | undefined): string | null {
  return getRegisteredStageImageByReference(reference)?.url ?? null;
}

export function createStageImageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `image-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function stageImageSizeError(file: StageImageFileLike & { size: number }): string | null {
  const format = stageImageFormatForFile(file);
  if (!format) return 'その画像フォーマットは使えません';
  const limit = format.video ? STAGE_VIDEO_MAX_BYTES : STAGE_IMAGE_MAX_BYTES;
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > limit) {
    return format.video ? '動画は25 MiB以内にしてください。' : '画像は10 MiB以内にしてください。';
  }
  return null;
}

export function isStageVideoDurationValid(duration: number): boolean {
  return Number.isFinite(duration) && duration > 0 && duration <= STAGE_VIDEO_MAX_DURATION_SECONDS;
}

function validateStoredStageImage(record: StoredStageImage): void {
  const error = stageImageSizeError({ name: record.fileName, type: record.mimeType, size: record.blob.size });
  if (error) throw new Error(error);
  if (!isStageImageDimensionValid(record)) throw new Error(stageImageDimensionError(record));
  if (record.mimeType === 'video/webm') {
    const verified = verifiedMedia.get(record.blob);
    if (!verified || verified.width !== record.width || verified.height !== record.height) {
      throw new Error('動画の長さと解像度を再確認してから取り込んでください。');
    }
  }
}

export function disposeRegisteredStageImages(): void {
  for (const image of registeredStageImages.values()) URL.revokeObjectURL(image.url);
  registeredStageImages.clear();
}

export function readStageImageDimensions(file: File): Promise<StageImageDimensions> {
  const sizeError = stageImageSizeError(file);
  if (sizeError) return Promise.reject(new Error(sizeError));
  const cached = verifiedMedia.get(file);
  if (cached) return Promise.resolve(cached);
  const video = stageImageFormatForFile(file)!.video;
  return new Promise<StageImageDimensions>((resolve, reject) => {
    let objectUrl: string | undefined;
    let media: HTMLVideoElement | HTMLImageElement | undefined;
    let settled = false;
    const loadEvent = video ? 'loadedmetadata' : 'load';
    const finish = (error?: Error, dimensions?: StageImageDimensions): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (media) {
        media.removeEventListener(loadEvent, onLoad);
        media.removeEventListener('error', onError);
      }
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      try {
        media?.removeAttribute('src');
        if (video && media) (media as HTMLVideoElement).load();
      } catch { /* Cleanup must not prevent promise settlement. */ }
      if (error) reject(error);
      else if (dimensions) {
        verifiedMedia.set(file, dimensions);
        resolve(dimensions);
      }
    };
    const onError = (): void => finish(new Error('画像・動画を読み込めませんでした。対応形式と内容を確認してください。'));
    const onLoad = (): void => {
      if (video) {
        const element = media as HTMLVideoElement;
        if (!isStageVideoDurationValid(element.duration)) {
          finish(new Error('動画は長さを確認できる60秒以内のファイルにしてください。'));
          return;
        }
        finish(undefined, { width: element.videoWidth, height: element.videoHeight });
      } else {
        const element = media as HTMLImageElement;
        finish(undefined, { width: element.naturalWidth, height: element.naturalHeight });
      }
    };
    const timer = setTimeout(() => finish(new Error('画像・動画の読み込みがタイムアウトしました。')), STAGE_MEDIA_PROBE_TIMEOUT_MS);
    try {
      media = video ? document.createElement('video') : new Image();
      if (video) {
        const element = media as HTMLVideoElement;
        element.preload = 'metadata';
        element.muted = true;
        element.playsInline = true;
      }
      media.addEventListener(loadEvent, onLoad);
      media.addEventListener('error', onError);
      objectUrl = URL.createObjectURL(file);
      media.src = objectUrl;
      if (video) (media as HTMLVideoElement).load();
    } catch {
      onError();
    }
  });
}

export function stageImageStorageError(error: unknown): Error {
  if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'QuotaExceededError') {
    return new Error('Browserの保存容量が不足しています。サイトの保存データを整理してから再登録してください（削除すると保存済みStageや画像も失われます）。');
  }
  return error instanceof Error ? error : new Error('画像をBrowserへ保存できませんでした。');
}

function openStageImageDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('Browserの画像保存領域を利用できません。'));
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(STAGE_IMAGE_DATABASE_NAME, 1);
    request.addEventListener('upgradeneeded', () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STAGE_IMAGE_STORE_NAME)) database.createObjectStore(STAGE_IMAGE_STORE_NAME, { keyPath: 'id' });
    });
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(request.error ?? new Error('Browserの画像保存領域を開けませんでした。')), { once: true });
  });
}

export async function listStoredStageImages(): Promise<StoredStageImage[]> {
  const database = await openStageImageDatabase();
  try {
    const records = await new Promise<StoredStageImage[]>((resolve, reject) => {
      const transaction = database.transaction(STAGE_IMAGE_STORE_NAME, 'readonly');
      const request = transaction.objectStore(STAGE_IMAGE_STORE_NAME).getAll();
      request.addEventListener('success', () => {
        const records = (request.result as StoredStageImage[]).filter((record) => (
          typeof record?.id === 'string'
          && typeof record.fileName === 'string'
          && (record.mimeType === 'image/jpeg' || record.mimeType === 'image/png' || record.mimeType === 'video/webm')
          && record.blob instanceof Blob
          && isStageImageDimensionValid({ width: record.width, height: record.height })
          && !stageImageSizeError({ name: record.fileName, type: record.mimeType, size: record.blob.size })
        ));
        resolve(records.sort((left, right) => left.createdAt - right.createdAt));
      }, { once: true });
      request.addEventListener('error', () => reject(request.error ?? new Error('保存画像を読み込めませんでした。')), { once: true });
    });
    const valid: StoredStageImage[] = [];
    for (const record of records) {
      try {
        if (record.mimeType === 'video/webm') {
          const dimensions = await readStageImageDimensions(new File([record.blob], record.fileName, { type: record.mimeType }));
          verifiedMedia.set(record.blob, dimensions);
        }
        validateStoredStageImage(record);
        valid.push(record);
      } catch { /* Older media outside the current limits is not restored. */ }
    }
    return valid;
  } finally {
    database.close();
  }
}

export async function storeStageImage(record: StoredStageImage): Promise<void> {
  const sizeError = stageImageSizeError({ name: record.fileName, type: record.mimeType, size: record.blob.size });
  if (sizeError) throw new Error(sizeError);
  if (record.mimeType === 'video/webm' && !verifiedMedia.has(record.blob)) {
    const dimensions = await readStageImageDimensions(new File([record.blob], record.fileName, { type: record.mimeType }));
    verifiedMedia.set(record.blob, dimensions);
  }
  validateStoredStageImage(record);
  let database: IDBDatabase | undefined;
  try {
    database = await openStageImageDatabase();
    const openedDatabase = database;
    await new Promise<void>((resolve, reject) => {
      const transaction = openedDatabase.transaction(STAGE_IMAGE_STORE_NAME, 'readwrite');
      transaction.addEventListener('complete', () => resolve(), { once: true });
      transaction.addEventListener('error', () => reject(transaction.error ?? new Error('画像をBrowserへ保存できませんでした。')), { once: true });
      transaction.addEventListener('abort', () => reject(transaction.error ?? new Error('画像をBrowserへ保存できませんでした。')), { once: true });
      const request = transaction.objectStore(STAGE_IMAGE_STORE_NAME).put(record);
      request.addEventListener('error', () => reject(request.error ?? transaction.error), { once: true });
    });
  } catch (error) {
    throw stageImageStorageError(error);
  } finally {
    database?.close();
  }
}
