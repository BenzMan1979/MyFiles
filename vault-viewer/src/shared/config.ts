import { deployButtonUrl, settings } from './settings';

export const APP_NAME = settings.appName;
/** Cloudflare's one-click deploy address for this project, or null when no repo is configured. */
export const DEPLOY_BUTTON_URL = deployButtonUrl(settings);

/** The viewer page that a server hosts next to its API (works on phones, no file needed on disk). */
export const openPageOf = (serverUrl: string): string => `${serverUrl.replace(/\/+$/, '')}/open.html`;
