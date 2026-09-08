'use strict';
const net = require('node:net');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { MAGIC_INITIAL, MAGIC_MESSAGE } = require('./scrcpy-protocol');

class ScrcpyDirectProxy extends EventEmitter {
  constructor(opts) {
    super();
    this.host = opts.host || '127.0.0.1';
    this.port = opts.port;
    this.udid = opts.udid;
    this.transport = opts.transport || 'tcp';
    this._forwardPool = opts.forwardPool || null;
    this._devicePort = opts.devicePort || 8886;
    this._allocation = null;
    this._allocationPromise = null;
    this._releasePromises = new WeakMap();
    this.reconnectMs = opts.reconnectMs || 1000;
    this.maxReconnectMs = opts.maxReconnectMs || 30000;
    this.socket = null;
    this.state = 'idle';
    this._closedByUser = false;
    this._attempt = 0;
    this._reconnectTimer = null;
    this._deviceMeta = opts.deviceMeta || null;
    this._encoders = opts.encoders || [];
  }
  connect() {
    if (this.socket || this._closedByUser) return;
    if (this.transport === 'websocket') {
      this._connectWebSocket();
      return;
    }
    this.state = 'connecting';
    const s = net.createConnection({ host: this.host, port: this.port });
    s.on('connect', () => {
      this.state = 'open';
      this._attempt = 0;
      this.emit('open');
      if (this._deviceMeta && this._deviceMeta.displayInfo) {
        const proto = require('./scrcpy-protocol');
        const blob = proto.composeInitialInfo({
          deviceName: this._deviceMeta.deviceName,
          displays: [{
            info: this._deviceMeta.displayInfo,
            connectionCount: 1,
            screen: {
              rect: { left:0, top:0, right: this._deviceMeta.displayInfo.width, bottom: this._deviceMeta.displayInfo.height },
              size: { width: this._deviceMeta.displayInfo.width, height: this._deviceMeta.displayInfo.height },
              rotation: this._deviceMeta.displayInfo.rotation,
            },
            videoSettings: {
              bitrate: 8000000, maxFps: 60, iFrameInterval: 2,
              bounds: null, crop: null, sendFrameMeta: false, lockedVideoOrientation: -1,
              displayId: 0, codecOptions: 'i-frame-interval=2', encoderName: null,
            },
          }],
          encoders: this._encoders,
        });
        this.emit('initial_info', blob);
      }
    });
    let headerSkipped = 0;
    const HEADER = 64;
    s.on('data', (chunk) => {
      this.emit('raw', chunk);
      if (headerSkipped < HEADER) {
        const needed = HEADER - headerSkipped;
        if (chunk.length <= needed) {
          headerSkipped += chunk.length;
          return;
        }
        const payload = chunk.slice(needed);
        headerSkipped = HEADER;
        if (payload.length > 0) this._emitPacket(payload);
      } else {
        this._emitPacket(chunk);
      }
    });
    s.on('close', () => {
      this.state = 'closed';
      this.socket = null;
      this.emit('close');
      if (!this._closedByUser) this._scheduleReconnect();
    });
    s.on('error', (err) => { this.emit('error', err); });
    this.socket = s;
  }
  _connectWebSocket() {
    this.state = 'connecting';
    const s = new WebSocket(`ws://${this.host}:${this.port}`, { perMessageDeflate: false });
    s.binaryType = 'arraybuffer';
    s.on('open', () => {
      this.state = 'open';
      this._attempt = 0;
      this.emit('open');
    });
    s.on('message', (data, isBinary) => {
      const chunk = isBinary && data instanceof Buffer ? data : Buffer.from(data);
      this.emit('raw', chunk);
      if (chunk.length >= MAGIC_INITIAL.length && chunk.subarray(0, MAGIC_INITIAL.length).equals(MAGIC_INITIAL)) {
        this.emit('initial_info', chunk);
      } else {
        this._emitPacket(chunk);
      }
    });
    s.on('close', () => {
      this.state = 'closed';
      this.socket = null;
      this.emit('close');
      if (!this._closedByUser) this._scheduleReconnect();
    });
    s.on('error', err => { this.emit('error', err); });
    this.socket = s;
  }
  _emitPacket(chunk) {
    if (chunk.length >= MAGIC_MESSAGE.length && chunk.subarray(0, MAGIC_MESSAGE.length).equals(MAGIC_MESSAGE)) {
      this.emit('device_message', chunk);
      return;
    }
    this.emit('frame', chunk);
  }
  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._attempt += 1;
    const delay = Math.min(this.reconnectMs * Math.pow(2, this._attempt - 1), this.maxReconnectMs);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._forwardPool) {
        // The adb forward allocation may have been released (tunnel drop, adb disconnect,
        // forwardPool recycled the entry). Clear stale allocation so connectViaAdb()
        // re-allocates a fresh host-side port instead of retrying a dead one.
        if (this._allocation) {
          this._releaseAllocation(this._allocation);
          this._allocation = null;
        }
        this.connectViaAdb().catch((err) => { this.emit('error', err); });
      } else {
        this.connect();
      }
    }, delay);
    if (this._reconnectTimer.unref) this._reconnectTimer.unref();
  }
  async connectViaAdb() {
    if (!this._forwardPool) {
      throw new Error('connectViaAdb requires forwardPool in opts');
    }
    if (!this._allocation && !this._allocationPromise) {
      this._allocationPromise = Promise.resolve(this._forwardPool.allocate(this.udid, this._devicePort));
    }
    if (!this._allocation) {
      const pending = this._allocationPromise;
      let allocation;
      try {
        allocation = await pending;
      } finally {
        if (this._allocationPromise === pending) this._allocationPromise = null;
      }
      if (this._closedByUser) {
        await this._releaseAllocation(allocation);
        return;
      }
      this._allocation = allocation;
      this.port = allocation.localPort;
      this.host = '127.0.0.1';
    }
    if (this._closedByUser) return;
    this.connect();
  }
  send(buf) {
    if (this.state === 'open' && this.socket) {
      if (this.transport === 'websocket') this.socket.send(buf, { binary: true });
      else this.socket.write(buf);
    }
  }
  sendControl(buf) {
    if (this.state === 'open' && this.socket) {
      try {
        if (this.transport === 'websocket') this.socket.send(buf, { binary: true });
        else this.socket.write(buf);
      }
      catch (e) { this.emit('error', e); }
    }
  }
  _releaseAllocation(allocation) {
    if (!allocation || typeof allocation.release !== 'function') return Promise.resolve();
    const existing = this._releasePromises.get(allocation);
    if (existing) return existing;
    const release = Promise.resolve().then(() => allocation.release()).catch(() => {});
    this._releasePromises.set(allocation, release);
    return release;
  }
  async close() {
    this._closedByUser = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this.socket) {
      try {
        if (this.transport === 'websocket') this.socket.terminate();
        else this.socket.destroy();
      } catch (_) {}
      this.socket = null;
    }
    this.state = 'closed';
    const allocation = this._allocation;
    this._allocation = null;
    const pending = this._allocationPromise;
    await this._releaseAllocation(allocation);
    if (pending) {
      try { await this._releaseAllocation(await pending); } catch (_) {}
      if (this._allocationPromise === pending) this._allocationPromise = null;
    }
  }
}

module.exports = { ScrcpyDirectProxy };
