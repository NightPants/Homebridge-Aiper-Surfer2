import type { PlatformAccessory } from 'homebridge';
import type { AiperSurferPlatform } from './platform.js';
import type { SurferAccessoryContext } from './types.js';
export declare class SurferPlatformAccessory {
    private readonly platform;
    private readonly accessory;
    private primaryService?;
    private batteryService?;
    private filterService?;
    private doorbellTimers;
    private unsubscribeState?;
    private unsubscribeCycle?;
    private unsubscribeWarning?;
    constructor(platform: AiperSurferPlatform, accessory: PlatformAccessory<SurferAccessoryContext>);
    dispose(): void;
    private updateAccessoryInformation;
    private setupMainSkimmerAccessory;
    private setupCleanPathSwitchAccessory;
    private setupWarningSensorAccessory;
    private setupSolarSensorAccessory;
    private setupWaterTemperatureAccessory;
    private setupDoorbellAccessory;
    private ringDoorbell;
    private applyStateUpdate;
    private updateMainAccessoryCharacteristics;
    private doesFilterNeedAttention;
    private getLowBatteryThreshold;
    private configureServiceNames;
}
