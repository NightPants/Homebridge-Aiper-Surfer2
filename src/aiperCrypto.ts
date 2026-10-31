import crypto from 'node:crypto';

/**
 * Official Aiper mobile app DER SPKI RSA public key used to wrap per-request AES keys.
 */
const AIPER_PUBLIC_KEY_DER_BASE64 =
  'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCIKoKPqwq1f60hm/2lpHDF/DT4J9YaptuTq78nsxdgnSBAvkIZ3E8d' +
  'qbEBT/VETjJ9Yr28QtHX13E8QGByYxLzYPldHNXChgOWfSemTEC3TxPvlaSuM9eFUuhqSeGbgoKG7JJNlgjvsPO2cH' +
  'EhPXJE4qWtKEZVOZBxEeCgAaLZxwIDAQAB';

const NONCE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()-_=+[]{}';

/**
 * 4-byte XOR key used by some Aiper firmwares on encoded MQTT payloads.
 */
export const MQTT_XOR_KEY = Buffer.from([0x12, 0x34, 0x56, 0x78]);

let cachedPublicKey: crypto.KeyObject | undefined;

function getAiperPublicKey(): crypto.KeyObject {
  if (!cachedPublicKey) {
    cachedPublicKey = crypto.createPublicKey({
      key: Buffer.from(AIPER_PUBLIC_KEY_DER_BASE64, 'base64'),
      format: 'der',
      type: 'spki',
    });
  }
  return cachedPublicKey;
}

/**
 * Implements the AES-128-CBC + RSA-PKCS1v15 envelope required by Aiper REST endpoints.
 * Creates a fresh random key/IV pair per instance to match the official mobile app.
 */
export class AiperCrypto {
  private readonly aesKey: Buffer;
  private readonly iv: Buffer;
  public readonly encryptKeyHeader: string;

  constructor() {
    this.aesKey = AiperCrypto.randomAsciiBytes(16);
    this.iv = AiperCrypto.randomAsciiBytes(16);
    this.encryptKeyHeader = this.buildEncryptKeyHeader();
  }

  public encryptRequest(body: Record<string, unknown>, nowMs: number = Date.now()): string {
    const payload: Record<string, unknown> = {
      ...body,
      nonce: AiperCrypto.randomNonce(),
      timestamp: nowMs,
    };

    const raw = Buffer.from(JSON.stringify(payload), 'utf8');
    const padded = AiperCrypto.zeroPad(raw, 16);

    const cipher = crypto.createCipheriv('aes-128-cbc', this.aesKey, this.iv);
    cipher.setAutoPadding(false);

    const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
    return JSON.stringify({ data: encrypted.toString('base64') });
  }

  public decryptResponse(responseText: string): string {
    if (!responseText) {
      return responseText;
    }

    // Unencrypted JSON responses (e.g. error envelopes) are returned directly.
    try {
      JSON.parse(responseText);
      return responseText;
    } catch {
      // Encrypted Base64 body; proceed to AES decryption.
    }

    const encrypted = Buffer.from(responseText.trim(), 'base64');
    const decipher = crypto.createDecipheriv('aes-128-cbc', this.aesKey, this.iv);
    decipher.setAutoPadding(false);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return AiperCrypto.zeroUnpad(decrypted).toString('utf8');
  }

  private buildEncryptKeyHeader(): string {
    const keyPayload = JSON.stringify({
      key: this.aesKey.toString('utf8'),
      iv: this.iv.toString('utf8'),
    });

    const encrypted = crypto.publicEncrypt(
      {
        key: getAiperPublicKey(),
        padding: crypto.constants.RSA_PKCS1_PADDING,
      },
      Buffer.from(keyPayload, 'utf8'),
    );

    return encrypted.toString('base64');
  }

  public static zeroPad(data: Buffer, blockSize = 16): Buffer {
    const padLength = blockSize - (data.length % blockSize);
    if (padLength === blockSize) {
      return data;
    }
    return Buffer.concat([data, Buffer.alloc(padLength, 0)]);
  }

  public static zeroUnpad(data: Buffer): Buffer {
    let end = data.length;
    while (end > 0 && data[end - 1] === 0) {
      end--;
    }
    return data.subarray(0, end);
  }

  private static randomAsciiBytes(length: number): Buffer {
    const bytes = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i++) {
      // Printable ASCII range 40..126 matching the Aiper mobile client
      bytes[i] = 40 + crypto.randomInt(87);
    }
    return bytes;
  }

  private static randomNonce(): string {
    let result = '';
    for (let i = 0; i < 4; i++) {
      result += NONCE_CHARS[crypto.randomInt(NONCE_CHARS.length)];
    }
    return result;
  }
}

/**
 * Computes the Aiper MQTT downChan CRC16 checksum (init 0x9966, polynomial 0xA001).
 */
export function calculateAiperCrc16(data: string): number {
  let crc = 0x9966;
  for (const byte of Buffer.from(data, 'utf8')) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      if ((crc & 1) !== 0) {
        crc = ((crc >>> 1) ^ 0xa001) & 0xffff;
      } else {
        crc = (crc >>> 1) & 0xffff;
      }
    }
  }
  return crc;
}

/**
 * Decodes an incoming MQTT payload that may be either plain UTF-8 JSON
 * or Base64 + 4-byte XOR encoded JSON.
 */
export function decodeMqttPayload(rawBytes: Uint8Array): string {
  const plainText = Buffer.from(rawBytes).toString('utf8').trim();
  if (!plainText) {
    return '';
  }

  if (plainText.startsWith('{') || plainText.startsWith('[')) {
    return plainText;
  }

  try {
    const decoded = Buffer.from(plainText, 'base64');
    if (decoded.length === 0) {
      return plainText;
    }
    const unxored = Buffer.allocUnsafe(decoded.length);
    for (let i = 0; i < decoded.length; i++) {
      unxored[i] = decoded[i] ^ MQTT_XOR_KEY[i % MQTT_XOR_KEY.length];
    }
    const candidate = unxored.toString('utf8').trim();
    JSON.parse(candidate);
    return candidate;
  } catch {
    return plainText;
  }
}

/**
 * Encodes a string with Aiper's 4-byte XOR + Base64 scheme (used primarily in unit tests).
 */
export function encodeXorMqttPayload(jsonText: string): Buffer {
  const src = Buffer.from(jsonText, 'utf8');
  const xored = Buffer.allocUnsafe(src.length);
  for (let i = 0; i < src.length; i++) {
    xored[i] = src[i] ^ MQTT_XOR_KEY[i % MQTT_XOR_KEY.length];
  }
  return Buffer.from(`${xored.toString('base64')}\n`, 'utf8');
}

/**
 * Redacts the middle characters of a serial number or identifier for safe logging.
 */
export function redactSerial(sn: string | undefined): string {
  if (!sn) {
    return 'unknown';
  }
  const trimmed = sn.trim();
  if (trimmed.length <= 6) {
    return '***';
  }
  return `${trimmed.slice(0, 3)}***${trimmed.slice(-3)}`;
}

