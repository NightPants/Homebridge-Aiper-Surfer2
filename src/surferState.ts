import type {
  DiscoveredAiperDevice,
  SurferCleanPath,
  SurferConsumableStatus,
  SurferModeContext,
  SurferState,
} from './types.js';

/**
 * Surfer S2 sets bit 7 (0x80 = 128) on Machine.status while carrying the
 * operational status in the lower 7 bits (0x7F):
 * - 128 (0x80 | 0): Idle / Stopped
 * - 129 (0x80 | 1): Skimming / Cleaning
 * - 130 (0x80 | 2): Returning
 * - 131 (0x80 | 3): Charging
 * - 132 (0x80 | 4): Charged
 * - 133 (0x80 | 5): Error
 * - 134 (0x80 | 6): Sleeping
 */
export const STATUS_BASE_MASK = 0x7f;

export enum AiperBaseStatus {
  IDLE = 0,
  CLEANING = 1,
  RETURNING = 2,
  CHARGING = 3,
  CHARGED = 4,
  ERROR = 5,
  SLEEPING = 6,
}

const STATUS_LABELS: Record<number, string> = {
  [AiperBaseStatus.IDLE]: 'Idle',
  [AiperBaseStatus.CLEANING]: 'Skimming',
  [AiperBaseStatus.RETURNING]: 'Returning',
  [AiperBaseStatus.CHARGING]: 'Charging',
  [AiperBaseStatus.CHARGED]: 'Charged',
  [AiperBaseStatus.ERROR]: 'Error',
  [AiperBaseStatus.SLEEPING]: 'Sleeping',
};

const KNOWN_WARN_DESCRIPTIONS: Record<string, string> = {
  e1: 'Stuck',
  e2: 'Lifted',
  e3: 'Debris Basket / Filter Full',
  e4: 'Low Battery',
  e5: 'Out of Water',
};

export function coerceInt(value: unknown): number | undefined {
  if (value === null || value === undefined || typeof value === 'boolean') {
    return undefined;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value) : undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^-?\d+$/.test(trimmed)) {
      const parsed = Number.parseInt(trimmed, 10);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
  }
  return undefined;
}

export function coerceNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || typeof value === 'boolean') {
    return undefined;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function coerceBoolean(value: unknown): boolean | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'on', 'online', 'connected'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'off', 'offline', 'disconnected', 'none', ''].includes(normalized)) {
      return false;
    }
  }
  return undefined;
}

/**
 * Extracts the lower 7-bit operational status from raw Aiper status codes.
 */
export function extractBaseStatus(rawStatus: number): number {
  return rawStatus & STATUS_BASE_MASK;
}

/**
 * Returns true when the lower 7-bit status indicates active skimming/movement.
 */
export function isStatusRunning(rawStatus: number): boolean {
  const base = extractBaseStatus(rawStatus);
  return base === AiperBaseStatus.CLEANING || base === AiperBaseStatus.RETURNING;
}

/**
 * Returns a human-readable label for a Surfer status code.
 */
export function getStatusLabel(rawStatus: number, online: boolean): string {
  const running = isStatusRunning(rawStatus);
  if (!online && !running) {
    return 'Offline';
  }
  const base = extractBaseStatus(rawStatus);
  if (!running && (rawStatus & 0x80) !== 0 && base === AiperBaseStatus.IDLE) {
    return 'Idle';
  }
  return STATUS_LABELS[base] ?? `Status ${base}`;
}

/**
 * Normalizes Surfer S2 mode context.
 * Surfer S2 reports `mode=5` when stopped (`status=128`); when not running,
 * effective mode is normalized to `0` (`Off`), matching verified hardware behavior.
 */
export function resolveSurferMode(rawMode: number, running: boolean): {
  effectiveMode: number;
  modeLabel: SurferModeContext;
} {
  if (!running) {
    return { effectiveMode: 0, modeLabel: 'Off' };
  }
  if (rawMode === 1) {
    return { effectiveMode: 1, modeLabel: 'Manual' };
  }
  if (rawMode === 5) {
    return { effectiveMode: 5, modeLabel: 'Scheduled' };
  }
  if (rawMode === 0) {
    return { effectiveMode: 0, modeLabel: 'Off' };
  }
  return { effectiveMode: rawMode, modeLabel: `Mode ${rawMode}` };
}

/**
 * Normalizes clean-path values (`0` = S-Shaped, `1` = Adaptive, `-1` -> `0`).
 */
export function normalizeCleanPath(value: unknown): SurferCleanPath | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const intVal = coerceInt(value);
  if (intVal !== undefined) {
    if (intVal === -1 || intVal === 0) {
      return 0;
    }
    if (intVal === 1) {
      return 1;
    }
    return undefined;
  }
  if (typeof value === 'string') {
    const norm = value.trim().toLowerCase().replace(/[_-]+/g, ' ');
    if (norm.includes('adaptive')) {
      return 1;
    }
    if (norm.includes('shape') || norm === 's' || norm.startsWith('s ')) {
      return 0;
    }
  }
  return undefined;
}

/**
 * Checks whether a discovered device belongs to the Aiper Surfer family.
 */
export function isSurferDevice(raw: Record<string, unknown>): boolean {
  const candidates = [
    raw.model,
    raw.deviceModel,
    raw.modelName,
    raw.productName,
    raw.name,
    raw.btName,
  ];
  return candidates.some(
    (field) => typeof field === 'string' && field.toLowerCase().includes('surfer'),
  );
}

/**
 * Creates an initial default SurferState from a discovered device record.
 */
export function createInitialSurferState(device: DiscoveredAiperDevice): SurferState {
  const raw = device.raw;
  const rawStatus = coerceInt(raw.machineStatus ?? raw.status) ?? 128;
  const running = isStatusRunning(rawStatus);
  const baseStatus = running ? extractBaseStatus(rawStatus) : (
    extractBaseStatus(rawStatus) === AiperBaseStatus.CHARGING ||
    extractBaseStatus(rawStatus) === AiperBaseStatus.CHARGED ||
    extractBaseStatus(rawStatus) === AiperBaseStatus.ERROR
      ? extractBaseStatus(rawStatus)
      : AiperBaseStatus.IDLE
  );

  const rawMode = coerceInt(raw.mode) ?? 0;
  const { effectiveMode, modeLabel } = resolveSurferMode(rawMode, running);
  const online = coerceBoolean(raw.online) ?? true;
  const battery = clampPercentage(coerceNumber(raw.battLevel ?? raw.battery ?? raw.cap) ?? 100);
  const dcCharging = baseStatus === AiperBaseStatus.CHARGING;
  const solarCharging = coerceInt(raw.solar_status ?? raw.solarStatus) === 1;
  const cleanPath = normalizeCleanPath(raw.cleanPath ?? raw.clean_path) ?? 0;
  const temp = coerceNumber(raw.temp);
  const runTimeRaw = coerceNumber(raw.runTime ?? raw.run_time);

  return {
    sn: device.sn,
    name: device.name,
    model: formatSurferModelName(device.model || device.deviceModel || 'Surfer S2'),
    firmwareVersion: device.fwMain || '1.0.0',
    rawStatus,
    baseStatus,
    statusLabel: getStatusLabel(rawStatus, online),
    running,
    rawMode,
    effectiveMode,
    modeLabel,
    battery,
    dcCharging,
    solarCharging,
    charging: dcCharging || solarCharging,
    cleanPath,
    cleanPathLabel: cleanPath === 1 ? 'Adaptive' : 'S-Shaped',
    online,
    wifiConnected: online,
    bluetoothConnected: false,
    inWater: raw.in_water !== undefined ? coerceBoolean(raw.in_water) : undefined,
    waterTemperatureCelsius: temp,
    runtimeHours: runTimeRaw !== undefined ? Math.round(runTimeRaw) / 100 : undefined,
    hasWarning: baseStatus === AiperBaseStatus.ERROR,
    warningCodes: [],
    warningMessage: baseStatus === AiperBaseStatus.ERROR ? 'Error' : 'No active warnings',
    lastUpdatedAt: Date.now(),
  };
}

/**
 * Parses AT-style report lines emitted on `upChan` (`data.report`),
 * e.g. `+INFO:128,5,38,0,285` or `+WARN:1,3` or `+MODE:1`.
 */
export function parseMachineReportString(report: string): Record<string, number> {
  const parsed: Record<string, number> = {};
  const lines = report
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    if (line.startsWith('+INFO:')) {
      const parts = line
        .slice('+INFO:'.length)
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p.length > 0);

      if (parts.length >= 3) {
        const s = coerceInt(parts[0]);
        const m = coerceInt(parts[1]);
        const c = coerceInt(parts[2]);
        if (s !== undefined) {
          parsed.status = s;
        }
        if (m !== undefined) {
          parsed.mode = m;
        }
        if (c !== undefined) {
          parsed.cap = c;
        }
      }
      if (parts.length >= 4) {
        const w = coerceInt(parts[3]);
        if (w !== undefined) {
          parsed.warn = w;
        }
      }
      if (parts.length >= 5) {
        const rt = coerceInt(parts[4]);
        if (rt !== undefined) {
          parsed.run_time = rt;
        }
      }
      if (parts.length >= 6) {
        const iw = coerceInt(parts[5]);
        if (iw !== undefined) {
          parsed.in_water = iw;
        }
      }
      if (parts.length >= 7) {
        const wc = coerceInt(parts[6]);
        if (wc !== undefined) {
          parsed.warn_code = wc;
        }
      }
    } else if (line.startsWith('+WARN:')) {
      const parts = line
        .slice('+WARN:'.length)
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      if (parts.length >= 1) {
        const w = coerceInt(parts[0]);
        if (w !== undefined) {
          parsed.warn = w;
        }
      }
      if (parts.length >= 2) {
        const wc = coerceInt(parts[1]);
        if (wc !== undefined) {
          parsed.warn_code = wc;
        }
      }
    } else if (line.startsWith('+MODE:') || line.startsWith('+WORKMODE:')) {
      const colonIdx = line.indexOf(':');
      const firstPart = line.slice(colonIdx + 1).split(',')[0]?.trim();
      const m = coerceInt(firstPart);
      if (m !== undefined) {
        parsed.mode = m;
      }
    }
  }

  return parsed;
}

function normalizeWarnCode(value: unknown): string | undefined {
  if (value === null || value === undefined || Array.isArray(value)) {
    return undefined;
  }
  if (typeof value === 'number') {
    const id = Math.trunc(value);
    return id > 0 ? `e${id}` : undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    if (/^\d+$/.test(trimmed)) {
      const id = Number.parseInt(trimmed, 10);
      return id > 0 ? `e${id}` : undefined;
    }
    const match = /^[eE](\d+)$/.exec(trimmed);
    if (match) {
      const id = Number.parseInt(match[1], 10);
      return id > 0 ? `e${id}` : undefined;
    }
    return trimmed.toLowerCase();
  }
  return undefined;
}

export function extractWarningInfo(
  machine: Record<string, unknown>,
  online: boolean,
  baseStatus: number,
): { hasWarning: boolean; warningCodes: string[]; warningMessage: string } {
  if (!online) {
    return {
      hasWarning: false,
      warningCodes: [],
      warningMessage: 'No active warnings',
    };
  }

  const codes: string[] = [];
  const listKeys = [
    'warn_codes',
    'warnCodeList',
    'warning_codes',
    'warningCodes',
    'error_codes',
    'errorCodes',
  ];

  for (const key of listKeys) {
    const candidate = machine[key];
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        const normalized = normalizeWarnCode(item);
        if (normalized && !codes.includes(normalized)) {
          codes.push(normalized);
        }
      }
    }
  }

  const scalarKeys = [
    'warn_code',
    'warnCode',
    'warning_code',
    'warningCode',
    'error_code',
    'errorCode',
  ];

  for (const key of scalarKeys) {
    const normalized = normalizeWarnCode(machine[key]);
    if (normalized && !codes.includes(normalized)) {
      codes.push(normalized);
    }
  }

  // Some firmwares pass numeric warn > 1 directly in `warn` (e.g. warn=3 -> Filter Full)
  const rawWarnInt = coerceInt(machine.warn);
  if (rawWarnInt !== undefined && rawWarnInt > 1 && codes.length === 0) {
    const directCode = normalizeWarnCode(rawWarnInt);
    if (directCode) {
      codes.push(directCode);
    }
  }

  const warnFlag = coerceBoolean(machine.warn) === true;
  const isErrorStatus = baseStatus === AiperBaseStatus.ERROR;
  const hasWarning = warnFlag || codes.length > 0 || isErrorStatus;

  if (!hasWarning) {
    return {
      hasWarning: false,
      warningCodes: [],
      warningMessage: 'No active warnings',
    };
  }

  if (codes.length > 0) {
    const descriptions = codes.map((c) => {
      const label = KNOWN_WARN_DESCRIPTIONS[c];
      return label ? `${label} (${c.toUpperCase()})` : c.toUpperCase();
    });
    return {
      hasWarning: true,
      warningCodes: codes,
      warningMessage: descriptions.join(', '),
    };
  }

  return {
    hasWarning: true,
    warningCodes: [],
    warningMessage: isErrorStatus ? 'Device Error' : 'Active Warning',
  };
}

/**
 * Applies an incoming MQTT payload (shadow `get/accepted`, `update/accepted`,
 * `update/documents`, `shadow/report`, or `upChan`) onto an existing SurferState.
 * Returns `{ nextState, changed }` where `changed` indicates whether state fields updated.
 */
export function applyMqttPayloadToState(
  current: SurferState,
  topic: string,
  payload: Record<string, unknown>,
): { nextState: SurferState; recognized: boolean } {
  const next: SurferState = {
    ...current,
    warningCodes: [...current.warningCodes],
  };

  // Delta messages represent desired intent rather than device-reported state,
  // except cleanPath preference updates.
  if (topic.includes('shadow/update/delta')) {
    const deltaState = asObject(payload.state);
    const deltaMachine = asObject(deltaState?.Machine);
    const deltaCleanPath = normalizeCleanPath(deltaMachine?.cleanPath ?? deltaMachine?.clean_path);
    if (deltaCleanPath !== undefined) {
      next.cleanPath = deltaCleanPath;
      next.cleanPathLabel = deltaCleanPath === 1 ? 'Adaptive' : 'S-Shaped';
      next.lastUpdatedAt = Date.now();
      return { nextState: next, recognized: true };
    }
    return { nextState: current, recognized: false };
  }

  let effectivePayload: Record<string, unknown> = payload;

  if (topic.includes('shadow/update/documents')) {
    const currentDoc = asObject(payload.current);
    const docState = asObject(currentDoc?.state);
    const desiredMachine = asObject(asObject(docState?.desired)?.Machine);
    const desiredCleanPath = normalizeCleanPath(desiredMachine?.cleanPath);
    if (desiredCleanPath !== undefined) {
      next.cleanPath = desiredCleanPath;
      next.cleanPathLabel = desiredCleanPath === 1 ? 'Adaptive' : 'S-Shaped';
    }
    const reported = asObject(docState?.reported);
    if (reported) {
      effectivePayload = reported;
    } else if (docState) {
      effectivePayload = docState;
    }
  } else if (asObject(payload.state)) {
    const stateObj = asObject(payload.state)!;
    for (const candidateKey of ['desired', 'delta']) {
      const candidateMachine = asObject(asObject(stateObj[candidateKey])?.Machine);
      const cp = normalizeCleanPath(candidateMachine?.cleanPath);
      if (cp !== undefined) {
        next.cleanPath = cp;
        next.cleanPathLabel = cp === 1 ? 'Adaptive' : 'S-Shaped';
      }
    }
    const reported = asObject(stateObj.reported);
    if (reported) {
      effectivePayload = reported;
    } else if ('desired' in stateObj || 'delta' in stateObj) {
      // Non-reported desired-only shadow update
      return {
        nextState: next,
        recognized: next.cleanPath !== current.cleanPath,
      };
    } else {
      effectivePayload = stateObj;
    }
  }

  let recognized = false;

  // 1. Extract NetStat updates first so `online` is accurate when evaluating warnings/status.
  let netStat = asObject(effectivePayload.NetStat) ?? asObject(effectivePayload.netstat);
  if (!netStat && effectivePayload.type === 'NetStat') {
    netStat = asObject(effectivePayload.data);
  }
  if (netStat) {
    recognized = true;
    const online = coerceBoolean(netStat.online);
    if (online !== undefined) {
      next.online = online;
      if (!online) {
        next.wifiConnected = false;
        next.bluetoothConnected = false;
      }
    }
    if (next.online) {
      if (netStat.sta !== undefined) {
        next.wifiConnected = ['1', '2'].includes(String(netStat.sta).trim()) || netStat.sta === true;
      } else if (netStat.wifiConnected !== undefined) {
        next.wifiConnected = coerceBoolean(netStat.wifiConnected) ?? next.wifiConnected;
      }
      if (netStat.ble !== undefined) {
        next.bluetoothConnected = coerceBoolean(netStat.ble) ?? false;
      }
    }
  }

  // 2. Extract Machine updates (from shadow `Machine` or `upChan` `type: "Machine"`).
  let machine: Record<string, unknown> | undefined =
    asObject(effectivePayload.Machine) ?? asObject(effectivePayload.machine);

  if (!machine && effectivePayload.type === 'Machine') {
    const rawData = asObject(effectivePayload.data);
    if (rawData) {
      machine = { ...rawData };
      if (typeof rawData.report === 'string') {
        const parsedReport = parseMachineReportString(rawData.report);
        Object.assign(machine, parsedReport);
      }
    }
  }

  if (machine) {
    const status = coerceInt(machine.status);
    const mode = coerceInt(machine.mode);
    const battery = coerceNumber(machine.cap ?? machine.battery);
    const solarRaw = machine.solar_status !== undefined ? machine.solar_status : machine.solarStatus;
    const solarInt = coerceInt(solarRaw);
    const inWater = machine.in_water !== undefined ? coerceBoolean(machine.in_water) : (
      machine.inWater !== undefined ? coerceBoolean(machine.inWater) : undefined
    );
    const temp = coerceNumber(machine.temp);
    const runTime = coerceNumber(machine.run_time ?? machine.runTime);
    const cleanPath = normalizeCleanPath(machine.cleanPath ?? machine.clean_path);

    if (
      status !== undefined ||
      mode !== undefined ||
      battery !== undefined ||
      solarInt !== undefined ||
      inWater !== undefined ||
      temp !== undefined ||
      runTime !== undefined ||
      cleanPath !== undefined ||
      'warn' in machine ||
      'warn_code' in machine ||
      'warnCode' in machine ||
      'warn_codes' in machine ||
      'warnCodeList' in machine
    ) {
      recognized = true;
    }

    if (status !== undefined) {
      next.rawStatus = status;
      next.running = isStatusRunning(status);
      const base = extractBaseStatus(status);
      next.baseStatus = !next.running && base !== AiperBaseStatus.CHARGING &&
        base !== AiperBaseStatus.CHARGED && base !== AiperBaseStatus.ERROR
        ? AiperBaseStatus.IDLE
        : base;
      next.dcCharging = base === AiperBaseStatus.CHARGING;
    }

    if (mode !== undefined) {
      next.rawMode = mode;
    }

    if (status !== undefined || mode !== undefined) {
      const resolved = resolveSurferMode(next.rawMode, next.running);
      next.effectiveMode = resolved.effectiveMode;
      next.modeLabel = resolved.modeLabel;
    }

    if (battery !== undefined) {
      next.battery = clampPercentage(battery);
    }

    if (solarInt !== undefined) {
      next.solarCharging = solarInt === 1;
    }

    // Surfer S2 is a floating solar skimmer: solarCharging can be active while in water!
    next.charging = next.dcCharging || next.solarCharging;

    if (inWater !== undefined) {
      next.inWater = inWater;
    }

    if (temp !== undefined) {
      next.waterTemperatureCelsius = temp;
    }

    if (runTime !== undefined) {
      next.runtimeHours = Math.round(runTime) / 100;
    }

    if (cleanPath !== undefined) {
      next.cleanPath = cleanPath;
      next.cleanPathLabel = cleanPath === 1 ? 'Adaptive' : 'S-Shaped';
    }

    if (
      'warn' in machine ||
      'warn_code' in machine ||
      'warnCode' in machine ||
      'warn_codes' in machine ||
      'warnCodeList' in machine ||
      status !== undefined
    ) {
      const warnSource = (
        'warn' in machine ||
        'warn_code' in machine ||
        'warnCode' in machine ||
        'warn_codes' in machine ||
        'warnCodeList' in machine
      ) ? machine : {};
      const warnInfo = extractWarningInfo(warnSource, next.online, next.baseStatus);
      if (
        'warn' in machine ||
        'warn_code' in machine ||
        'warnCode' in machine ||
        'warn_codes' in machine ||
        'warnCodeList' in machine
      ) {
        next.hasWarning = warnInfo.hasWarning;
        next.warningCodes = warnInfo.warningCodes;
        next.warningMessage = warnInfo.warningMessage;
      } else if (next.baseStatus === AiperBaseStatus.ERROR) {
        next.hasWarning = true;
        if (next.warningMessage === 'No active warnings') {
          next.warningMessage = 'Device Error';
        }
      } else if (!current.hasWarning) {
        next.hasWarning = false;
      }
    }
  }

  // 3. OpInfo (Wi-Fi signal strength) & OtaStatus (firmware version)
  const opInfo = asObject(effectivePayload.OpInfo) ?? (
    effectivePayload.type === 'OpInfo' ? asObject(effectivePayload.data) : undefined
  );
  if (opInfo && next.online) {
    recognized = true;
    const rssi = coerceNumber(opInfo.wifi_rssi);
    if (rssi !== undefined) {
      next.wifiRssi = rssi;
      next.wifiConnected = true;
    }
    if (typeof opInfo.wifi_name === 'string' && opInfo.wifi_name.trim()) {
      next.wifiConnected = true;
    }
  }

  const ota = asObject(effectivePayload.OtaStatus) ?? (
    effectivePayload.type === 'OtaStatus' ? asObject(effectivePayload.data) : undefined
  );
  if (ota) {
    recognized = true;
    if (typeof ota.version === 'string' && ota.version.trim()) {
      next.firmwareVersion = sanitizeHomeKitFirmwareVersion(ota.version);
    }
  }

  next.statusLabel = getStatusLabel(next.rawStatus, next.online);

  if (recognized) {
    next.lastUpdatedAt = Date.now();
  }

  return { nextState: recognized ? next : current, recognized };
}

/**
 * Parses `/poolRobot/getConsumableList` response for Surfer S2 consumables
 * (`Propeller` and `MicroMesh Filter`).
 */
export function parseConsumablesPayload(rawPayload: unknown): SurferConsumableStatus[] {
  const root = asObject(rawPayload);
  let rawList: unknown = root && 'data' in root ? root.data : rawPayload;
  const dataObj = asObject(rawList);
  if (dataObj) {
    for (const key of ['list', 'consumables', 'consumableList', 'consumablesList', 'items']) {
      const candidate = dataObj[key];
      if (Array.isArray(candidate)) {
        rawList = candidate;
        break;
      }
      const nested = asObject(candidate);
      if (nested && Array.isArray(nested.list)) {
        rawList = nested.list;
        break;
      }
    }
  }

  if (!Array.isArray(rawList)) {
    return [];
  }

  const results: SurferConsumableStatus[] = [];

  for (const entry of rawList) {
    const item = asObject(entry);
    if (!item) {
      continue;
    }

    const nameCandidate =
      item.consumablesName ??
      item.consumableName ??
      item.name ??
      item.title ??
      item.consumable ??
      item.type ??
      'Consumable';
    const name = String(nameCandidate).trim();

    const remainingHours = coerceNumber(
      item.componentReplaceRemainHour ??
      item.component_replace_remain_hour ??
      item.componentReplaceRemainHours ??
      item.replaceRemainHour ??
      item.remainHours ??
      item.remainTime ??
      item.remaining,
    );

    let percentLeft: number | undefined;
    const usedPercent = coerceNumber(
      item.usePercentage ?? item.use_percent ?? item.usedPercent ?? item.used_percentage,
    );
    if (usedPercent !== undefined) {
      percentLeft = clampPercentage(100 - usedPercent);
    }

    if (percentLeft === undefined) {
      const directPercent = coerceNumber(
        item.percent ??
        item.remainPercent ??
        item.remainingPercent ??
        item.leftPercent ??
        item.remainPct,
      );
      if (directPercent !== undefined) {
        percentLeft = clampPercentage(directPercent);
      }
    }

    if (percentLeft === undefined && remainingHours !== undefined) {
      const maxHours = coerceNumber(item.longestUseTime ?? item.maxUseTime ?? item.max_time);
      if (maxHours !== undefined && maxHours > 0) {
        percentLeft = clampPercentage((remainingHours / maxHours) * 100);
      }
    }

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'consumable';
    results.push({
      key: slug,
      name,
      percentLeft: percentLeft !== undefined ? Math.round(percentLeft) : undefined,
      remainingHours,
    });
  }

  return results;
}

/**
 * Applies parsed consumables onto a SurferState (`Propeller` & `MicroMesh Filter`).
 */
export function applyConsumablesToState(
  current: SurferState,
  consumables: SurferConsumableStatus[],
): SurferState {
  const propeller = consumables.find((c) => c.name.toLowerCase().includes('propeller'));
  const microMeshFilter = consumables.find((c) => {
    const lower = c.name.toLowerCase();
    return lower.includes('micromesh') || lower.includes('filter') || lower.includes('basket');
  });

  const percentages = [propeller?.percentLeft, microMeshFilter?.percentLeft].filter(
    (v): v is number => v !== undefined,
  );
  const lowestConsumablePercent = percentages.length > 0 ? Math.min(...percentages) : undefined;

  return {
    ...current,
    propeller: propeller ?? current.propeller,
    microMeshFilter: microMeshFilter ?? current.microMeshFilter,
    lowestConsumablePercent: lowestConsumablePercent ?? current.lowestConsumablePercent,
  };
}

export function formatSurferModelName(rawModel: string): string {
  const cleaned = rawModel.trim().replace(/_/g, ' ');
  return cleaned || 'Surfer S2';
}

/**
 * Sanitizes firmware strings (such as `"V1.4.0"`) into HAP-valid `X.Y.Z` format.
 */
export function sanitizeHomeKitFirmwareVersion(rawVersion: string | undefined): string {
  if (!rawVersion) {
    return '1.0.0';
  }
  const match = /(\d+(?:\.\d+){0,2})/.exec(rawVersion);
  if (!match) {
    return '1.0.0';
  }
  const parts = match[1].split('.');
  while (parts.length < 3) {
    parts.push('0');
  }
  return parts.slice(0, 3).join('.');
}

export function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

