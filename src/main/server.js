'use strict';

const net = require('node:net');

// Версия протокола в handshake для Server List Ping. Сервер не проверяет её
// для статуса, поэтому достаточно любого современного значения.
const PROTOCOL_VERSION = 767;

function varInt(value) {
  const bytes = [];
  let rest = value >>> 0;

  do {
    let byte = rest & 0x7f;
    rest >>>= 7;
    if (rest !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (rest !== 0);

  return Buffer.from(bytes);
}

function readVarInt(buffer, offset = 0) {
  let value = 0;
  let shift = 0;

  for (let index = offset; index < buffer.length; index += 1) {
    const byte = buffer[index];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, size: index - offset + 1 };
    shift += 7;
    if (shift > 35) return null;
  }

  return null;
}

function stripColors(text) {
  return String(text || '').replace(/§./g, '');
}

function motdText(description) {
  if (!description) return '';
  if (typeof description === 'string') return stripColors(description).trim();

  const parts = [description.text || ''];
  for (const extra of description.extra || []) {
    parts.push(typeof extra === 'string' ? extra : extra?.text || '');
  }

  return stripColors(parts.join('')).trim();
}

function parseAddress(value) {
  const text = String(value || '').trim();
  if (!text) return null;

  const index = text.lastIndexOf(':');
  if (index > 0) {
    const port = Number(text.slice(index + 1));
    if (Number.isFinite(port) && port > 0) return { host: text.slice(0, index), port };
  }

  return { host: text, port: 25565 };
}

function pingServer(host, port = 25565, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    let received = Buffer.alloc(0);

    const socket = net.createConnection({ host, port });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => finish({ online: false, error: 'Таймаут' }));
    socket.once('error', (error) => finish({ online: false, error: error.code || error.message }));

    socket.once('connect', () => {
      const hostBuffer = Buffer.from(host, 'utf8');
      const portBuffer = Buffer.alloc(2);
      portBuffer.writeUInt16BE(port, 0);

      const handshake = Buffer.concat([
        varInt(0x00),
        varInt(PROTOCOL_VERSION),
        varInt(hostBuffer.length),
        hostBuffer,
        portBuffer,
        varInt(1),
      ]);
      socket.write(Buffer.concat([varInt(handshake.length), handshake]));

      const request = varInt(0x00);
      socket.write(Buffer.concat([varInt(request.length), request]));
    });

    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk]);

      const length = readVarInt(received, 0);
      if (!length || received.length < length.size + length.value) return;

      const packet = received.subarray(length.size, length.size + length.value);
      const packetId = readVarInt(packet, 0);
      if (!packetId || packetId.value !== 0x00) {
        finish({ online: false, error: 'Неожиданный ответ сервера' });
        return;
      }

      const textLength = readVarInt(packet, packetId.size);
      if (!textLength) return;

      const start = packetId.size + textLength.size;
      const jsonText = packet.subarray(start, start + textLength.value).toString('utf8');

      let data;
      try {
        data = JSON.parse(jsonText);
      } catch {
        finish({ online: false, error: 'Некорректный ответ сервера' });
        return;
      }

      finish({
        online: true,
        players: {
          online: Number(data.players?.online) || 0,
          max: Number(data.players?.max) || 0,
        },
        version: data.version?.name || '',
        motd: motdText(data.description),
        latency: Date.now() - startedAt,
      });
    });
  });
}

module.exports = {
  parseAddress,
  pingServer,
  motdText,
  varInt,
  readVarInt,
};
