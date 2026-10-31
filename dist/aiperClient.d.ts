import type { Logging } from 'homebridge';
import type { AiperRegionSetting, DiscoveredAiperDevice, SurferCleanPath, SurferState } from './types.js';
export interface AiperClientOptions {
    email?: string;
    password?: string;
    region?: AiperRegionSetting;
    deviceId?: string;
    pollIntervalSeconds?: number;
    debugMqtt?: boolean;
}
export declare class AiperSessionConflictError extends Error {
    constructor(message: string);
}
export declare class AiperAuthenticationError extends Error {
    constructor(message: string);
}
export declare class AiperClient {
    private readonly options;
    private readonly log;
    private token?;
    private baseUrl;
    private resolvedRegion?;
    private readonly systemTimeZone;
    private identityId?;
    private openIdToken?;
    private openIdTokenExpiresAt;
    private iotEndpoint?;
    private awsRegion?;
    private awsAccessKeyId?;
    private awsSecretAccessKey?;
    private awsSessionToken?;
    private awsCredentialsExpiresAt;
    private mqttConnection?;
    private mqttConnected;
    private mqttConnectPromise?;
    private lastMqttActivityAt;
    private lastMqttRebuildAt;
    private subscribedSerials;
    private sessionConflictUntil;
    private restNextAllowedAt;
    private restQueue;
    private readonly devices;
    private readonly states;
    private readonly deviceZoneIds;
    private readonly lastReportedUtcOffsets;
    private readonly lastMetadataRefreshAt;
    private readonly lastMqttFieldAt;
    private readonly ackQueues;
    private readonly ackWaiters;
    private readonly cmdQueues;
    private readonly lastCommandTimestamps;
    private readonly runStartedAt;
    private readonly manualStopRequestedAt;
    private readonly stateListeners;
    private readonly cycleCompleteListeners;
    private readonly warningListeners;
    private pollTimer?;
    private stopped;
    constructor(options: AiperClientOptions, log: Logging);
    getAllStates(): SurferState[];
    getState(sn: string): SurferState | undefined;
    getDiscoveredDevices(): DiscoveredAiperDevice[];
    isMqttConnected(): boolean;
    onStateUpdate(sn: string, listener: (state: SurferState) => void): () => void;
    onCycleComplete(sn: string, listener: () => void): () => void;
    onWarningTriggered(sn: string, listener: (state: SurferState) => void): () => void;
    /**
     * Authenticates, discovers Surfer S2 devices, fetches metadata, connects AWS IoT MQTT,
     * requests live device shadows, and starts background maintenance polling.
     */
    start(): Promise<DiscoveredAiperDevice[]>;
    /**
     * Stops background timers and cleanly disconnects from AWS IoT MQTT.
     */
    shutdown(): Promise<void>;
    /**
     * Logs in to Aiper Cloud, automatically probing regions when `region` is `"auto"`.
     */
    login(): Promise<void>;
    /**
     * Discovers Surfer S2 / Surfer family devices (or the explicitly configured `deviceId`).
     */
    discoverSurferDevices(): Promise<DiscoveredAiperDevice[]>;
    /**
     * Refreshes slower-changing REST metadata for a Surfer S2:
     * - Equipment info (firmware version, canonical model)
     * - Consumables (`Propeller` and `MicroMesh Filter`)
     * - Clean-path preference (`0` = S-Shaped, `1` = Adaptive)
     */
    refreshDeviceMetadata(sn: string): Promise<void>;
    /**
     * Queries Surfer S2 clean-path preference (`0` = S-Shaped, `1` = Adaptive)
     * using the verified `/equipmentCleanPathSetting/getCleanPathSetting` endpoint.
     */
    queryCleanPathSetting(sn: string): Promise<SurferCleanPath | undefined>;
    /**
     * Starts (`AT+MODE=1`) or stops (`AT+MODE=0`) skimming on the Surfer S2.
     */
    setRunning(sn: string, running: boolean): Promise<boolean>;
    /**
     * Updates Surfer S2 Clean Path (`0` = S-Shaped, `1` = Adaptive) via both
     * the verified encrypted REST endpoint and immediate `AT+AUTO=<value>` MQTT command.
     */
    setCleanPath(sn: string, cleanPath: SurferCleanPath): Promise<boolean>;
    /**
     * Requests an immediate AWS IoT shadow snapshot on `$aws/things/<sn>/shadow/get`.
     */
    requestShadow(sn: string): Promise<boolean>;
    private getOpenIdToken;
    private resolveAwsRegion;
    private getAwsCredentials;
    connectMqtt(): Promise<boolean>;
    private performMqttConnect;
    private disconnectMqtt;
    private rebuildMqttSession;
    private resubscribeAllDevices;
    subscribeToDevice(sn: string): Promise<void>;
    private handleIncomingMqttMessage;
    private recordAck;
    private clearAckQueue;
    private waitForAck;
    private ensureMqttReadyForCommand;
    /**
     * Sends a serialized AT command on `aiper/things/<sn>/downChan` and resolves:
     * - `true` on `+OK`
     * - `false` on `+ERROR` or transport failure
     * - `undefined` if published cleanly without an explicit `+OK`/`+ERROR` within timeout
     */
    sendMachineAt(sn: string, atCommand: string, timeoutMs?: number): Promise<boolean | undefined>;
    private performSendMachineAt;
    private formatDeviceUtcOffset;
    private updateAndEmitState;
    private mergeRestDeviceSnapshot;
    private startBackgroundLoop;
    private performPeriodicSync;
    private resolveCandidateRegions;
    private refreshToken;
    private callEncrypted;
    private fetchWithPacingAndBackoff;
    private paceRestCall;
    private isApiSuccess;
    private extractApiMessage;
    private errMsg;
}
