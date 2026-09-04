import { UPLOADED_VISION_TARGET_ASSET_PREFIX } from './playground';

const STAGE_IMAGE_DATABASE_NAME = 'ros2-visual-starter-stage-images-v1';
const STAGE_IMAGE_STORE_NAME = 'images';
const STAGE_IMAGE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;

export const STAGE_IMAGE_UPLOAD_OPTION = '__stage_image_upload__';
export const STAGE_IMAGE_MIN_DIMENSION = 50;
export const STAGE_IMAGE_MAX_DIMENSION = 5000;

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

export function readStageImageDimensions(file: File): Promise<StageImageDimensions> {
  const format = stageImageFormatForFile(file);
  if (!format) return Promise.reject(new Error('その画像フォーマットは使えません'));
  const objectUrl = URL.createObjectURL(file);
  if (format.video) {
    return new Promise<StageImageDimensions>((resolve, reject) => {
      const video = document.createElement('video');
      const finish = (callback: () => void): void => {
        URL.revokeObjectURL(objectUrl);
        video.removeAttribute('src');
        video.load();
        callback();
      };
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      video.addEventListener('loadedmetadata', () => {
        const dimensions = { width: video.videoWidth, height: video.videoHeight };
        finish(() => resolve(dimensions));
      }, { once: true });
      video.addEventListener('error', () => finish(() => reject(new Error('画像を読み込めませんでした。対応形式とファイルの内容を確認してください。'))), { once: true });
      video.src = objectUrl;
      video.load();
    });
  }
  return new Promise<StageImageDimensions>((resolve, reject) => {
    const image = new Image();
    const finish = (callback: () => void): void => {
      URL.revokeObjectURL(objectUrl);
      image.removeAttribute('src');
      callback();
    };
    image.addEventListener('load', () => {
      const dimensions = { width: image.naturalWidth, height: image.naturalHeight };
      finish(() => resolve(dimensions));
    }, { once: true });
    image.addEventListener('error', () => finish(() => reject(new Error('画像を読み込めませんでした。対応形式とファイルの内容を確認してください。'))), { once: true });
    image.src = objectUrl;
  });
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
    return await new Promise<StoredStageImage[]>((resolve, reject) => {
      const transaction = database.transaction(STAGE_IMAGE_STORE_NAME, 'readonly');
      const request = transaction.objectStore(STAGE_IMAGE_STORE_NAME).getAll();
      request.addEventListener('success', () => {
        const records = (request.result as StoredStageImage[]).filter((record) => (
          typeof record?.id === 'string'
          && typeof record.fileName === 'string'
          && (record.mimeType === 'image/jpeg' || record.mimeType === 'image/png' || record.mimeType === 'video/webm')
          && record.blob instanceof Blob
          && isStageImageDimensionValid({ width: record.width, height: record.height })
        ));
        resolve(records.sort((left, right) => left.createdAt - right.createdAt));
      }, { once: true });
      request.addEventListener('error', () => reject(request.error ?? new Error('保存画像を読み込めませんでした。')), { once: true });
    });
  } finally {
    database.close();
  }
}

export async function storeStageImage(record: StoredStageImage): Promise<void> {
  const database = await openStageImageDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STAGE_IMAGE_STORE_NAME, 'readwrite');
      transaction.addEventListener('complete', () => resolve(), { once: true });
      transaction.addEventListener('error', () => reject(transaction.error ?? new Error('画像をBrowserへ保存できませんでした。')), { once: true });
      transaction.addEventListener('abort', () => reject(transaction.error ?? new Error('画像をBrowserへ保存できませんでした。')), { once: true });
      transaction.objectStore(STAGE_IMAGE_STORE_NAME).put(record);
    });
  } finally {
    database.close();
  }
}
