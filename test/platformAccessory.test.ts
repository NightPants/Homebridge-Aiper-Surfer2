import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CharacteristicValue, PlatformAccessory } from 'homebridge';

import type { AiperSurferPlatform } from '../src/platform.js';
import { SurferPlatformAccessory } from '../src/platformAccessory.js';
import { createInitialSurferState } from '../src/surferState.js';
import type {
  AiperSurferPlatformConfig,
  SurferAccessoryContext,
  SurferCleanPath,
  SurferState,
} from '../src/types.js';

class MockCharacteristic {
  public value: CharacteristicValue | undefined;
  public props: Record<string, unknown> = {};
  private getter?: () => CharacteristicValue | Promise<CharacteristicValue>;
  private setter?: (val: CharacteristicValue) => void | Promise<void>;

  public onGet(fn: () => CharacteristicValue | Promise<CharacteristicValue>): this {
    this.getter = fn;
    return this;
  }

  public onSet(fn: (val: CharacteristicValue) => void | Promise<void>): this {
    this.setter = fn;
    return this;
  }

  public setProps(props: Record<string, unknown>): this {
    this.props = { ...this.props, ...props };
    return this;
  }

  public async triggerGet(): Promise<CharacteristicValue | undefined> {
    return this.getter ? await this.getter() : this.value;
  }

  public async triggerSet(val: CharacteristicValue): Promise<void> {
    if (this.setter) {
      await this.setter(val);
    }
    this.value = val;
  }
}

class MockService {
  public readonly characteristics = new Map<unknown, MockCharacteristic>();

  constructor(
    public readonly type: unknown,
    public readonly displayName?: string,
  ) {}

  public setCharacteristic(charType: unknown, value: CharacteristicValue): this {
    const ch = this.getCharacteristic(charType);
    ch.value = value;
    return this;
  }

  public updateCharacteristic(charType: unknown, value: CharacteristicValue): this {
    const ch = this.getCharacteristic(charType);
    ch.value = value;
    return this;
  }

  public getCharacteristic(charType: unknown): MockCharacteristic {
    let ch = this.characteristics.get(charType);
    if (!ch) {
      ch = new MockCharacteristic();
      this.characteristics.set(charType, ch);
    }
    return ch;
  }
}

class MockPlatformAccessory {
  public readonly services = new Map<unknown, MockService>();

  constructor(
    public readonly displayName: string,
    public readonly UUID: string,
    public context: SurferAccessoryContext,
  ) {}

  public getService(serviceType: unknown): MockService | undefined {
    return this.services.get(serviceType);
  }

  public addService(serviceType: unknown, name?: string): MockService {
    const svc = new MockService(serviceType, name);
    this.services.set(serviceType, svc);
    return svc;
  }

  public removeService(service: MockService): void {
    this.services.delete(service.type);
  }
}

const FakeServiceTypes = {
  AccessoryInformation: 'AccessoryInformation',
  Switch: 'Switch',
  Fanv2: 'Fanv2',
  Battery: 'Battery',
  FilterMaintenance: 'FilterMaintenance',
  ContactSensor: 'ContactSensor',
  OccupancySensor: 'OccupancySensor',
  TemperatureSensor: 'TemperatureSensor',
  Doorbell: 'Doorbell',
};

const FakeCharacteristics = {
  Manufacturer: 'Manufacturer',
  Model: 'Model',
  SerialNumber: 'SerialNumber',
  FirmwareRevision: 'FirmwareRevision',
  Name: 'Name',
  ConfiguredName: 'ConfiguredName',
  On: 'On',
  Active: Object.assign('Active', { INACTIVE: 0, ACTIVE: 1 }),
  CurrentFanState: Object.assign('CurrentFanState', { INACTIVE: 0, IDLE: 1, BLOWING_AIR: 2 }),
  TargetFanState: Object.assign('TargetFanState', { MANUAL: 0, AUTO: 1 }),
  StatusFault: Object.assign('StatusFault', { NO_FAULT: 0, GENERAL_FAULT: 1 }),
  BatteryLevel: 'BatteryLevel',
  ChargingState: Object.assign('ChargingState', { NOT_CHARGING: 0, CHARGING: 1 }),
  StatusLowBattery: Object.assign('StatusLowBattery', { BATTERY_LEVEL_NORMAL: 0, BATTERY_LEVEL_LOW: 1 }),
  FilterLifeLevel: 'FilterLifeLevel',
  FilterChangeIndication: Object.assign('FilterChangeIndication', { FILTER_OK: 0, CHANGE_FILTER: 1 }),
  ContactSensorState: Object.assign('ContactSensorState', { CONTACT_DETECTED: 0, CONTACT_NOT_DETECTED: 1 }),
  OccupancyDetected: Object.assign('OccupancyDetected', { OCCUPANCY_NOT_DETECTED: 0, OCCUPANCY_DETECTED: 1 }),
  CurrentTemperature: 'CurrentTemperature',
  StatusActive: 'StatusActive',
  ProgrammableSwitchEvent: Object.assign('ProgrammableSwitchEvent', { SINGLE_PRESS: 0 }),
};

function createTestHarness(configOverrides: Partial<AiperSurferPlatformConfig> = {}) {
  const sn = '5311223344556677';
  let currentState: SurferState = createInitialSurferState({
    sn,
    name: 'Pool Skimmer',
    model: 'Surfer_S2',
    fwMain: '1.3.0',
    raw: {
      sn,
      name: 'Pool Skimmer',
      model: 'Surfer_S2',
      machineStatus: 128,
      mode: 5,
      battLevel: 85,
      solar_status: 1,
      online: 1,
    },
  });

  const listeners = new Set<(state: SurferState) => void>();
  const runningCalls: boolean[] = [];
  const cleanPathCalls: SurferCleanPath[] = [];

  class FakeHapStatusError extends Error {
    constructor(public readonly hapStatus: number) {
      super(`HAP error ${hapStatus}`);
    }
  }

  const platformMock = {
    Service: FakeServiceTypes,
    Characteristic: FakeCharacteristics,
    config: {
      platform: 'AiperSurfer2',
      name: 'Aiper Surfer S2',
      accessoryType: 'switch',
      lowBatteryThreshold: 20,
      ...configOverrides,
    },
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    api: {
      hap: {
        HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
        HapStatusError: FakeHapStatusError,
      },
    },
    aiperClient: {
      getState: () => currentState,
      onStateUpdate: (_targetSn: string, fn: (st: SurferState) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      onCycleComplete: () => () => undefined,
      onWarningTriggered: () => () => undefined,
      setRunning: async (_targetSn: string, running: boolean) => {
        runningCalls.push(running);
        currentState = { ...currentState, running };
        return true;
      },
      setCleanPath: async (_targetSn: string, cleanPath: SurferCleanPath) => {
        cleanPathCalls.push(cleanPath);
        currentState = {
          ...currentState,
          cleanPath,
          cleanPathLabel: cleanPath === 1 ? 'Adaptive' : 'S-Shaped',
        };
        return true;
      },
    },
  } as unknown as AiperSurferPlatform;

  const pushState = (patch: Partial<SurferState>) => {
    currentState = { ...currentState, ...patch };
    for (const listener of listeners) {
      listener(currentState);
    }
  };

  return {
    sn,
    platformMock,
    runningCalls,
    cleanPathCalls,
    pushState,
  };
}

describe('SurferPlatformAccessory HomeKit Mapping', () => {
  it('exposes Switch, solar-aware Battery, and FilterMaintenance on main accessory', async () => {
    const { sn, platformMock, runningCalls, pushState } = createTestHarness({
      accessoryType: 'switch',
    });

    const acc = new MockPlatformAccessory('Pool Skimmer', 'uuid-main', {
      sn,
      role: 'main',
      displayName: 'Pool Skimmer',
      model: 'Surfer S2',
      firmwareVersion: '1.3.0',
    });

    const handler = new SurferPlatformAccessory(
      platformMock,
      acc as unknown as PlatformAccessory<SurferAccessoryContext>,
    );

    const swService = acc.getService(FakeServiceTypes.Switch)!;
    const batteryService = acc.getService(FakeServiceTypes.Battery)!;
    const filterService = acc.getService(FakeServiceTypes.FilterMaintenance)!;

    assert.ok(swService);
    assert.ok(batteryService);
    assert.ok(filterService);

    assert.equal(await swService.getCharacteristic(FakeCharacteristics.On).triggerGet(), false);
    assert.equal(
      await batteryService.getCharacteristic(FakeCharacteristics.ChargingState).triggerGet(),
      FakeCharacteristics.ChargingState.CHARGING,
    );

    await swService.getCharacteristic(FakeCharacteristics.On).triggerSet(true);
    assert.deepEqual(runningCalls, [true]);

    // Push debris basket full warning (e3) + low battery
    pushState({
      running: false,
      battery: 15,
      hasWarning: true,
      warningCodes: ['e3'],
      warningMessage: 'Debris Basket / Filter Full (E3)',
      lowestConsumablePercent: 45,
    });

    assert.equal(
      batteryService.getCharacteristic(FakeCharacteristics.StatusLowBattery).value,
      FakeCharacteristics.StatusLowBattery.BATTERY_LEVEL_LOW,
    );
    assert.equal(
      filterService.getCharacteristic(FakeCharacteristics.FilterChangeIndication).value,
      FakeCharacteristics.FilterChangeIndication.CHANGE_FILTER,
    );

    handler.dispose();
  });

  it('maps Fanv2 Active, CurrentFanState, and TargetFanState (Adaptive vs S-Shaped)', async () => {
    const { sn, platformMock, runningCalls, cleanPathCalls } = createTestHarness({
      accessoryType: 'fan',
    });

    const acc = new MockPlatformAccessory('Pool Skimmer', 'uuid-fan', {
      sn,
      role: 'main',
      displayName: 'Pool Skimmer',
      model: 'Surfer S2',
      firmwareVersion: '1.3.0',
    });

    const handler = new SurferPlatformAccessory(
      platformMock,
      acc as unknown as PlatformAccessory<SurferAccessoryContext>,
    );

    const fan = acc.getService(FakeServiceTypes.Fanv2)!;
    assert.ok(fan);

    await fan.getCharacteristic(FakeCharacteristics.Active).triggerSet(1);
    assert.deepEqual(runningCalls, [true]);

    await fan.getCharacteristic(FakeCharacteristics.TargetFanState).triggerSet(1);
    assert.deepEqual(cleanPathCalls, [1]);
    assert.equal(
      await fan.getCharacteristic(FakeCharacteristics.TargetFanState).triggerGet(),
      FakeCharacteristics.TargetFanState.AUTO,
    );

    handler.dispose();
  });

  it('supports Clean Path Switch, Warning ContactSensor, and Solar OccupancySensor companions', async () => {
    const { sn, platformMock, cleanPathCalls, pushState } = createTestHarness();

    const cleanAcc = new MockPlatformAccessory('Pool Skimmer Adaptive Path', 'uuid-cp', {
      sn,
      role: 'cleanPath',
      displayName: 'Pool Skimmer Adaptive Path',
      model: 'Surfer S2',
      firmwareVersion: '1.3.0',
    });
    const warnAcc = new MockPlatformAccessory('Pool Skimmer Alert', 'uuid-warn', {
      sn,
      role: 'warning',
      displayName: 'Pool Skimmer Alert',
      model: 'Surfer S2',
      firmwareVersion: '1.3.0',
    });
    const solarAcc = new MockPlatformAccessory('Pool Skimmer Solar Charging', 'uuid-solar', {
      sn,
      role: 'solar',
      displayName: 'Pool Skimmer Solar Charging',
      model: 'Surfer S2',
      firmwareVersion: '1.3.0',
    });

    const cleanHandler = new SurferPlatformAccessory(
      platformMock,
      cleanAcc as unknown as PlatformAccessory<SurferAccessoryContext>,
    );
    const warnHandler = new SurferPlatformAccessory(
      platformMock,
      warnAcc as unknown as PlatformAccessory<SurferAccessoryContext>,
    );
    const solarHandler = new SurferPlatformAccessory(
      platformMock,
      solarAcc as unknown as PlatformAccessory<SurferAccessoryContext>,
    );

    await cleanAcc.getService(FakeServiceTypes.Switch)!
      .getCharacteristic(FakeCharacteristics.On)
      .triggerSet(true);
    assert.deepEqual(cleanPathCalls, [1]);

    pushState({ hasWarning: true, solarCharging: false });
    assert.equal(
      warnAcc.getService(FakeServiceTypes.ContactSensor)!
        .getCharacteristic(FakeCharacteristics.ContactSensorState).value,
      FakeCharacteristics.ContactSensorState.CONTACT_NOT_DETECTED,
    );
    assert.equal(
      solarAcc.getService(FakeServiceTypes.OccupancySensor)!
        .getCharacteristic(FakeCharacteristics.OccupancyDetected).value,
      FakeCharacteristics.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
    );

    cleanHandler.dispose();
    warnHandler.dispose();
    solarHandler.dispose();
  });
});

