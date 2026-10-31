/**
 * Platform name registered in Homebridge config.json (`"platform": "AiperSurfer2"`).
 */
export declare const PLATFORM_NAME = "AiperSurfer2";
/**
 * Plugin package name matching `package.json`.
 */
export declare const PLUGIN_NAME = "homebridge-aiper-surfer2";
/**
 * Regional Aiper Cloud REST base URLs.
 */
export declare const AIPER_API_ENDPOINTS: {
    readonly us: "https://apiamerica.aiper.com";
    readonly eu: "https://apieurope.aiper.com";
    readonly asia: "https://apiasia.aiper.com";
};
export declare const DEFAULT_LOW_BATTERY_THRESHOLD = 20;
export declare const DEFAULT_POLL_INTERVAL_SECONDS = 300;
export declare const DEFAULT_METADATA_REFRESH_MS: number;
