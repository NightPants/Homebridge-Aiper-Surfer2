import type {
  CharacteristicValue,
  PlatformAccessory,
  Service,
} from 'homebridge';

import type { AiperSurferPlatform } from './platform.js';
import { DEFAULT_LOW_BATTERY_THRESHOLD } from './settings.js';
import { sanitizeHomeKitFirmwareVersion } from './surferState.js';
import type {
  SurferAccessoryContext,
  SurferCleanPath,
  SurferState,
} from './types.js';

export class SurferPlatformAccessory {
  private primaryService?: Service;
  private batteryService?: Service;
  private filterService?: Service;
  private doorbellTimers: Array<ReturnType<typeof setTimeout>> = [];
  private unsubscribeState?: () => void;
  private unsubscribeCycle?: () => void;
  private unsubscribeWarning?: () => void;

  constructor(
    private readonly platform: AiperSurferPlatform,
    private readonly accessory: PlatformAccessory<SurferAccessoryContext>,
  ) {
    const ctx = this.accessory.context;
    const state = this.platform.aiperClient.getState(ctx.sn);

    this.updateAccessoryInformation(
      ctx.displayName,
      state?.model ?? ctx.model ?? 'Surfer S2',
      ctx.sn,
      state?.firmwareVersion ?? ctx.firmwareVersion ?? '1.0.0',
    );

    switch (ctx.role) {
      case 'main':
        this.setupMainSkimmerAccessory();
        break;
      case 'cleanPath':
        this.setupCleanPathSwitchAccessory();
        break;
      case 'warning':
        this.setupWarningSensorAccessory();
        break;
      case 'solar':
        this.setupSolarSensorAccessory();
        break;
      case 'waterTemperature':
        this.setupWaterTemperatureAccessory();
        break;
      case 'cycleCompleteDoorbell':
        this.setupDoorbellAccessory('cycle');
        break;
      case 'warningDoorbell':
        this.setupDoorbellAccessory('warning');
        break;
    }

    this.unsubscribeState = this.platform.aiperClient.onStateUpdate(ctx.sn, (nextState) => {
      this.applyStateUpdate(nextState);
    });

    if (state) {
      this.applyStateUpdate(state);
    }
  }

  public dispose(): void {
    this.unsubscribeState?.();
    this.unsubscribeCycle?.();
    this.unsubscribeWarning?.();
    for (const timer of this.doorbellTimers) {
      clearTimeout(timer);
    }
    this.doorbellTimers = [];
  }

  private updateAccessoryInformation(
    name: string,
    model: string,
    serialNumber: string,
    firmwareVersion: string,
  ): void {
    const infoService = this.accessory.getService(this.platform.Service.AccessoryInformation)
      ?? this.accessory.addService(this.platform.Service.AccessoryInformation);

    infoService
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Aiper')
      .setCharacteristic(this.platform.Characteristic.Model, model)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, serialNumber)
      .setCharacteristic(
        this.platform.Characteristic.FirmwareRevision,
        sanitizeHomeKitFirmwareVersion(firmwareVersion),
      )
      .setCharacteristic(this.platform.Characteristic.Name, name);
  }

  private setupMainSkimmerAccessory(): void {
    const accessoryType = this.platform.config.accessoryType === 'fan' ? 'fan' : 'switch';
    const displayName = this.accessory.context.displayName;
    const sn = this.accessory.context.sn;

    if (accessoryType === 'fan') {
      const staleSwitch = this.accessory.getService(this.platform.Service.Switch);
      if (staleSwitch) {
        this.accessory.removeService(staleSwitch);
      }

      const fan = this.accessory.getService(this.platform.Service.Fanv2)
        ?? this.accessory.addService(this.platform.Service.Fanv2, displayName);

      this.configureServiceNames(fan, displayName);

      fan.getCharacteristic(this.platform.Characteristic.Active)
        .onGet(() => {
          const st = this.platform.aiperClient.getState(sn);
          return st?.running
            ? this.platform.Characteristic.Active.ACTIVE
            : this.platform.Characteristic.Active.INACTIVE;
        })
        .onSet(async (value: CharacteristicValue) => {
          const targetRunning = value === this.platform.Characteristic.Active.ACTIVE || value === 1 || value === true;
          const ok = await this.platform.aiperClient.setRunning(sn, targetRunning);
          if (!ok) {
            throw new this.platform.api.hap.HapStatusError(
              this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
            );
          }
        });

      fan.getCharacteristic(this.platform.Characteristic.CurrentFanState)
        .onGet(() => {
          const st = this.platform.aiperClient.getState(sn);
          if (!st || !st.online) {
            return this.platform.Characteristic.CurrentFanState.INACTIVE;
          }
          return st.running
            ? this.platform.Characteristic.CurrentFanState.BLOWING_AIR
            : this.platform.Characteristic.CurrentFanState.IDLE;
        });

      // Map TargetFanState: MANUAL (0) = S-Shaped, AUTO (1) = Adaptive
      fan.getCharacteristic(this.platform.Characteristic.TargetFanState)
        .onGet(() => {
          const st = this.platform.aiperClient.getState(sn);
          return st?.cleanPath === 1
            ? this.platform.Characteristic.TargetFanState.AUTO
            : this.platform.Characteristic.TargetFanState.MANUAL;
        })
        .onSet(async (value: CharacteristicValue) => {
          const targetCleanPath: SurferCleanPath =
            value === this.platform.Characteristic.TargetFanState.AUTO || value === 1 ? 1 : 0;
          const ok = await this.platform.aiperClient.setCleanPath(sn, targetCleanPath);
          if (!ok) {
            throw new this.platform.api.hap.HapStatusError(
              this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
            );
          }
        });

      this.primaryService = fan;
    } else {
      const staleFan = this.accessory.getService(this.platform.Service.Fanv2);
      if (staleFan) {
        this.accessory.removeService(staleFan);
      }

      const sw = this.accessory.getService(this.platform.Service.Switch)
        ?? this.accessory.addService(this.platform.Service.Switch, displayName);

      this.configureServiceNames(sw, displayName);

      sw.getCharacteristic(this.platform.Characteristic.On)
        .onGet(() => Boolean(this.platform.aiperClient.getState(sn)?.running))
        .onSet(async (value: CharacteristicValue) => {
          const targetRunning = Boolean(value);
          const ok = await this.platform.aiperClient.setRunning(sn, targetRunning);
          if (!ok) {
            throw new this.platform.api.hap.HapStatusError(
              this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
            );
          }
        });

      this.primaryService = sw;
    }

    // Attach Battery Service (DC + Solar Charging aware)
    this.batteryService = this.accessory.getService(this.platform.Service.Battery)
      ?? this.accessory.addService(this.platform.Service.Battery, `${displayName} Battery`);

    this.batteryService
      .getCharacteristic(this.platform.Characteristic.BatteryLevel)
      .onGet(() => this.platform.aiperClient.getState(sn)?.battery ?? 100);

    this.batteryService
      .getCharacteristic(this.platform.Characteristic.ChargingState)
      .onGet(() => {
        const st = this.platform.aiperClient.getState(sn);
        return st?.charging
          ? this.platform.Characteristic.ChargingState.CHARGING
          : this.platform.Characteristic.ChargingState.NOT_CHARGING;
      });

    this.batteryService
      .getCharacteristic(this.platform.Characteristic.StatusLowBattery)
      .onGet(() => {
        const threshold = this.getLowBatteryThreshold();
        const batt = this.platform.aiperClient.getState(sn)?.battery ?? 100;
        return batt <= threshold
          ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
      });

    // Attach FilterMaintenance Service (MicroMesh Filter & Propeller life + Debris Full alert)
    this.filterService = this.accessory.getService(this.platform.Service.FilterMaintenance)
      ?? this.accessory.addService(this.platform.Service.FilterMaintenance, `${displayName} Filter`);

    this.filterService
      .getCharacteristic(this.platform.Characteristic.FilterLifeLevel)
      .onGet(() => this.platform.aiperClient.getState(sn)?.lowestConsumablePercent ?? 100);

    this.filterService
      .getCharacteristic(this.platform.Characteristic.FilterChangeIndication)
      .onGet(() => {
        const st = this.platform.aiperClient.getState(sn);
        const needsAttention = this.doesFilterNeedAttention(st);
        return needsAttention
          ? this.platform.Characteristic.FilterChangeIndication.CHANGE_FILTER
          : this.platform.Characteristic.FilterChangeIndication.FILTER_OK;
      });
  }

  private setupCleanPathSwitchAccessory(): void {
    const displayName = this.accessory.context.displayName;
    const sn = this.accessory.context.sn;

    const sw = this.accessory.getService(this.platform.Service.Switch)
      ?? this.accessory.addService(this.platform.Service.Switch, displayName);

    this.configureServiceNames(sw, displayName);

    sw.getCharacteristic(this.platform.Characteristic.On)
      .onGet(() => this.platform.aiperClient.getState(sn)?.cleanPath === 1)
      .onSet(async (value: CharacteristicValue) => {
        const target: SurferCleanPath = value ? 1 : 0;
        const ok = await this.platform.aiperClient.setCleanPath(sn, target);
        if (!ok) {
          throw new this.platform.api.hap.HapStatusError(
            this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
          );
        }
      });

    this.primaryService = sw;
  }

  private setupWarningSensorAccessory(): void {
    const displayName = this.accessory.context.displayName;
    const sn = this.accessory.context.sn;

    const sensor = this.accessory.getService(this.platform.Service.ContactSensor)
      ?? this.accessory.addService(this.platform.Service.ContactSensor, displayName);

    this.configureServiceNames(sensor, displayName);

    sensor.getCharacteristic(this.platform.Characteristic.ContactSensorState)
      .onGet(() => {
        const hasWarning = Boolean(this.platform.aiperClient.getState(sn)?.hasWarning);
        return hasWarning
          ? this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
          : this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED;
      });

    sensor.getCharacteristic(this.platform.Characteristic.StatusActive)
      .onGet(() => Boolean(this.platform.aiperClient.getState(sn)?.online ?? true));

    this.primaryService = sensor;
  }

  private setupSolarSensorAccessory(): void {
    const displayName = this.accessory.context.displayName;
    const sn = this.accessory.context.sn;

    const sensor = this.accessory.getService(this.platform.Service.OccupancySensor)
      ?? this.accessory.addService(this.platform.Service.OccupancySensor, displayName);

    this.configureServiceNames(sensor, displayName);

    sensor.getCharacteristic(this.platform.Characteristic.OccupancyDetected)
      .onGet(() => {
        const solar = Boolean(this.platform.aiperClient.getState(sn)?.solarCharging);
        return solar
          ? this.platform.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
          : this.platform.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED;
      });

    sensor.getCharacteristic(this.platform.Characteristic.StatusActive)
      .onGet(() => Boolean(this.platform.aiperClient.getState(sn)?.online ?? true));

    this.primaryService = sensor;
  }

  private setupWaterTemperatureAccessory(): void {
    const displayName = this.accessory.context.displayName;
    const sn = this.accessory.context.sn;

    const sensor = this.accessory.getService(this.platform.Service.TemperatureSensor)
      ?? this.accessory.addService(this.platform.Service.TemperatureSensor, displayName);

    this.configureServiceNames(sensor, displayName);

    sensor.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .setProps({ minValue: -20, maxValue: 65 })
      .onGet(() => {
        const temp = this.platform.aiperClient.getState(sn)?.waterTemperatureCelsius ?? 25;
        return Math.max(-20, Math.min(65, temp));
      });

    sensor.getCharacteristic(this.platform.Characteristic.StatusActive)
      .onGet(() => {
        const st = this.platform.aiperClient.getState(sn);
        return Boolean(st?.online && st.waterTemperatureCelsius !== undefined);
      });

    this.primaryService = sensor;
  }

  private setupDoorbellAccessory(kind: 'cycle' | 'warning'): void {
    const displayName = this.accessory.context.displayName;
    const sn = this.accessory.context.sn;

    const doorbell = this.accessory.getService(this.platform.Service.Doorbell)
      ?? this.accessory.addService(this.platform.Service.Doorbell, displayName);

    this.configureServiceNames(doorbell, displayName);
    this.primaryService = doorbell;

    if (kind === 'cycle') {
      this.unsubscribeCycle = this.platform.aiperClient.onCycleComplete(sn, () => {
        this.ringDoorbell(doorbell, `${displayName} (Skimming Complete)`);
      });
    } else {
      this.unsubscribeWarning = this.platform.aiperClient.onWarningTriggered(sn, (st) => {
        this.ringDoorbell(doorbell, `${displayName} (${st.warningMessage})`);
      });
    }
  }

  private ringDoorbell(doorbell: Service, label: string): void {
    this.platform.log.info(`Triggering HomeKit Doorbell alert: ${label}`);
    const fireOnce = () => {
      doorbell.updateCharacteristic(
        this.platform.Characteristic.ProgrammableSwitchEvent,
        this.platform.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
      );
    };

    fireOnce();
    this.doorbellTimers.push(setTimeout(fireOnce, 4000));
  }

  private applyStateUpdate(state: SurferState): void {
    const ctx = this.accessory.context;
    ctx.model = state.model;
    ctx.firmwareVersion = state.firmwareVersion;

    this.updateAccessoryInformation(
      ctx.displayName,
      state.model,
      ctx.sn,
      state.firmwareVersion,
    );

    switch (ctx.role) {
      case 'main':
        this.updateMainAccessoryCharacteristics(state);
        break;
      case 'cleanPath':
        this.primaryService?.updateCharacteristic(
          this.platform.Characteristic.On,
          state.cleanPath === 1,
        );
        break;
      case 'warning':
        this.primaryService?.updateCharacteristic(
          this.platform.Characteristic.ContactSensorState,
          state.hasWarning
            ? this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
            : this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED,
        );
        this.primaryService?.updateCharacteristic(
          this.platform.Characteristic.StatusActive,
          state.online,
        );
        break;
      case 'solar':
        this.primaryService?.updateCharacteristic(
          this.platform.Characteristic.OccupancyDetected,
          state.solarCharging
            ? this.platform.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
            : this.platform.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
        );
        this.primaryService?.updateCharacteristic(
          this.platform.Characteristic.StatusActive,
          state.online,
        );
        break;
      case 'waterTemperature':
        if (state.waterTemperatureCelsius !== undefined) {
          this.primaryService?.updateCharacteristic(
            this.platform.Characteristic.CurrentTemperature,
            Math.max(-20, Math.min(65, state.waterTemperatureCelsius)),
          );
        }
        this.primaryService?.updateCharacteristic(
          this.platform.Characteristic.StatusActive,
          state.online && state.waterTemperatureCelsius !== undefined,
        );
        break;
      default:
        break;
    }
  }

  private updateMainAccessoryCharacteristics(state: SurferState): void {
    const isFan = this.platform.config.accessoryType === 'fan';

    if (this.primaryService) {
      if (isFan) {
        this.primaryService.updateCharacteristic(
          this.platform.Characteristic.Active,
          state.running
            ? this.platform.Characteristic.Active.ACTIVE
            : this.platform.Characteristic.Active.INACTIVE,
        );
        this.primaryService.updateCharacteristic(
          this.platform.Characteristic.CurrentFanState,
          !state.online
            ? this.platform.Characteristic.CurrentFanState.INACTIVE
            : (state.running
              ? this.platform.Characteristic.CurrentFanState.BLOWING_AIR
              : this.platform.Characteristic.CurrentFanState.IDLE),
        );
        this.primaryService.updateCharacteristic(
          this.platform.Characteristic.TargetFanState,
          state.cleanPath === 1
            ? this.platform.Characteristic.TargetFanState.AUTO
            : this.platform.Characteristic.TargetFanState.MANUAL,
        );
      } else {
        this.primaryService.updateCharacteristic(
          this.platform.Characteristic.On,
          state.running,
        );
      }

      this.primaryService.updateCharacteristic(
        this.platform.Characteristic.StatusFault,
        state.hasWarning
          ? this.platform.Characteristic.StatusFault.GENERAL_FAULT
          : this.platform.Characteristic.StatusFault.NO_FAULT,
      );
    }

    if (this.batteryService) {
      const threshold = this.getLowBatteryThreshold();
      this.batteryService.updateCharacteristic(
        this.platform.Characteristic.BatteryLevel,
        state.battery,
      );
      this.batteryService.updateCharacteristic(
        this.platform.Characteristic.ChargingState,
        state.charging
          ? this.platform.Characteristic.ChargingState.CHARGING
          : this.platform.Characteristic.ChargingState.NOT_CHARGING,
      );
      this.batteryService.updateCharacteristic(
        this.platform.Characteristic.StatusLowBattery,
        state.battery <= threshold
          ? this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : this.platform.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
      );
    }

    if (this.filterService) {
      this.filterService.updateCharacteristic(
        this.platform.Characteristic.FilterLifeLevel,
        state.lowestConsumablePercent ?? 100,
      );
      this.filterService.updateCharacteristic(
        this.platform.Characteristic.FilterChangeIndication,
        this.doesFilterNeedAttention(state)
          ? this.platform.Characteristic.FilterChangeIndication.CHANGE_FILTER
          : this.platform.Characteristic.FilterChangeIndication.FILTER_OK,
      );
    }
  }

  private doesFilterNeedAttention(state: SurferState | undefined): boolean {
    if (!state) {
      return false;
    }
    if (state.warningCodes.includes('e3')) {
      return true;
    }
    return state.lowestConsumablePercent !== undefined && state.lowestConsumablePercent <= 10;
  }

  private getLowBatteryThreshold(): number {
    const raw = this.platform.config.lowBatteryThreshold;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return Math.max(5, Math.min(50, Math.round(raw)));
    }
    return DEFAULT_LOW_BATTERY_THRESHOLD;
  }

  private configureServiceNames(service: Service, name: string): void {
    service.setCharacteristic(this.platform.Characteristic.Name, name);
    if (this.platform.Characteristic.ConfiguredName) {
      service.setCharacteristic(this.platform.Characteristic.ConfiguredName, name);
    }
  }
}

