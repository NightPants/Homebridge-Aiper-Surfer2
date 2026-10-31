import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AiperCrypto,
  calculateAiperCrc16,
  decodeMqttPayload,
  encodeXorMqttPayload,
  redactSerial,
} from '../src/aiperCrypto.js';

describe('AiperCrypto & Protocol Helpers', () => {
  it('generates a 128-byte Base64 RSA encryptKey header and round-trips AES-128-CBC payloads', () => {
    const envelope = new AiperCrypto();
    const headerBytes = Buffer.from(envelope.encryptKeyHeader, 'base64');
    assert.equal(headerBytes.length, 128);

    const requestJson = envelope.encryptRequest({ sn: '5312345678901234', cleanPath: 1 }, 1700000000000);
    const parsedWrapper = JSON.parse(requestJson) as { data: string };
    assert.equal(typeof parsedWrapper.data, 'string');
    assert.ok(parsedWrapper.data.length > 0);

    // Decrypt the ciphertext back using the same session key/IV
    const decryptedJson = envelope.decryptResponse(parsedWrapper.data);
    const decrypted = JSON.parse(decryptedJson) as Record<string, unknown>;

    assert.equal(decrypted.sn, '5312345678901234');
    assert.equal(decrypted.cleanPath, 1);
    assert.equal(decrypted.timestamp, 1700000000000);
    assert.equal(typeof decrypted.nonce, 'string');
    assert.equal((decrypted.nonce as string).length, 4);
  });

  it('passes through unencrypted JSON error responses unchanged', () => {
    const envelope = new AiperCrypto();
    const rawError = JSON.stringify({ code: '402', msg: 'Account logged in elsewhere' });
    assert.equal(envelope.decryptResponse(rawError), rawError);
    assert.equal(envelope.decryptResponse(''), '');
  });

  it('handles zeroPad and zeroUnpad across exact and partial 16-byte boundaries', () => {
    const exact16 = Buffer.from('0123456789abcdef', 'utf8');
    const paddedExact = AiperCrypto.zeroPad(exact16, 16);
    assert.equal(paddedExact.length, 16);
    assert.deepEqual(AiperCrypto.zeroUnpad(paddedExact), exact16);

    const partial10 = Buffer.from('0123456789', 'utf8');
    const paddedPartial = AiperCrypto.zeroPad(partial10, 16);
    assert.equal(paddedPartial.length, 16);
    assert.equal(paddedPartial[15], 0);
    assert.deepEqual(AiperCrypto.zeroUnpad(paddedPartial), partial10);
  });

  it('computes deterministic Aiper CRC16 checksums for downChan AT commands', () => {
    const startPayload = JSON.stringify({
      sn: '5300000000000001',
      timeZone: 'UTC-4',
      cmd: 'AT+MODE=1',
    });
    const stopPayload = JSON.stringify({
      sn: '5300000000000001',
      timeZone: 'UTC-4',
      cmd: 'AT+MODE=0',
    });

    const crcStart1 = calculateAiperCrc16(startPayload);
    const crcStart2 = calculateAiperCrc16(startPayload);
    const crcStop = calculateAiperCrc16(stopPayload);

    assert.equal(crcStart1, crcStart2);
    assert.notEqual(crcStart1, crcStop);
    assert.ok(crcStart1 >= 0 && crcStart1 <= 0xffff);
  });

  it('decodes both plain UTF-8 JSON and 4-byte XOR + Base64 MQTT payloads', () => {
    const shadowSample = JSON.stringify({
      state: {
        reported: {
          Machine: { status: 129, mode: 1, cap: 87, solar_status: 1 },
        },
      },
    });

    assert.equal(decodeMqttPayload(Buffer.from(shadowSample, 'utf8')), shadowSample);

    const xorEncoded = encodeXorMqttPayload(shadowSample);
    assert.equal(decodeMqttPayload(xorEncoded), shadowSample);
    assert.equal(decodeMqttPayload(Buffer.from('   ', 'utf8')), '');
  });

  it('redacts device serial numbers safely for logs', () => {
    assert.equal(redactSerial('5312345678909876'), '531***876');
    assert.equal(redactSerial('123456'), '***');
    assert.equal(redactSerial(undefined), 'unknown');
  });
});
