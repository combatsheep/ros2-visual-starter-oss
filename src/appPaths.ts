const configuredBasePath = import.meta.env.BASE_URL || '/';

export const APP_BASE_PATH = configuredBasePath.endsWith('/') ? configuredBasePath : `${configuredBasePath}/`;

export function appPath(path: string): string {
  return `${APP_BASE_PATH}${path.replace(/^\/+/, '')}`;
}
