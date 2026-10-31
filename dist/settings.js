/**
 * Platform name registered in Homebridge config.json (`"platform": "AiperSurfer2"`).
 */
export const PLATFORM_NAME = 'AiperSurfer2';
/**
 * Plugin package name matching `package.json`.
 */
export const PLUGIN_NAME = 'homebridge-aiper-surfer2';
/**
 * Regional Aiper Cloud REST base URLs.
 */
export const AIPER_API_ENDPOINTS = {
    us: 'https://apiamerica.aiper.com',
    eu: 'https://apieurope.aiper.com',
    asia: 'https://apiasia.aiper.com',
};
export const DEFAULT_LOW_BATTERY_THRESHOLD = 20;
export const DEFAULT_POLL_INTERVAL_SECONDS = 300;
export const DEFAULT_METADATA_REFRESH_MS = 6 * 60 * 60 * 1000;
//# sourceMappingURL=settings.js.map