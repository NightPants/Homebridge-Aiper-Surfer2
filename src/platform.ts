import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  Service,
} from 'homebridge';

import { AiperClient } from './aiperClient.js';
import { SurferPlatformAccessory } from './platformAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { formatSurferModelName } from './surferState.js';
import type {
  AiperSurferPlatformConfig,
  CompanionAccessoryRole,
  DiscoveredAiperDevice,
  SurferAccessoryContext,
} from './types.js';

export class AiperSurferPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly aiperClient: AiperClient;

  public readonly cachedAccessories = new Map<string, PlatformAccessory<SurferAccessoryContext>>();
  private readonly activeHandlers = new Map<string, SurferPlatformAccessory>();
  private readonly dynamicTempRegistered = new Set<string>();
  private startupRetryTimer?: ReturnType<typeof setTimeout>;

  constructor(
    public readonly log: Logging,
    public readonly config: AiperSurferPlatformConfig,
    public readonly api: API,
  ) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;

    this.aiperClient = new AiperClient(
      {
        email: this.config.email,
        password: this.config.password,
        region: this.config.region ?? 'auto',
        deviceId: this.config.deviceId,
        pollIntervalSeconds: this.config.pollIntervalSeconds,
        debugMqtt: this.config.debugMqtt,
      },
      this.log,
    );

    this.api.on('didFinishLaunching', () => {
      void this.initializePlatform();
    });

    this.api.on('shutdown', () => {
      if (this.startupRetryTimer) {
        clearTimeout(this.startupRetryTimer);
        this.startupRetryTimer = undefined;
      }
      for (const handler of this.activeHandlers.values()) {
        handler.dispose();
      }
      this.activeHandlers.clear();
      void this.aiperClient.shutdown();
    });
  }

  public configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Restoring cached HomeKit accessory:', accessory.displayName);
    this.cachedAccessories.set(
      accessory.UUID,
      accessory as PlatformAccessory<SurferAccessoryContext>,
    );
  }

  private async initializePlatform(): Promise<void> {
    if (!this.config.email?.trim() || !this.config.password) {
      this.log.warn(
        'Aiper Surfer S2 plugin is not yet configured. Add your Aiper email and password in Homebridge settings.',
      );
      return;
    }

    try {
      const devices = await this.aiperClient.start();
      this.syncDevicesToHomeKit(devices);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log.warn(
        `Aiper Cloud unavailable at startup (${msg}). Restoring cached HomeKit accessories and retrying in 60s.`,
      );
      this.restoreFromCacheOnly();
      this.scheduleStartupRetry();
    }
  }

  private scheduleStartupRetry(): void {
    if (this.startupRetryTimer) {
      clearTimeout(this.startupRetryTimer);
    }
    this.startupRetryTimer = setTimeout(() => {
      this.startupRetryTimer = undefined;
      void this.initializePlatform();
    }, 60_000);
    this.startupRetryTimer.unref?.();
  }

  private restoreFromCacheOnly(): void {
    for (const [uuid, accessory] of this.cachedAccessories) {
      if (!accessory.context?.sn || !accessory.context?.role) {
        continue;
      }
      if (!this.activeHandlers.has(uuid)) {
        const handler = new SurferPlatformAccessory(this, accessory);
        this.activeHandlers.set(uuid, handler);
      }
    }
  }

  public syncDevicesToHomeKit(devices: DiscoveredAiperDevice[]): void {
    const validUuids = new Set<string>();

    for (const dev of devices) {
      const state = this.aiperClient.getState(dev.sn);
      const baseName = dev.name || 'Aiper Surfer S2';
      const model = state?.model ?? formatSurferModelName(dev.model || 'Surfer S2');
      const firmwareVersion = state?.firmwareVersion ?? dev.fwMain ?? '1.0.0';

      const desiredRoles = this.resolveDesiredRoles(dev.sn, baseName);

      for (const spec of desiredRoles) {
        const uuid = this.buildAccessoryUuid(dev.sn, spec.role);
        validUuids.add(uuid);

        this.upsertAccessory({
          uuid,
          sn: dev.sn,
          role: spec.role,
          displayName: spec.displayName,
          model,
          firmwareVersion,
        });

        if (spec.role === 'waterTemperature') {
          this.dynamicTempRegistered.add(dev.sn);
        }
      }

      // If water temperature is set to "auto" and not yet present in initial snapshot,
      // dynamically register the TemperatureSensor as soon as MQTT reports `temp`.
      const tempMode = this.config.exposeWaterTemperature ?? 'auto';
      if (tempMode === 'auto' && !this.dynamicTempRegistered.has(dev.sn)) {
        this.aiperClient.onStateUpdate(dev.sn, (nextState) => {
          if (nextState.waterTemperatureCelsius !== undefined && !this.dynamicTempRegistered.has(dev.sn)) {
            this.dynamicTempRegistered.add(dev.sn);
            const tempUuid = this.buildAccessoryUuid(dev.sn, 'waterTemperature');
            this.upsertAccessory({
              uuid: tempUuid,
              sn: dev.sn,
              role: 'waterTemperature',
              displayName: `${baseName} Water Temperature`,
              model: nextState.model,
              firmwareVersion: nextState.firmwareVersion,
            });
          }
        });
      }
    }

    // Prune stale cached accessories when at least one device was discovered
    if (devices.length > 0) {
      for (const [uuid, cached] of this.cachedAccessories) {
        if (!validUuids.has(uuid)) {
          this.log.info('Removing unselected/stale HomeKit accessory:', cached.displayName);
          this.activeHandlers.get(uuid)?.dispose();
          this.activeHandlers.delete(uuid);
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [cached]);
          this.cachedAccessories.delete(uuid);
        }
      }
    }
  }

  private resolveDesiredRoles(
    sn: string,
    baseName: string,
  ): Array<{ role: CompanionAccessoryRole; displayName: string }> {
    const roles: Array<{ role: CompanionAccessoryRole; displayName: string }> = [
      { role: 'main', displayName: baseName },
    ];

    if (this.config.exposeCleanPathSwitch !== false) {
      roles.push({ role: 'cleanPath', displayName: `${baseName} Adaptive Path` });
    }

    if (this.config.exposeWarningSensor !== false) {
      roles.push({ role: 'warning', displayName: `${baseName} Alert` });
    }

    if (this.config.exposeSolarSensor === true) {
      roles.push({ role: 'solar', displayName: `${baseName} Solar Charging` });
    }

    const tempSetting = this.config.exposeWaterTemperature ?? 'auto';
    const currentTemp = this.aiperClient.getState(sn)?.waterTemperatureCelsius;
    if (tempSetting === 'always' || (tempSetting === 'auto' && currentTemp !== undefined)) {
      roles.push({ role: 'waterTemperature', displayName: `${baseName} Water Temperature` });
    }

    if (this.config.enableDoorbellAlerts === true) {
      roles.push({ role: 'cycleCompleteDoorbell', displayName: `${baseName} Finished Skimming` });
      roles.push({ role: 'warningDoorbell', displayName: `${baseName} Needs Attention` });
    }

    return roles;
  }

  private buildAccessoryUuid(sn: string, role: CompanionAccessoryRole): string {
    return this.api.hap.uuid.generate(`aiper-surfer2:${sn}:${role}`);
  }

  private upsertAccessory(params: {
    uuid: string;
    sn: string;
    role: CompanionAccessoryRole;
    displayName: string;
    model: string;
    firmwareVersion: string;
  }): void {
    const context: SurferAccessoryContext = {
      sn: params.sn,
      role: params.role,
      displayName: params.displayName,
      model: params.model,
      firmwareVersion: params.firmwareVersion,
    };

    const existing = this.cachedAccessories.get(params.uuid);
    if (existing) {
      existing.context = context;
      this.api.updatePlatformAccessories([existing]);
      this.activeHandlers.get(params.uuid)?.dispose();
      this.activeHandlers.set(params.uuid, new SurferPlatformAccessory(this, existing));
      return;
    }

    this.log.info('Registering new HomeKit accessory:', params.displayName);
    const created = new this.api.platformAccessory<SurferAccessoryContext>(
      params.displayName,
      params.uuid,
    );
    created.context = context;
    this.cachedAccessories.set(params.uuid, created);
    this.activeHandlers.set(params.uuid, new SurferPlatformAccessory(this, created));
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [created]);
  }
}

