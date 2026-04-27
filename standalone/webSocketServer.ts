import * as crypto from 'crypto';
import * as http from 'http';
import * as net from 'net';

import type { ClientMessage, ServerMessage } from '../core/src/messages.js';

export type ClientRole = 'viewer' | 'producer';

interface ParsedFrame {
  bytesConsumed: number;
  opcode: number;
  payload: Buffer;
}

interface ConnectedClient {
  id: number;
  role: ClientRole;
  socket: net.Socket;
  buffer: Buffer;
}

function createAcceptValue(key: string): string {
  return crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, 'utf8')
    .digest('base64');
}

function parseFrame(buffer: Buffer): ParsedFrame | null {
  if (buffer.length < 2) return null;

  const firstByte = buffer[0];
  const secondByte = buffer[1];
  const fin = (firstByte & 0x80) !== 0;
  const opcode = firstByte & 0x0f;
  const masked = (secondByte & 0x80) !== 0;
  let offset = 2;
  let payloadLength = secondByte & 0x7f;

  if (!fin) {
    throw new Error('Fragmented WebSocket frames are not supported');
  }

  if (payloadLength === 126) {
    if (buffer.length < offset + 2) return null;
    payloadLength = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLength === 127) {
    if (buffer.length < offset + 8) return null;
    payloadLength = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }

  const maskLength = masked ? 4 : 0;
  if (buffer.length < offset + maskLength + payloadLength) {
    return null;
  }

  const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
  offset += maskLength;

  const payload = Buffer.from(buffer.subarray(offset, offset + payloadLength));
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }

  return {
    bytesConsumed: offset + payloadLength,
    opcode,
    payload,
  };
}

function encodeFrame(payload: Buffer): Buffer {
  const header =
    payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : payload.length < 65_536
        ? Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff])
        : (() => {
            const buffer = Buffer.alloc(10);
            buffer[0] = 0x81;
            buffer[1] = 127;
            buffer.writeBigUInt64BE(BigInt(payload.length), 2);
            return buffer;
          })();

  return Buffer.concat([header, payload]);
}

export class StandaloneWebSocketServer {
  private readonly clients = new Map<number, ConnectedClient>();
  private nextClientId = 1;

  constructor(
    server: http.Server,
    private readonly onMessage: (
      clientId: number,
      role: ClientRole,
      message: ClientMessage,
    ) => void,
    private readonly onConnect?: (clientId: number, role: ClientRole) => void,
  ) {
    server.on('upgrade', (request, socket) => {
      const role: ClientRole | null =
        request.url === '/ws' ? 'viewer' : request.url === '/ws/producer' ? 'producer' : null;
      if (!role) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      const key = request.headers['sec-websocket-key'];
      if (typeof key !== 'string') {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }

      const accept = createAcceptValue(key);
      socket.write(
        [
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${accept}`,
          '\r\n',
        ].join('\r\n'),
      );

      const client: ConnectedClient = {
        id: this.nextClientId++,
        role,
        socket: socket as net.Socket,
        buffer: Buffer.alloc(0),
      };
      this.clients.set(client.id, client);
      socket.on('data', (chunk) => this.handleData(client.id, chunk));
      socket.on('close', () => this.clients.delete(client.id));
      socket.on('error', () => this.clients.delete(client.id));
      this.onConnect?.(client.id, client.role);
    });
  }

  send(clientId: number, message: ClientMessage | ServerMessage): void {
    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }
    client.socket.write(encodeFrame(Buffer.from(JSON.stringify(message), 'utf8')));
  }

  broadcast(message: ServerMessage): void {
    for (const [clientId, client] of this.clients) {
      if (client.role === 'viewer') {
        this.send(clientId, message);
      }
    }
  }

  close(): void {
    for (const client of this.clients.values()) {
      client.socket.end();
    }
    this.clients.clear();
  }

  private handleData(clientId: number, chunk: Buffer): void {
    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }

    client.buffer = Buffer.concat([client.buffer, chunk]);
    while (true) {
      const frame = parseFrame(client.buffer);
      if (!frame) {
        return;
      }

      client.buffer = client.buffer.subarray(frame.bytesConsumed);

      if (frame.opcode === 0x8) {
        client.socket.end();
        this.clients.delete(clientId);
        return;
      }

      if (frame.opcode !== 0x1) {
        continue;
      }

      try {
        const parsed = JSON.parse(frame.payload.toString('utf8')) as ClientMessage;
        console.log(
          `[WS] client ${clientId} (${client.role}) →`,
          JSON.stringify(parsed).slice(0, 120),
        );
        this.onMessage(clientId, client.role, parsed);
      } catch (error) {
        console.error('[Pixel Agents] Failed to parse standalone WS message:', error);
      }
    }
  }
}
