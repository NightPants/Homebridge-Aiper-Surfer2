import type { Logging } from 'homebridge';
import { auth, io, iot, mqtt } from 'aws-iot-device-sdk-v2';

import {
  AiperCrypto,
  calculateAiperCrc16,
  decodeMqttPayload,
  redactSerial,
} from './aiperCrypto.js';
import {
  AIPER_API_ENDPOINTS,
  DEFAULT_METADATA_REFRESH_MS,
  DEFAULT_POLL_INTERVAL_SECONDS,
} from './settings.js';
import {
  AiperBaseStatus,
  applyConsumablesToState,
  applyMqttPayloadToState,
  asObject,
  clampPercentage,
  coerceBoolean,
  coerceInt,
  coerceNumber,
  createInitialSurferState,
  extractBaseStatus,
  formatSurferModelName,
  getStatusLabel,
  isStatusRunning,
  isSurferDevice,
  normalizeCleanPath,
  parseConsumablesPayload,
  resolveSurferMode,
  sanitizeHomeKitFirmwareVersion,
} from './surferState.js';
import type {
  AiperRegionSetting,
  AiperResolvedRegion,
  DiscoveredAiperDevice,
  SurferCleanPath,
  SurferState,
} from './types.js';

const SESSION_CONFLICT_CODE = '402';
const SESSION_CONFLICT_COOLDOWN_MS = 180 * 1000;
const AWS_CREDENTIALS_TTL_MS = 50 * 60 * 1000;
const MQTT_REBUILD_MIN_INTERVAL_MS = 5 * 60 * 1000;
const REST_MIN_INTERVAL_MS = 800;
const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
const MIN_CYCLE_DURATION_FOR_COMPLETION_MS = 5 * 60 * 1000;

export interface AiperClientOptions {
  email?: string;
  password?: string;
  region?: AiperRegionSetting;
  deviceId?: string;
  pollIntervalSeconds?: number;
  debugMqtt?: boolean;
}

interface PendingAckWaiter {
  resolve: (ack: string | undefined) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class AiperSessionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiperSessionConflictError';
  }
}

export class AiperAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiperAuthenticationError';
  }
}

export class AiperClient {
  private token?: string;
  private baseUrl: string;
  private resolvedRegion?: AiperResolvedRegion;
  private readonly systemTimeZone: string;

  private identityId?: string;
  private openIdToken?: string;
  private openIdTokenExpiresAt = 0;
  private iotEndpoint?: string;
  private awsRegion?: string;
  private awsAccessKeyId?: string;
  private awsSecretAccessKey?: string;
  private awsSessionToken?: string;
  private awsCredentialsExpiresAt = 0;

  private mqttConnection?: mqtt.MqttClientConnection;
  private mqttConnected = false;
  private mqttConnectPromise?: Promise<boolean>;
  private lastMqttActivityAt = 0;
  private lastMqttRebuildAt = 0;
  private subscribedSerials = new Set<string>();

  private sessionConflictUntil = 0;
  private restNextAllowedAt = 0;
  private restQueue: Promise<void> = Promise.resolve();

  private readonly devices = new Map<string, DiscoveredAiperDevice>();
  private readonly states = new Map<string, SurferState>();
  private readonly deviceZoneIds = new Map<string, string>();
  private readonly lastReportedUtcOffsets = new Map<string, string>();
  private readonly lastMetadataRefreshAt = new Map<string, number>();
  private readonly lastMqttFieldAt = new Map<string, number>();

  private readonly ackQueues = new Map<string, string[]>();
  private readonly ackWaiters = new Map<string, PendingAckWaiter[]>();
  private readonly cmdQueues = new Map<string, Promise<unknown>>();
  private readonly lastCommandTimestamps = new Map<string, { key: string; at: number }>();

  private readonly runStartedAt = new Map<string, number>();
  private readonly manualStopRequestedAt = new Map<string, number>();

  private readonly stateListeners = new Map<string, Set<(state: SurferState) => void>>();
  private readonly cycleCompleteListeners = new Map<string, Set<() => void>>();
  private readonly warningListeners = new Map<string, Set<(state: SurferState) => void>>();

  private pollTimer?: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(
    private readonly options: AiperClientOptions,
    private readonly log: Logging,
  ) {
    this.systemTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const initialRegion = this.resolveCandidateRegions()[0];
    this.baseUrl = AIPER_API_ENDPOINTS[initialRegion];
  }

  public getAllStates(): SurferState[] {
    return Array.from(this.states.values());
  }

  public getState(sn: string): SurferState | undefined {
    return this.states.get(sn);
  }

  public getDiscoveredDevices(): DiscoveredAiperDevice[] {
    return Array.from(this.devices.values());
  }

  public isMqttConnected(): boolean {
    return this.mqttConnected && this.mqttConnection !== undefined;
  }

  public onStateUpdate(sn: string, listener: (state: SurferState) => void): () => void {
    let set = this.stateListeners.get(sn);
    if (!set) {
      set = new Set();
      this.stateListeners.set(sn, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  public onCycleComplete(sn: string, listener: () => void): () => void {
    let set = this.cycleCompleteListeners.get(sn);
    if (!set) {
      set = new Set();
      this.cycleCompleteListeners.set(sn, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  public onWarningTriggered(sn: string, listener: (state: SurferState) => void): () => void {
    let set = this.warningListeners.get(sn);
    if (!set) {
      set = new Set();
      this.warningListeners.set(sn, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  /**
   * Authenticates, discovers Surfer S2 devices, fetches metadata, connects AWS IoT MQTT,
   * requests live device shadows, and starts background maintenance polling.
   */
  public async start(): Promise<DiscoveredAiperDevice[]> {
    this.stopped = false;

    if (!this.options.email?.trim() || !this.options.password) {
      this.log.warn('Aiper Surfer S2 setup skipped: email and password must be configured.');
      return [];
    }

    await this.login();
    const discovered = await this.discoverSurferDevices();

    for (const dev of discovered) {
      await this.refreshDeviceMetadata(dev.sn);
    }

    await this.getOpenIdToken(false);
    await this.getAwsCredentials();

    if (discovered.length > 0) {
      const connected = await this.connectMqtt();
      if (connected) {
        for (const dev of discovered) {
          await this.subscribeToDevice(dev.sn);
          await this.requestShadow(dev.sn);
        }
      }
    }

    this.startBackgroundLoop();
    return discovered;
  }

  /**
   * Stops background timers and cleanly disconnects from AWS IoT MQTT.
   */
  public async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    for (const waiters of this.ackWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(undefined);
      }
    }
    this.ackWaiters.clear();

    await this.disconnectMqtt();
  }

  /**
   * Logs in to Aiper Cloud, automatically probing regions when `region` is `"auto"`.
   */
  public async login(): Promise<void> {
    const email = this.options.email?.trim();
    const password = this.options.password;
    if (!email || !password) {
      throw new AiperAuthenticationError('Email or password is missing.');
    }

    const regions = this.resolvedRegion ? [this.resolvedRegion] : this.resolveCandidateRegions();
    let lastError: Error | undefined;

    for (const candidateRegion of regions) {
      const candidateBaseUrl = this.resolvedRegion
        ? this.baseUrl
        : AIPER_API_ENDPOINTS[candidateRegion];

      try {
        const payload = await this.callEncrypted(
          '/login',
          { email, password },
          {
            baseUrlOverride: candidateBaseUrl,
            tokenOverride: '',
            retryAuth: false,
          },
        );

        if (!this.isApiSuccess(payload)) {
          const message = this.extractApiMessage(payload);
          lastError = new AiperAuthenticationError(
            `Aiper login rejected on ${candidateRegion.toUpperCase()} (${message})`,
          );
          continue;
        }

        const data = asObject(payload.data) ?? {};
        const token = typeof data.token === 'string' ? data.token.trim() : '';
        if (!token) {
          lastError = new Error(`Aiper login on ${candidateRegion.toUpperCase()} returned no token.`);
          continue;
        }

        this.token = token;
        this.resolvedRegion = candidateRegion;
        this.baseUrl = candidateBaseUrl;

        if (Array.isArray(data.domain) && typeof data.domain[0] === 'string' && data.domain[0].trim()) {
          this.baseUrl = data.domain[0].trim().replace(/\/+$/, '');
        }

        this.log.info(
          `Authenticated with Aiper Cloud (${candidateRegion.toUpperCase()} -> ${this.baseUrl}).`,
        );
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw lastError ?? new AiperAuthenticationError('Aiper login failed across all candidate regions.');
  }

  /**
   * Discovers Surfer S2 / Surfer family devices (or the explicitly configured `deviceId`).
   */
  public async discoverSurferDevices(): Promise<DiscoveredAiperDevice[]> {
    const payload = await this.callEncrypted('/equipment/getEquipment', {});
    if (!this.isApiSuccess(payload)) {
      throw new Error(`Failed to fetch Aiper equipment list: ${this.extractApiMessage(payload)}`);
    }

    let rawList: unknown[] = [];
    if (Array.isArray(payload.data)) {
      rawList = payload.data;
    } else {
      const dataObj = asObject(payload.data);
      if (dataObj) {
        if (Array.isArray(dataObj.list)) {
          rawList = dataObj.list;
        } else if (Array.isArray(dataObj.equipments)) {
          rawList = dataObj.equipments;
        }
      }
    }

    const parsedAll: DiscoveredAiperDevice[] = [];
    for (const entry of rawList) {
      const raw = asObject(entry);
      if (!raw || typeof raw.sn !== 'string' || !raw.sn.trim()) {
        continue;
      }
      const sn = raw.sn.trim();
      const zoneId = typeof raw.zoneId === 'string' && raw.zoneId.trim()
        ? raw.zoneId.trim()
        : (typeof raw.zone_id === 'string' && raw.zone_id.trim() ? raw.zone_id.trim() : undefined);
      if (zoneId) {
        this.deviceZoneIds.set(sn, zoneId);
      }

      const modelRaw = String(raw.model ?? raw.deviceModel ?? raw.modelName ?? 'Surfer S2').trim();
      const nameRaw = typeof raw.name === 'string' && raw.name.trim()
        ? raw.name.trim()
        : formatSurferModelName(modelRaw);

      parsedAll.push({
        sn,
        name: nameRaw,
        model: modelRaw,
        deviceModel: typeof raw.deviceModel === 'string' ? raw.deviceModel : undefined,
        deviceType: raw.deviceType !== undefined ? String(raw.deviceType) : undefined,
        equipmentId: typeof raw.equipmentId === 'number' || typeof raw.equipmentId === 'string'
          ? raw.equipmentId
          : (typeof raw.id === 'number' || typeof raw.id === 'string' ? raw.id : undefined),
        zoneId,
        fwMain: typeof raw.fw_main === 'string'
          ? sanitizeHomeKitFirmwareVersion(raw.fw_main)
          : undefined,
        raw,
      });
    }

    this.log.info(`Found ${parsedAll.length} device(s) on Aiper account.`);
    for (const d of parsedAll) {
      this.log.info(
        `Aiper account device: name="${d.name}" model="${d.model}" sn=${redactSerial(d.sn)}`,
      );
    }

    const targetId = this.options.deviceId?.trim();
    let selected: DiscoveredAiperDevice[];

    if (targetId) {
      const matched =
        parsedAll.find((d) => d.sn.toLowerCase() === targetId.toLowerCase()) ??
        parsedAll.find((d) => d.name.toLowerCase() === targetId.toLowerCase());

      if (matched) {
        selected = [matched];
      } else {
        this.log.warn(
          `Configured deviceId "${redactSerial(targetId)}" was not found in account list; ` +
          'creating placeholder Surfer S2 entry.',
        );
        selected = [
          {
            sn: targetId,
            name: 'Aiper Surfer S2',
            model: 'Surfer_S2',
            raw: { sn: targetId, model: 'Surfer_S2', name: 'Aiper Surfer S2' },
          },
        ];
      }
    } else {
      const surfers = parsedAll.filter((d) => isSurferDevice(d.raw));
      if (surfers.length > 0) {
        selected = surfers;
      } else if (parsedAll.length === 1) {
        this.log.warn(
          `Model "${parsedAll[0].model}" did not explicitly match "Surfer", ` +
          'but it is the only device on this Aiper account — selecting it.',
        );
        selected = [parsedAll[0]];
      } else {
        this.log.warn(
          'No Surfer family device was auto-detected. Set "deviceId" in plugin settings ' +
          'if your Surfer S2 uses a custom model string.',
        );
        selected = [];
      }
    }

    for (const dev of selected) {
      this.devices.set(dev.sn, dev);
      const existingState = this.states.get(dev.sn);
      if (!existingState) {
        this.states.set(dev.sn, createInitialSurferState(dev));
      } else {
        this.mergeRestDeviceSnapshot(dev);
      }
    }

    return selected;
  }

  /**
   * Refreshes slower-changing REST metadata for a Surfer S2:
   * - Equipment info (firmware version, canonical model)
   * - Consumables (`Propeller` and `MicroMesh Filter`)
   * - Clean-path preference (`0` = S-Shaped, `1` = Adaptive)
   */
  public async refreshDeviceMetadata(sn: string): Promise<void> {
    const zoneId = this.deviceZoneIds.get(sn);

    // 1. Equipment Info
    try {
      const infoPayload = await this.callEncrypted(
        '/equipment/getEquipmentInfo',
        { sn },
        { zoneIdOverride: zoneId },
      );
      if (this.isApiSuccess(infoPayload)) {
        const info = asObject(infoPayload.data);
        const current = this.states.get(sn);
        if (info && current) {
          const fwCandidate =
            typeof info.fw_main === 'string' ? info.fw_main : (
              typeof info.version === 'string' ? info.version : undefined
            );
          const modelCandidate =
            typeof info.model === 'string' && info.model.trim() ? info.model : undefined;
          const updated: SurferState = {
            ...current,
            firmwareVersion: fwCandidate
              ? sanitizeHomeKitFirmwareVersion(fwCandidate)
              : current.firmwareVersion,
            model: modelCandidate ? formatSurferModelName(modelCandidate) : current.model,
          };
          this.updateAndEmitState(sn, updated);
        }
      }
    } catch (error) {
      this.log.debug(`Equipment info refresh skipped for ${redactSerial(sn)}: ${this.errMsg(error)}`);
    }

    // 2. Consumables (Propeller & MicroMesh Filter)
    try {
      const consumablesPayload = await this.callEncrypted(
        '/poolRobot/getConsumableList',
        { sn },
        { zoneIdOverride: zoneId },
      );
      if (this.isApiSuccess(consumablesPayload)) {
        const consumables = parseConsumablesPayload(consumablesPayload);
        const current = this.states.get(sn);
        if (current && consumables.length > 0) {
          const updated = applyConsumablesToState(current, consumables);
          this.updateAndEmitState(sn, updated);
          this.log.debug(
            `Consumables updated for ${redactSerial(sn)}: ` +
            consumables.map((c) => `${c.name}=${c.percentLeft ?? '?'}%`).join(', '),
          );
        }
      }
    } catch (error) {
      this.log.debug(`Consumables refresh skipped for ${redactSerial(sn)}: ${this.errMsg(error)}`);
    }

    // 3. Verified Surfer S2 Clean-Path Setting
    try {
      const cleanPath = await this.queryCleanPathSetting(sn);
      const current = this.states.get(sn);
      if (current && cleanPath !== undefined && cleanPath !== current.cleanPath) {
        const updated: SurferState = {
          ...current,
          cleanPath,
          cleanPathLabel: cleanPath === 1 ? 'Adaptive' : 'S-Shaped',
          lastUpdatedAt: Date.now(),
        };
        this.updateAndEmitState(sn, updated);
      }
    } catch (error) {
      this.log.debug(`Clean-path query skipped for ${redactSerial(sn)}: ${this.errMsg(error)}`);
    }

    this.lastMetadataRefreshAt.set(sn, Date.now());
  }

  /**
   * Queries Surfer S2 clean-path preference (`0` = S-Shaped, `1` = Adaptive)
   * using the verified `/equipmentCleanPathSetting/getCleanPathSetting` endpoint.
   */
  public async queryCleanPathSetting(sn: string): Promise<SurferCleanPath | undefined> {
    const payload = await this.callEncrypted(
      '/equipmentCleanPathSetting/getCleanPathSetting',
      { sn },
      { zoneIdOverride: this.deviceZoneIds.get(sn) },
    );

    if (!this.isApiSuccess(payload)) {
      return undefined;
    }

    const data = asObject(payload.data);
    const rawVal = data
      ? (data.cleanPath ?? data.cleanPathSetting ?? data.clean_path_setting ?? data.value)
      : (payload.cleanPath ?? payload.cleanPathSetting);

    return normalizeCleanPath(rawVal);
  }

  /**
   * Starts (`AT+MODE=1`) or stops (`AT+MODE=0`) skimming on the Surfer S2.
   */
  public async setRunning(sn: string, running: boolean): Promise<boolean> {
    const cmdKey = `run:${running ? 1 : 0}`;
    const prevCmd = this.lastCommandTimestamps.get(sn);
    const now = Date.now();
    if (prevCmd && prevCmd.key === cmdKey && now - prevCmd.at < 2000) {
      this.log.debug(`Duplicate Surfer S2 running command ignored (${cmdKey}).`);
      return true;
    }
    this.lastCommandTimestamps.set(sn, { key: cmdKey, at: now });

    const atCommand = running ? 'AT+MODE=1' : 'AT+MODE=0';
    if (!running) {
      this.manualStopRequestedAt.set(sn, now);
    } else {
      this.manualStopRequestedAt.delete(sn);
    }

    this.log.info(
      `Sending Surfer S2 ${running ? 'START' : 'STOP'} skimming command (${atCommand}) to ${redactSerial(sn)}...`,
    );

    const ackResult = await this.sendMachineAt(sn, atCommand);
    if (ackResult === false) {
      this.log.warn(`Surfer S2 (${redactSerial(sn)}) rejected command ${atCommand} (+ERROR).`);
      return false;
    }

    // Apply optimistic state while shadow update propagates
    const current = this.states.get(sn);
    if (current) {
      const nextRawStatus = running ? 129 : 128;
      const nextRawMode = running ? 1 : 5;
      const modeInfo = resolveSurferMode(nextRawMode, running);
      this.updateAndEmitState(sn, {
        ...current,
        rawStatus: nextRawStatus,
        baseStatus: running ? AiperBaseStatus.CLEANING : AiperBaseStatus.IDLE,
        statusLabel: getStatusLabel(nextRawStatus, current.online),
        running,
        rawMode: nextRawMode,
        effectiveMode: modeInfo.effectiveMode,
        modeLabel: modeInfo.modeLabel,
        lastUpdatedAt: Date.now(),
      });
    }

    await this.requestShadow(sn).catch(() => undefined);
    return true;
  }

  /**
   * Updates Surfer S2 Clean Path (`0` = S-Shaped, `1` = Adaptive) via both
   * the verified encrypted REST endpoint and immediate `AT+AUTO=<value>` MQTT command.
   */
  public async setCleanPath(sn: string, cleanPath: SurferCleanPath): Promise<boolean> {
    const label = cleanPath === 1 ? 'Adaptive' : 'S-Shaped';
    this.log.info(
      `Setting Surfer S2 (${redactSerial(sn)}) Clean Path to ${label} (${cleanPath})...`,
    );

    let restOk = false;
    try {
      const payload = await this.callEncrypted(
        '/equipmentCleanPathSetting/updateCleanPathSetting',
        { sn, cleanPath },
        { zoneIdOverride: this.deviceZoneIds.get(sn) },
      );
      restOk = this.isApiSuccess(payload);
    } catch (error) {
      this.log.warn(`Clean-path REST update failed for ${redactSerial(sn)}: ${this.errMsg(error)}`);
    }

    let mqttOk = false;
    try {
      const ack = await this.sendMachineAt(sn, `AT+AUTO=${cleanPath}`);
      mqttOk = ack !== false;
    } catch (error) {
      this.log.debug(`Clean-path MQTT AT+AUTO failed for ${redactSerial(sn)}: ${this.errMsg(error)}`);
    }

    if (restOk || mqttOk) {
      const current = this.states.get(sn);
      if (current) {
        this.updateAndEmitState(sn, {
          ...current,
          cleanPath,
          cleanPathLabel: label,
          lastUpdatedAt: Date.now(),
        });
      }
      await this.requestShadow(sn).catch(() => undefined);
      return true;
    }

    return false;
  }

  /**
   * Requests an immediate AWS IoT shadow snapshot on `$aws/things/<sn>/shadow/get`.
   */
  public async requestShadow(sn: string): Promise<boolean> {
    if (!this.mqttConnection || !this.mqttConnected) {
      return false;
    }
    const topic = `$aws/things/${sn}/shadow/get`;
    try {
      await this.mqttConnection.publish(topic, '', mqtt.QoS.AtLeastOnce);
      if (this.options.debugMqtt) {
        this.log.info(`Published shadow get request for ${redactSerial(sn)}.`);
      }
      return true;
    } catch (error) {
      this.log.debug(`Shadow get request failed for ${redactSerial(sn)}: ${this.errMsg(error)}`);
      return false;
    }
  }

  private async getOpenIdToken(retryAuth = true): Promise<void> {
    if (!this.token) {
      throw new Error('Cannot fetch OpenID token before login.');
    }

    const payload = await this.callEncrypted(
      '/users/getOpenIdToken',
      {},
      { retryAuth },
    );

    if (!this.isApiSuccess(payload)) {
      throw new Error(`OpenID token request failed: ${this.extractApiMessage(payload)}`);
    }

    const data = asObject(payload.data) ?? {};
    this.identityId = typeof data.identityId === 'string' ? data.identityId : undefined;
    this.openIdToken = typeof data.token === 'string' ? data.token : undefined;
    this.iotEndpoint = typeof data.iotEndpoint === 'string' ? data.iotEndpoint : undefined;
    this.awsRegion = typeof data.region === 'string' ? data.region : undefined;

    const durationSec = coerceNumber(data.tokenDuration);
    this.openIdTokenExpiresAt = durationSec
      ? Date.now() + durationSec * 1000
      : Date.now() + 55 * 60 * 1000;

    this.log.debug(
      `OpenID credentials obtained (iotEndpoint=${this.iotEndpoint ?? 'missing'}, region=${this.resolveAwsRegion()}).`,
    );
  }

  private resolveAwsRegion(): string {
    if (this.awsRegion && this.awsRegion.trim()) {
      return this.awsRegion.trim();
    }
    if (this.iotEndpoint?.includes('.iot.')) {
      const parsed = this.iotEndpoint.split('.iot.')[1]?.split('.')[0];
      if (parsed) {
        return parsed;
      }
    }
    if (this.resolvedRegion === 'eu') {
      return 'eu-central-1';
    }
    if (this.resolvedRegion === 'asia') {
      return 'ap-southeast-1';
    }
    return 'us-east-2';
  }

  private async getAwsCredentials(forceRefresh = false): Promise<boolean> {
    if (!forceRefresh &&
      this.awsAccessKeyId &&
      this.awsSecretAccessKey &&
      Date.now() + 2 * 60 * 1000 < this.awsCredentialsExpiresAt
    ) {
      return true;
    }

    if (!this.identityId || !this.openIdToken || Date.now() + 2 * 60 * 1000 >= this.openIdTokenExpiresAt) {
      await this.getOpenIdToken();
    }

    if (!this.identityId || !this.openIdToken) {
      return false;
    }

    const exchangeOnce = async (): Promise<{ status: number; text: string }> => {
      const region = this.resolveAwsRegion();
      const response = await fetch(`https://cognito-identity.${region}.amazonaws.com/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-amz-json-1.1',
          'X-Amz-Target': 'AWSCognitoIdentityService.GetCredentialsForIdentity',
        },
        body: JSON.stringify({
          IdentityId: this.identityId,
          Logins: {
            'cognito-identity.amazonaws.com': this.openIdToken,
          },
        }),
      });
      const text = await response.text();
      return { status: response.status, text };
    };

    let result = await exchangeOnce();
    if (result.status >= 400 && result.status < 500) {
      this.log.info('Cognito rejected cached OpenID token; refreshing OpenID token and retrying once...');
      const prevToken = this.openIdToken;
      await this.getOpenIdToken();
      if (this.openIdToken && this.openIdToken !== prevToken) {
        result = await exchangeOnce();
      }
    }

    if (result.status < 200 || result.status >= 300) {
      throw new Error(`AWS Cognito credential exchange failed (HTTP ${result.status})`);
    }

    const parsed = asObject(JSON.parse(result.text));
    const creds = asObject(parsed?.Credentials);
    const accessKeyId = typeof creds?.AccessKeyId === 'string' ? creds.AccessKeyId : undefined;
    const secretKey = typeof creds?.SecretKey === 'string' ? creds.SecretKey : undefined;
    const sessionToken = typeof creds?.SessionToken === 'string' ? creds.SessionToken : undefined;

    if (!accessKeyId || !secretKey) {
      throw new Error('AWS Cognito response did not include AccessKeyId/SecretKey.');
    }

    this.awsAccessKeyId = accessKeyId;
    this.awsSecretAccessKey = secretKey;
    this.awsSessionToken = sessionToken;
    this.awsCredentialsExpiresAt = Date.now() + AWS_CREDENTIALS_TTL_MS;
    return true;
  }

  public async connectMqtt(): Promise<boolean> {
    if (this.mqttConnectPromise) {
      return this.mqttConnectPromise;
    }

    this.mqttConnectPromise = this.performMqttConnect();
    try {
      return await this.mqttConnectPromise;
    } finally {
      this.mqttConnectPromise = undefined;
    }
  }

  private async performMqttConnect(): Promise<boolean> {
    await this.getAwsCredentials();

    if (!this.iotEndpoint || !this.identityId || !this.awsAccessKeyId || !this.awsSecretAccessKey) {
      this.log.warn('AWS IoT MQTT connection skipped: missing endpoint or credentials.');
      return false;
    }

    await this.disconnectMqtt();

    const region = this.resolveAwsRegion();
    const bootstrap = new io.ClientBootstrap();
    const credentialsProvider = auth.AwsCredentialsProvider.newStatic(
      this.awsAccessKeyId,
      this.awsSecretAccessKey,
      this.awsSessionToken,
    );

    const configBuilder = iot.AwsIotMqttConnectionConfigBuilder.new_with_websockets({
      region,
      credentials_provider: credentialsProvider,
    });
    configBuilder.with_endpoint(this.iotEndpoint);
    configBuilder.with_client_id(this.identityId);
    configBuilder.with_clean_session(false);
    configBuilder.with_keep_alive_seconds(60);

    const client = new mqtt.MqttClient(bootstrap);
    const connection = client.new_connection(configBuilder.build());

    connection.on('interrupt', (error) => {
      if (this.mqttConnection !== connection) {
        return;
      }
      this.mqttConnected = false;
      this.log.warn(`AWS IoT MQTT interrupted: ${this.errMsg(error)}`);
    });

    connection.on('resume', (_returnCode, sessionPresent) => {
      if (this.mqttConnection !== connection) {
        return;
      }
      this.mqttConnected = true;
      this.lastMqttActivityAt = Date.now();
      this.log.info(`AWS IoT MQTT resumed (sessionPresent=${sessionPresent}).`);
      void this.resubscribeAllDevices();
    });

    connection.on('disconnect', () => {
      if (this.mqttConnection !== connection) {
        return;
      }
      this.mqttConnected = false;
      this.subscribedSerials.clear();
      if (!this.stopped) {
        this.log.debug('AWS IoT MQTT disconnected.');
      }
    });

    connection.on('error', (error) => {
      if (this.mqttConnection !== connection) {
        return;
      }
      this.mqttConnected = false;
      this.log.warn(`AWS IoT MQTT error: ${this.errMsg(error)}`);
    });

    this.mqttConnection = connection;

    try {
      await connection.connect();
      this.mqttConnected = true;
      this.lastMqttActivityAt = Date.now();
      this.lastMqttRebuildAt = Date.now();
      this.log.info('Connected to Aiper AWS IoT MQTT broker.');
      return true;
    } catch (error) {
      this.mqttConnected = false;
      this.mqttConnection = undefined;
      this.log.warn(`Failed to connect to AWS IoT MQTT: ${this.errMsg(error)}`);
      return false;
    }
  }

  private async disconnectMqtt(): Promise<void> {
    const existing = this.mqttConnection;
    this.mqttConnection = undefined;
    this.mqttConnected = false;
    this.subscribedSerials.clear();

    if (!existing) {
      return;
    }

    await Promise.race([
      existing.disconnect().catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 1500)),
    ]);
  }

  private async rebuildMqttSession(): Promise<boolean> {
    if (this.stopped) {
      return false;
    }
    this.log.info('Refreshing Aiper AWS IoT credentials and MQTT session...');
    try {
      await this.getOpenIdToken();
      await this.getAwsCredentials(true);
      const ok = await this.connectMqtt();
      if (ok) {
        await this.resubscribeAllDevices();
      }
      return ok;
    } catch (error) {
      this.log.warn(`MQTT session rebuild failed: ${this.errMsg(error)}`);
      return false;
    }
  }

  private async resubscribeAllDevices(): Promise<void> {
    this.subscribedSerials.clear();
    for (const sn of this.devices.keys()) {
      await this.subscribeToDevice(sn);
      await this.requestShadow(sn);
    }
  }

  public async subscribeToDevice(sn: string): Promise<void> {
    if (!this.mqttConnection || !this.mqttConnected) {
      return;
    }
    if (this.subscribedSerials.has(sn)) {
      return;
    }

    const topics = [
      `aiper/things/${sn}/shadow/report`,
      `aiper/things/${sn}/app/report`,
      `aiper/things/${sn}/upChan`,
      `$aws/things/${sn}/shadow/get/accepted`,
      `$aws/things/${sn}/shadow/update/accepted`,
      `$aws/things/${sn}/shadow/update/delta`,
      `$aws/things/${sn}/shadow/update/documents`,
    ];

    for (const topic of topics) {
      await this.mqttConnection.subscribe(
        topic,
        mqtt.QoS.AtLeastOnce,
        (receivedTopic, payloadBuffer) => {
          this.handleIncomingMqttMessage(sn, receivedTopic, new Uint8Array(payloadBuffer));
        },
      );
    }

    this.subscribedSerials.add(sn);
    this.log.info(`Subscribed to real-time MQTT telemetry for Surfer S2 (${redactSerial(sn)}).`);
  }

  private handleIncomingMqttMessage(sn: string, topic: string, rawBytes: Uint8Array): void {
    this.lastMqttActivityAt = Date.now();
    const decodedText = decodeMqttPayload(rawBytes);
    if (!decodedText) {
      return;
    }

    if (this.options.debugMqtt) {
      const safeLog = decodedText.slice(0, 600).replaceAll(sn, redactSerial(sn));
      this.log.info(`MQTT [${topic.replaceAll(sn, redactSerial(sn))}]: ${safeLog}`);
    }

    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = asObject(JSON.parse(decodedText));
    } catch {
      this.log.debug(`Unparseable MQTT message on ${topic.replaceAll(sn, redactSerial(sn))}`);
      return;
    }

    if (!parsed) {
      return;
    }

    // Track device-reported UTC timezone string (e.g. "UTC+10" or "UTC-4")
    const innerData = asObject(parsed.data);
    if (innerData && typeof innerData.timeZone === 'string' && innerData.timeZone.trim()) {
      const targetSn = typeof innerData.sn === 'string' && innerData.sn.trim() ? innerData.sn.trim() : sn;
      this.lastReportedUtcOffsets.set(targetSn, innerData.timeZone.trim());
    }

    // Record AT command acknowledgement (`+OK` / `+ERROR`) from `upChan`
    if (parsed.type === 'Machine' && innerData && typeof innerData.ack === 'string') {
      this.recordAck(sn, innerData.ack);
    }

    const current = this.states.get(sn);
    if (!current) {
      return;
    }

    const { nextState, recognized } = applyMqttPayloadToState(current, topic, parsed);
    if (!recognized) {
      return;
    }

    this.lastMqttFieldAt.set(sn, Date.now());
    this.updateAndEmitState(sn, nextState);
  }

  private recordAck(sn: string, ack: string): void {
    const waiters = this.ackWaiters.get(sn);
    if (waiters && waiters.length > 0) {
      const nextWaiter = waiters.shift()!;
      clearTimeout(nextWaiter.timer);
      nextWaiter.resolve(ack);
      return;
    }

    let queue = this.ackQueues.get(sn);
    if (!queue) {
      queue = [];
      this.ackQueues.set(sn, queue);
    }
    queue.push(ack);
    if (queue.length > 10) {
      queue.shift();
    }
  }

  private clearAckQueue(sn: string): void {
    this.ackQueues.set(sn, []);
  }

  private waitForAck(sn: string, timeoutMs = 4000): Promise<string | undefined> {
    const queued = this.ackQueues.get(sn);
    if (queued && queued.length > 0) {
      return Promise.resolve(queued.shift());
    }

    return new Promise<string | undefined>((resolve) => {
      let waiters = this.ackWaiters.get(sn);
      if (!waiters) {
        waiters = [];
        this.ackWaiters.set(sn, waiters);
      }

      const waiter: PendingAckWaiter = {
        resolve,
        timer: setTimeout(() => {
          const list = this.ackWaiters.get(sn);
          if (list) {
            const idx = list.indexOf(waiter);
            if (idx >= 0) {
              list.splice(idx, 1);
            }
          }
          resolve(undefined);
        }, timeoutMs),
      };

      waiters.push(waiter);
    });
  }

  private async ensureMqttReadyForCommand(sn: string): Promise<boolean> {
    const credentialsExpiringSoon = Date.now() + 5 * 60 * 1000 >= this.awsCredentialsExpiresAt;
    if (credentialsExpiringSoon || !this.mqttConnection || !this.mqttConnected) {
      const ok = await this.rebuildMqttSession();
      if (!ok) {
        return false;
      }
    }

    if (!this.subscribedSerials.has(sn)) {
      await this.subscribeToDevice(sn);
    }

    return this.isMqttConnected();
  }

  /**
   * Sends a serialized AT command on `aiper/things/<sn>/downChan` and resolves:
   * - `true` on `+OK`
   * - `false` on `+ERROR` or transport failure
   * - `undefined` if published cleanly without an explicit `+OK`/`+ERROR` within timeout
   */
  public async sendMachineAt(
    sn: string,
    atCommand: string,
    timeoutMs = 4000,
  ): Promise<boolean | undefined> {
    const prev = this.cmdQueues.get(sn) ?? Promise.resolve();
    const run = prev
      .catch(() => undefined)
      .then(() => this.performSendMachineAt(sn, atCommand, timeoutMs));
    this.cmdQueues.set(sn, run);
    return run;
  }

  private async performSendMachineAt(
    sn: string,
    atCommand: string,
    timeoutMs: number,
  ): Promise<boolean | undefined> {
    const ready = await this.ensureMqttReadyForCommand(sn);
    if (!ready || !this.mqttConnection) {
      this.log.error(`Cannot send ${atCommand} to ${redactSerial(sn)}: MQTT is offline.`);
      return false;
    }

    this.clearAckQueue(sn);

    const dataObj = {
      sn,
      timeZone: this.formatDeviceUtcOffset(sn),
      cmd: atCommand,
    };
    const dataJson = JSON.stringify(dataObj);
    const envelope = {
      type: 'Machine',
      data: dataObj,
      res: 0,
      chksum: calculateAiperCrc16(dataJson),
    };

    const topic = `aiper/things/${sn}/downChan`;
    const message = JSON.stringify(envelope);

    if (this.options.debugMqtt) {
      this.log.info(
        `MQTT publish [${topic.replaceAll(sn, redactSerial(sn))}]: ` +
        message.replaceAll(sn, redactSerial(sn)),
      );
    }

    try {
      await this.mqttConnection.publish(topic, message, mqtt.QoS.AtLeastOnce);
    } catch (error) {
      this.log.error(`MQTT publish failed for ${atCommand}: ${this.errMsg(error)}`);
      return false;
    }

    const ack = await this.waitForAck(sn, timeoutMs);
    if (!ack) {
      this.log.debug(`Command ${atCommand} published to ${redactSerial(sn)} (no upChan ack within ${timeoutMs}ms).`);
      return undefined;
    }

    const upperAck = ack.toUpperCase();
    if (upperAck.includes('+OK')) {
      this.log.info(`Surfer S2 (${redactSerial(sn)}) acknowledged ${atCommand} (+OK).`);
      return true;
    }
    if (upperAck.includes('+ERROR')) {
      return false;
    }
    return undefined;
  }

  private formatDeviceUtcOffset(sn: string): string {
    const observed = this.lastReportedUtcOffsets.get(sn);
    if (observed) {
      return observed;
    }

    const zoneId = this.deviceZoneIds.get(sn) || this.systemTimeZone;
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: zoneId,
        timeZoneName: 'shortOffset',
      });
      const parts = formatter.formatToParts(new Date());
      const tzPart = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
      // Example: "GMT-4" or "GMT+10" or "GMT"
      const match = /GMT([+-]\d{1,2})/.exec(tzPart);
      if (match) {
        return `UTC${match[1]}`;
      }
    } catch {
      // Fallback below
    }
    return 'UTC+0';
  }

  private updateAndEmitState(sn: string, nextState: SurferState): void {
    const prevState = this.states.get(sn);
    this.states.set(sn, nextState);

    // Track skimming cycle transitions
    if (!prevState?.running && nextState.running) {
      this.runStartedAt.set(sn, Date.now());
    } else if (prevState?.running && !nextState.running) {
      const startedAt = this.runStartedAt.get(sn) ?? 0;
      this.runStartedAt.delete(sn);
      const manualStopAt = this.manualStopRequestedAt.get(sn) ?? 0;
      const wasManualStop = manualStopAt > 0 && Date.now() - manualStopAt < 30_000;

      if (!wasManualStop && startedAt > 0 && Date.now() - startedAt >= MIN_CYCLE_DURATION_FOR_COMPLETION_MS) {
        const listeners = this.cycleCompleteListeners.get(sn);
        if (listeners) {
          for (const listener of listeners) {
            try {
              listener();
            } catch (err) {
              this.log.error(`Cycle-complete listener error: ${this.errMsg(err)}`);
            }
          }
        }
      }
    }

    // Track warning edge (`false` -> `true`)
    if (!prevState?.hasWarning && nextState.hasWarning) {
      this.log.warn(
        `Surfer S2 (${redactSerial(sn)}) reported warning: ${nextState.warningMessage}`,
      );
      const warnListeners = this.warningListeners.get(sn);
      if (warnListeners) {
        for (const listener of warnListeners) {
          try {
            listener(nextState);
          } catch (err) {
            this.log.error(`Warning listener error: ${this.errMsg(err)}`);
          }
        }
      }
    }

    const changedSummary =
      !prevState ||
      prevState.running !== nextState.running ||
      prevState.statusLabel !== nextState.statusLabel ||
      prevState.modeLabel !== nextState.modeLabel ||
      prevState.battery !== nextState.battery ||
      prevState.charging !== nextState.charging ||
      prevState.solarCharging !== nextState.solarCharging ||
      prevState.cleanPath !== nextState.cleanPath ||
      prevState.hasWarning !== nextState.hasWarning ||
      prevState.online !== nextState.online;

    if (changedSummary) {
      this.log.info(
        `Surfer S2 (${redactSerial(sn)}) state: status=${nextState.statusLabel} (raw=${nextState.rawStatus}) ` +
        `running=${nextState.running} context=${nextState.modeLabel} battery=${nextState.battery}% ` +
        `charging=${nextState.charging} (solar=${nextState.solarCharging}) path=${nextState.cleanPathLabel} ` +
        `online=${nextState.online} warn="${nextState.warningMessage}"`,
      );
    }

    const listeners = this.stateListeners.get(sn);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(nextState);
        } catch (err) {
          this.log.error(`State listener error: ${this.errMsg(err)}`);
        }
      }
    }
  }

  private mergeRestDeviceSnapshot(dev: DiscoveredAiperDevice): void {
    const current = this.states.get(dev.sn);
    if (!current) {
      return;
    }

    const raw = dev.raw;
    const mqttFresh = Date.now() - (this.lastMqttFieldAt.get(dev.sn) ?? 0) < 10 * 60 * 1000;
    const next: SurferState = { ...current };

    const online = coerceBoolean(raw.online);
    if (online !== undefined && !mqttFresh) {
      next.online = online;
    }

    const batt = coerceNumber(raw.battLevel ?? raw.battery ?? raw.cap);
    if (batt !== undefined && !mqttFresh) {
      next.battery = clampPercentage(batt);
    }

    const rawStatus = coerceInt(raw.machineStatus ?? raw.status);
    if (rawStatus !== undefined && !mqttFresh) {
      next.rawStatus = rawStatus;
      next.running = isStatusRunning(rawStatus);
      const base = extractBaseStatus(rawStatus);
      next.baseStatus = !next.running && base !== AiperBaseStatus.CHARGING &&
        base !== AiperBaseStatus.CHARGED && base !== AiperBaseStatus.ERROR
        ? AiperBaseStatus.IDLE
        : base;
      next.dcCharging = base === AiperBaseStatus.CHARGING;
      next.charging = next.dcCharging || next.solarCharging;
      const rawMode = coerceInt(raw.mode) ?? next.rawMode;
      next.rawMode = rawMode;
      const modeInfo = resolveSurferMode(rawMode, next.running);
      next.effectiveMode = modeInfo.effectiveMode;
      next.modeLabel = modeInfo.modeLabel;
    }

    const temp = coerceNumber(raw.temp);
    if (temp !== undefined && next.waterTemperatureCelsius === undefined) {
      next.waterTemperatureCelsius = temp;
    }

    next.statusLabel = getStatusLabel(next.rawStatus, next.online);
    this.updateAndEmitState(dev.sn, next);
  }

  private startBackgroundLoop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }

    const pollSeconds = Math.max(
      60,
      this.options.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS,
    );

    this.pollTimer = setInterval(() => {
      void this.performPeriodicSync();
    }, pollSeconds * 1000);
    this.pollTimer.unref?.();
  }

  private async performPeriodicSync(): Promise<void> {
    if (this.stopped) {
      return;
    }

    // 1. Proactively refresh AWS IoT session before Cognito credentials expire or if disconnected
    const credsExpiring = Date.now() + 8 * 60 * 1000 >= this.awsCredentialsExpiresAt;
    const canRebuild = Date.now() - this.lastMqttRebuildAt >= MQTT_REBUILD_MIN_INTERVAL_MS;

    if ((credsExpiring || !this.isMqttConnected()) && canRebuild) {
      await this.rebuildMqttSession();
    } else if (this.isMqttConnected()) {
      for (const sn of this.devices.keys()) {
        await this.requestShadow(sn);
      }
    }

    // 2. Poll REST device list & refresh slow metadata when due
    try {
      await this.discoverSurferDevices();
      for (const sn of this.devices.keys()) {
        const lastMeta = this.lastMetadataRefreshAt.get(sn) ?? 0;
        if (Date.now() - lastMeta >= DEFAULT_METADATA_REFRESH_MS) {
          await this.refreshDeviceMetadata(sn);
        }
      }
    } catch (error) {
      if (error instanceof AiperSessionConflictError) {
        this.log.info(error.message);
      } else {
        this.log.debug(`Background REST sync skipped: ${this.errMsg(error)}`);
      }
    }
  }

  private resolveCandidateRegions(): AiperResolvedRegion[] {
    const configured = this.options.region ?? 'auto';
    if (configured === 'us' || configured === 'eu' || configured === 'asia') {
      return [configured];
    }

    const tz = this.systemTimeZone.toLowerCase();
    if (tz.startsWith('europe/') || tz.startsWith('africa/')) {
      return ['eu', 'us', 'asia'];
    }
    if (tz.startsWith('australia/') || tz.startsWith('asia/') || tz.startsWith('pacific/')) {
      return ['asia', 'us', 'eu'];
    }
    return ['us', 'eu', 'asia'];
  }

  private async refreshToken(): Promise<boolean> {
    if (!this.token) {
      return false;
    }
    try {
      const payload = await this.callEncrypted(
        '/users/token/refresh',
        {},
        { retryAuth: false },
      );
      if (this.isApiSuccess(payload)) {
        const data = asObject(payload.data);
        if (data && typeof data.token === 'string' && data.token.trim()) {
          this.token = data.token.trim();
          return true;
        }
      }
    } catch {
      // Fallback to full login
    }
    return false;
  }

  private async callEncrypted(
    path: string,
    body: Record<string, unknown>,
    opts: {
      baseUrlOverride?: string;
      tokenOverride?: string;
      zoneIdOverride?: string;
      retryAuth?: boolean;
    } = {},
  ): Promise<Record<string, unknown>> {
    if (path !== '/login' && Date.now() < this.sessionConflictUntil) {
      const remainingSec = Math.ceil((this.sessionConflictUntil - Date.now()) / 1000);
      throw new AiperSessionConflictError(
        `Aiper account is active in another session (mobile app); pausing cloud sync for ${remainingSec}s.`,
      );
    }

    const cryptoEnvelope = new AiperCrypto();
    const baseUrl = (opts.baseUrlOverride ?? this.baseUrl).replace(/\/+$/, '');
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      version: '3.0.0',
      os: 'android',
      charset: 'UTF-8',
      'Accept-Language': 'en',
      zoneId: opts.zoneIdOverride || this.systemTimeZone || 'UTC',
      token: opts.tokenOverride !== undefined ? opts.tokenOverride : (this.token ?? ''),
      encryptKey: cryptoEnvelope.encryptKeyHeader,
    };

    const requestData = cryptoEnvelope.encryptRequest(body);
    const responseText = await this.fetchWithPacingAndBackoff(url, headers, requestData);
    const decryptedText = cryptoEnvelope.decryptResponse(responseText);
    const parsed = asObject(JSON.parse(decryptedText));
    if (!parsed) {
      throw new Error(`Invalid decrypted JSON object from ${path}`);
    }

    const retryAuth = opts.retryAuth !== false;
    const codeStr = String(parsed.code ?? '');

    if (retryAuth && path !== '/login' && codeStr === SESSION_CONFLICT_CODE) {
      this.log.info('Aiper session conflict detected; attempting one silent re-login before cooldown...');
      try {
        await this.login();
        const retried = await this.callEncrypted(path, body, { ...opts, retryAuth: false });
        if (String(retried.code ?? '') !== SESSION_CONFLICT_CODE) {
          this.sessionConflictUntil = 0;
          return retried;
        }
      } catch {
        // Enter cooldown below
      }
      this.sessionConflictUntil = Date.now() + SESSION_CONFLICT_COOLDOWN_MS;
      throw new AiperSessionConflictError(
        `Aiper account is active in another session (${this.extractApiMessage(parsed)}); cooling down for 3 minutes.`,
      );
    }

    if (retryAuth && path !== '/login' && (codeStr === '401' || codeStr === '403')) {
      const refreshed = await this.refreshToken();
      if (refreshed) {
        return this.callEncrypted(path, body, { ...opts, retryAuth: false });
      }
      await this.login();
      return this.callEncrypted(path, body, { ...opts, retryAuth: false });
    }

    return parsed;
  }

  private async fetchWithPacingAndBackoff(
    url: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<string> {
    let lastErr: Error | undefined;
    let delayMs = 1000;

    for (let attempt = 1; attempt <= 3; attempt++) {
      await this.paceRestCall();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 25_000);
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers,
            body,
            signal: controller.signal,
          });
          const text = await response.text();
          if (RETRYABLE_HTTP_STATUSES.has(response.status)) {
            throw new Error(`HTTP ${response.status}`);
          }
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`);
          }
          return text;
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt < 3) {
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
          delayMs *= 2;
        }
      }
    }

    throw lastErr ?? new Error(`Request failed: ${url}`);
  }

  private async paceRestCall(): Promise<void> {
    const ticket = this.restQueue.then(async () => {
      const waitMs = this.restNextAllowedAt - Date.now();
      if (waitMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      }
      this.restNextAllowedAt = Date.now() + REST_MIN_INTERVAL_MS;
    });
    this.restQueue = ticket.catch(() => undefined);
    await ticket;
  }

  private isApiSuccess(payload: Record<string, unknown>): boolean {
    const code = payload.code;
    return code === 0 || code === '0' || code === 200 || code === '200' || payload.successful === true;
  }

  private extractApiMessage(payload: Record<string, unknown>): string {
    for (const key of ['msg', 'message', 'mess']) {
      if (typeof payload[key] === 'string' && payload[key].trim()) {
        return payload[key].trim();
      }
    }
    return `code=${String(payload.code ?? 'unknown')}`;
  }

  private errMsg(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

