import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, Service } from 'homebridge';
import { AiperClient } from './aiperClient.js';
import type { AiperSurferPlatformConfig, DiscoveredAiperDevice, SurferAccessoryContext } from './types.js';
export declare class AiperSurferPlatform implements DynamicPlatformPlugin {
    readonly log: Logging;
    readonly config: AiperSurferPlatformConfig;
    readonly api: API;
    readonly Service: typeof Service;
    readonly Characteristic: typeof Characteristic;
    readonly aiperClient: AiperClient;
    readonly cachedAccessories: Map<string, PlatformAccessory<SurferAccessoryContext>>;
    private readonly activeHandlers;
    private readonly dynamicTempRegistered;
    private startupRetryTimer?;
    constructor(log: Logging, config: AiperSurferPlatformConfig, api: API);
    configureAccessory(accessory: PlatformAccessory): void;
    private initializePlatform;
    private scheduleStartupRetry;
    private restoreFromCacheOnly;
    syncDevicesToHomeKit(devices: DiscoveredAiperDevice[]): void;
    private resolveDesiredRoles;
    private buildAccessoryUuid;
    private upsertAccessory;
}
