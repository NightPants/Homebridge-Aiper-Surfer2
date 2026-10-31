import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AiperBaseStatus,
  applyConsumablesToState,
  applyMqttPayloadToState,
  createInitialSurferState,
  extractBaseStatus,
  extractWarningInfo,
  isStatusRunning,
  isSurferDevice,
  normalizeCleanPath,
  parseConsumablesPayload,
  parseMachineReportString,
  resolveSurferMode,
  sanitizeHomeKitFirmwareVersion,
} from '../src/surferState.js';
import type { DiscoveredAiperDevice } from '../src/types.js';

function createFixtureDevice(overrides: Record<string, unknown> = {}): DiscoveredAiperDevice {
  const raw: Record<string, unknown> = {
    sn: '5399887766554433',
    name: 'Pool Skimmer',
    model: 'Surfer_S2',
    machineStatus: 128,
    mode: 5,
    battLevel: 76,
    solar_status: 0,
    in_water: 1,
    online: 1,
    fw_main: 'V1.4.2',
    ...overrides,
  };

  return {
    sn: String(raw.sn),
    name: String(raw.name),
    model: String(raw.model),
    fwMain: '1.4.2',
    raw,
  };
}

describe('Surfer S2 Telemetry & State Normalization', () => {
  it('masks Surfer S2 high-bit status codes (0x80 | base) accurately', () => {
    assert.equal(extractBaseStatus(128), AiperBaseStatus.IDLE);
    assert.equal(isStatusRunning(128), false);

    assert.equal(extractBaseStatus(129), AiperBaseStatus.CLEANING);
    assert.equal(isStatusRunning(129), true);

    assert.equal(extractBaseStatus(130), AiperBaseStatus.RETURNING);
    assert.equal(isStatusRunning(130), true);

    assert.equal(extractBaseStatus(131), AiperBaseStatus.CHARGING);
    assert.equal(isStatusRunning(131), false);

    assert.equal(extractBaseStatus(133), AiperBaseStatus.ERROR);
    assert.equal(isStatusRunning(133), false);
  });

  it('normalizes Surfer S2 mode=5 while stopped (status=128) to Off (0)', () => {
    assert.deepEqual(resolveSurferMode(5, false), { effectiveMode: 0, modeLabel: 'Off' });
    assert.deepEqual(resolveSurferMode(1, true), { effectiveMode: 1, modeLabel: 'Manual' });
    assert.deepEqual(resolveSurferMode(5, true), { effectiveMode: 5, modeLabel: 'Scheduled' });

    const initial = createInitialSurferState(createFixtureDevice({ machineStatus: 128, mode: 5 }));
    assert.equal(initial.running, false);
    assert.equal(initial.effectiveMode, 0);
    assert.equal(initial.modeLabel, 'Off');
    assert.equal(initial.statusLabel, 'Idle');
    assert.equal(initial.model, 'Surfer S2');
  });

  it('preserves solar charging when floating in water (solar_status=1, in_water=1)', () => {
    const initial = createInitialSurferState(createFixtureDevice());
    const { nextState, recognized } = applyMqttPayloadToState(
      initial,
      '$aws/things/5399887766554433/shadow/get/accepted',
      {
        state: {
          reported: {
            NetStat: { online: 1, sta: 2, ble: 0 },
            Machine: {
              status: 129,
              mode: 1,
              cap: 92,
              solar_status: 1,
              in_water: 1,
              temp: 28.5,
              run_time: 1450,
            },
          },
          desired: {
            Machine: {
              cleanPath: 1,
            },
          },
        },
      },
    );

    assert.equal(recognized, true);
    assert.equal(nextState.running, true);
    assert.equal(nextState.statusLabel, 'Skimming');
    assert.equal(nextState.modeLabel, 'Manual');
    assert.equal(nextState.battery, 92);
    assert.equal(nextState.solarCharging, true);
    assert.equal(nextState.dcCharging, false);
    assert.equal(nextState.charging, true);
    assert.equal(nextState.inWater, true);
    assert.equal(nextState.waterTemperatureCelsius, 28.5);
    assert.equal(nextState.runtimeHours, 14.5);
    assert.equal(nextState.cleanPath, 1);
    assert.equal(nextState.cleanPathLabel, 'Adaptive');
  });

  it('parses upChan AT report strings (+INFO, +WARN, +MODE)', () => {
    const infoReport = parseMachineReportString('+INFO:128,5,38,0,285,1,0');
    assert.equal(infoReport.status, 128);
    assert.equal(infoReport.mode, 5);
    assert.equal(infoReport.cap, 38);
    assert.equal(infoReport.warn, 0);
    assert.equal(infoReport.run_time, 285);
    assert.equal(infoReport.in_water, 1);

    const warnReport = parseMachineReportString('+WARN:1,3\r\n+MODE:1');
    assert.equal(warnReport.warn, 1);
    assert.equal(warnReport.warn_code, 3);
    assert.equal(warnReport.mode, 1);

    const initial = createInitialSurferState(createFixtureDevice({ machineStatus: 129, mode: 1 }));
    const { nextState, recognized } = applyMqttPayloadToState(
      initial,
      'aiper/things/5399887766554433/upChan',
      {
        type: 'Machine',
        data: {
          sn: '5399887766554433',
          report: '+INFO:128,5,64,1,300,1,3',
        },
      },
    );

    assert.equal(recognized, true);
    assert.equal(nextState.running, false);
    assert.equal(nextState.modeLabel, 'Off');
    assert.equal(nextState.battery, 64);
    assert.equal(nextState.hasWarning, true);
    assert.deepEqual(nextState.warningCodes, ['e3']);
    assert.match(nextState.warningMessage, /Debris Basket \/ Filter Full/);
  });

  it('extracts warning codes and suppresses warnings while offline', () => {
    const onlineWarn = extractWarningInfo({ warn: 1, warn_codes: [1, 'E3'] }, true, AiperBaseStatus.IDLE);
    assert.equal(onlineWarn.hasWarning, true);
    assert.deepEqual(onlineWarn.warningCodes, ['e1', 'e3']);
    assert.equal(onlineWarn.warningMessage, 'Stuck (E1), Debris Basket / Filter Full (E3)');

    const offlineWarn = extractWarningInfo({ warn: 1, warn_code: 3 }, false, AiperBaseStatus.ERROR);
    assert.equal(offlineWarn.hasWarning, false);
    assert.deepEqual(offlineWarn.warningCodes, []);
  });

  it('parses Surfer S2 Propeller and MicroMesh Filter consumables', () => {
    const rawResponse = {
      code: 0,
      data: {
        list: [
          {
            consumablesName: 'Propeller',
            usePercentage: 15,
            componentReplaceRemainHour: 170,
          },
          {
            consumablesName: 'MicroMesh Filter',
            usePercentage: 92,
            componentReplaceRemainHour: 8,
          },
        ],
      },
    };

    const parsed = parseConsumablesPayload(rawResponse);
    assert.equal(parsed.length, 2);

    const initial = createInitialSurferState(createFixtureDevice());
    const updated = applyConsumablesToState(initial, parsed);

    assert.equal(updated.propeller?.percentLeft, 85);
    assert.equal(updated.microMeshFilter?.percentLeft, 8);
    assert.equal(updated.lowestConsumablePercent, 8);
  });

  it('normalizes Clean Path values, model detection, and HomeKit firmware versions', () => {
    assert.equal(normalizeCleanPath(0), 0);
    assert.equal(normalizeCleanPath(-1), 0);
    assert.equal(normalizeCleanPath(1), 1);
    assert.equal(normalizeCleanPath('Adaptive'), 1);
    assert.equal(normalizeCleanPath('S-shaped'), 0);
    assert.equal(normalizeCleanPath(99), undefined);

    assert.equal(isSurferDevice({ model: 'Surfer_S2' }), true);
    assert.equal(isSurferDevice({ productName: 'Aiper Surfer S1' }), true);
    assert.equal(isSurferDevice({ model: 'Scuba S1 Pro' }), false);

    assert.equal(sanitizeHomeKitFirmwareVersion('V1.12'), '1.12.0');
    assert.equal(sanitizeHomeKitFirmwareVersion('v2.0.5-beta'), '2.0.5');
    assert.equal(sanitizeHomeKitFirmwareVersion(undefined), '1.0.0');
  });
});
