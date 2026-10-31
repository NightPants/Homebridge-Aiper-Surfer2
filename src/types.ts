import type { PlatformConfig } from 'homebridge';

export type AiperRegionSetting = 'auto' | 'us' | 'eu' | 'asia';
export type AiperResolvedRegion = 'us' | 'eu' | 'asia';
export type SurferAccessoryType = 'switch' | 'fan';
export type WaterTemperatureExposure = 'auto' | 'always' | 'never';

/**
 * Clean-path navigation values verified on Surfer S2:
 * - 0: S-Shaped path (default)
 * - 1: Adaptive path
 */
export type SurferCleanPath = 0 | 1;

/**
 * Read-only cleaning context reported by Surfer S2:
 * - 0: Off / Idle (normalized when base status is not running)
 * - 1: Manual skimming
 * - 5: Scheduled skimming
 */
export type SurferModeContext = 'Off' | 'Manual' | 'Scheduled' | `Mode ${number}`;

export interface AiperSurferPlatformConfig extends PlatformConfig {
  email?: string;
  password?: string;
  region?: AiperRegionSetting;
  deviceId?: string;
  accessoryType?: SurferAccessoryType;
  exposeCleanPathSwitch?: boolean;
  exposeWarningSensor?: boolean;
  exposeSolarSensor?: boolean;
  exposeWaterTemperature?: WaterTemperatureExposure;
  enableDoorbellAlerts?: boolean;
  lowBatteryThreshold?: number;
  pollIntervalSeconds?: number;
  debugMqtt?: boolean;
}

export interface DiscoveredAiperDevice {
  sn: string;
  name: string;
  model: string;
  deviceModel?: string;
  deviceType?: string;
  equipmentId?: number | string;
  zoneId?: string;
  fwMain?: string;
  mcuVersion?: string;
  raw: Record<string, unknown>;
}

export interface SurferConsumableStatus {
  key: string;
  name: string;
  percentLeft?: number;
  remainingHours?: number;
  lastReplacementIso?: string;
}

export interface SurferState {
  sn: string;
  name: string;
  model: string;
  firmwareVersion: string;
  rawStatus: number;
  baseStatus: number;
  statusLabel: string;
  running: boolean;
  rawMode: number;
  effectiveMode: number;
  modeLabel: SurferModeContext;
  battery: number;
  dcCharging: boolean;
  solarCharging: boolean;
  charging: boolean;
  cleanPath: SurferCleanPath;
  cleanPathLabel: 'S-Shaped' | 'Adaptive';
  online: boolean;
  wifiConnected: boolean;
  bluetoothConnected: boolean;
  wifiRssi?: number;
  inWater?: boolean;
  waterTemperatureCelsius?: number;
  runtimeHours?: number;
  hasWarning: boolean;
  warningCodes: string[];
  warningMessage: string;
  propeller?: SurferConsumableStatus;
  microMeshFilter?: SurferConsumableStatus;
  lowestConsumablePercent?: number;
  lastUpdatedAt: number;
}

export type CompanionAccessoryRole =
  | 'main'
  | 'cleanPath'
  | 'warning'
  | 'solar'
  | 'waterTemperature'
  | 'cycleCompleteDoorbell'
  | 'warningDoorbell';

export interface SurferAccessoryContext {
  sn: string;
  role: CompanionAccessoryRole;
  displayName: string;
  model: string;
  firmwareVersion: string;
}

