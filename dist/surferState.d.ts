import type { DiscoveredAiperDevice, SurferCleanPath, SurferConsumableStatus, SurferModeContext, SurferState } from './types.js';
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
export declare const STATUS_BASE_MASK = 127;
export declare enum AiperBaseStatus {
    IDLE = 0,
    CLEANING = 1,
    RETURNING = 2,
    CHARGING = 3,
    CHARGED = 4,
    ERROR = 5,
    SLEEPING = 6
}
export declare function coerceInt(value: unknown): number | undefined;
export declare function coerceNumber(value: unknown): number | undefined;
export declare function coerceBoolean(value: unknown): boolean | undefined;
/**
 * Extracts the lower 7-bit operational status from raw Aiper status codes.
 */
export declare function extractBaseStatus(rawStatus: number): number;
/**
 * Returns true when the lower 7-bit status indicates active skimming/movement.
 */
export declare function isStatusRunning(rawStatus: number): boolean;
/**
 * Returns a human-readable label for a Surfer status code.
 */
export declare function getStatusLabel(rawStatus: number, online: boolean): string;
/**
 * Normalizes Surfer S2 mode context.
 * Surfer S2 reports `mode=5` when stopped (`status=128`); when not running,
 * effective mode is normalized to `0` (`Off`), matching verified hardware behavior.
 */
export declare function resolveSurferMode(rawMode: number, running: boolean): {
    effectiveMode: number;
    modeLabel: SurferModeContext;
};
/**
 * Normalizes clean-path values (`0` = S-Shaped, `1` = Adaptive, `-1` -> `0`).
 */
export declare function normalizeCleanPath(value: unknown): SurferCleanPath | undefined;
/**
 * Checks whether a discovered device belongs to the Aiper Surfer family.
 */
export declare function isSurferDevice(raw: Record<string, unknown>): boolean;
/**
 * Creates an initial default SurferState from a discovered device record.
 */
export declare function createInitialSurferState(device: DiscoveredAiperDevice): SurferState;
/**
 * Parses AT-style report lines emitted on `upChan` (`data.report`),
 * e.g. `+INFO:128,5,38,0,285` or `+WARN:1,3` or `+MODE:1`.
 */
export declare function parseMachineReportString(report: string): Record<string, number>;
export declare function extractWarningInfo(machine: Record<string, unknown>, online: boolean, baseStatus: number): {
    hasWarning: boolean;
    warningCodes: string[];
    warningMessage: string;
};
/**
 * Applies an incoming MQTT payload (shadow `get/accepted`, `update/accepted`,
 * `update/documents`, `shadow/report`, or `upChan`) onto an existing SurferState.
 * Returns `{ nextState, changed }` where `changed` indicates whether state fields updated.
 */
export declare function applyMqttPayloadToState(current: SurferState, topic: string, payload: Record<string, unknown>): {
    nextState: SurferState;
    recognized: boolean;
};
/**
 * Parses `/poolRobot/getConsumableList` response for Surfer S2 consumables
 * (`Propeller` and `MicroMesh Filter`).
 */
export declare function parseConsumablesPayload(rawPayload: unknown): SurferConsumableStatus[];
/**
 * Applies parsed consumables onto a SurferState (`Propeller` & `MicroMesh Filter`).
 */
export declare function applyConsumablesToState(current: SurferState, consumables: SurferConsumableStatus[]): SurferState;
export declare function formatSurferModelName(rawModel: string): string;
/**
 * Sanitizes firmware strings (such as `"V1.4.0"`) into HAP-valid `X.Y.Z` format.
 */
export declare function sanitizeHomeKitFirmwareVersion(rawVersion: string | undefined): string;
export declare function clampPercentage(value: number): number;
export declare function asObject(value: unknown): Record<string, unknown> | undefined;
