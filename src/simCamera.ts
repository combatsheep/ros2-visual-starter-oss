export const SIM_TOP_CAMERA_DEFAULT_HEIGHT = 9.5;
export const SIM_TOP_CAMERA_MIN_ZOOM = 0.5;
export const SIM_TOP_CAMERA_MAX_ZOOM = 4;
export const SIM_TOP_CAMERA_ZOOM_STEP = 1.25;

export function clampSimTopCameraZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.max(SIM_TOP_CAMERA_MIN_ZOOM, Math.min(SIM_TOP_CAMERA_MAX_ZOOM, zoom));
}

export function simTopCameraHeight(zoom: number): number {
  return SIM_TOP_CAMERA_DEFAULT_HEIGHT / clampSimTopCameraZoom(zoom);
}
