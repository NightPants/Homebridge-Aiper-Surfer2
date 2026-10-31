/**
 * 4-byte XOR key used by some Aiper firmwares on encoded MQTT payloads.
 */
export declare const MQTT_XOR_KEY: Buffer<ArrayBuffer>;
/**
 * Implements the AES-128-CBC + RSA-PKCS1v15 envelope required by Aiper REST endpoints.
 * Creates a fresh random key/IV pair per instance to match the official mobile app.
 */
export declare class AiperCrypto {
    private readonly aesKey;
    private readonly iv;
    readonly encryptKeyHeader: string;
    constructor();
    encryptRequest(body: Record<string, unknown>, nowMs?: number): string;
    decryptResponse(responseText: string): string;
    private buildEncryptKeyHeader;
    static zeroPad(data: Buffer, blockSize?: number): Buffer;
    static zeroUnpad(data: Buffer): Buffer;
    private static randomAsciiBytes;
    private static randomNonce;
}
/**
 * Computes the Aiper MQTT downChan CRC16 checksum (init 0x9966, polynomial 0xA001).
 */
export declare function calculateAiperCrc16(data: string): number;
/**
 * Decodes an incoming MQTT payload that may be either plain UTF-8 JSON
 * or Base64 + 4-byte XOR encoded JSON.
 */
export declare function decodeMqttPayload(rawBytes: Uint8Array): string;
/**
 * Encodes a string with Aiper's 4-byte XOR + Base64 scheme (used primarily in unit tests).
 */
export declare function encodeXorMqttPayload(jsonText: string): Buffer;
/**
 * Redacts the middle characters of a serial number or identifier for safe logging.
 */
export declare function redactSerial(sn: string | undefined): string;
