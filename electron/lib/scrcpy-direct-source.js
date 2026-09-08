'use strict';
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const { ScrcpyDirectProxy } = require('./scrcpy-direct-proxy');

class ScrcpyDirectStreamSource extends EventEmitter {
  constructor(opts) {
    super();
    this.readyState = WebSocket.CONNECTING;
    this._proxy = new ScrcpyDirectProxy({ ...opts, transport: opts.transport || 'websocket' });
    this._proxy.on('open', () => {
      this.readyState = WebSocket.OPEN;
      this.emit('open');
    });
    this._proxy.on('initial_info', (b) => this.emit('initial_info', b));
    this._proxy.on('frame', (c) => this.emit('frame', c));
    this._proxy.on('device_message', (c) => this.emit('device_message', c));
    this._proxy.on('close', () => { void this._transitionClosed(1006); });
    this._proxy.on('error', (e) => this.emit('error', e));
  }
  _transitionClosed(code) {
    if (this.readyState === WebSocket.CLOSED) return this._closeTransition || Promise.resolve();
    if (this._closeTransition) return this._closeTransition;
    // FanOut owns reconnects for this source. Close the underlying proxy
    // first so it cancels its own retry timer and releases its ADB forward.
    this.readyState = WebSocket.CLOSED;
    this._closeTransition = Promise.resolve(this._proxy.close()).then(() => {
      this.emit('close', code);
    });
    return this._closeTransition;
  }
  _connectFailed(error) {
    this.emit('error', error);
    this._transitionClosed(1006);
  }
  open() {
    this.readyState = WebSocket.CONNECTING;
    try {
      if (this._proxy._forwardPool) {
        Promise.resolve(this._proxy.connectViaAdb()).catch(error => this._connectFailed(error));
      } else {
        this._proxy.connect();
      }
    } catch (error) {
      this._connectFailed(error);
    }
  }
  send(buf) { this._proxy.sendControl(buf); }
  close() {
    if (this._closeTransition) return this._closeTransition;
    if (this.readyState === WebSocket.CLOSED) return Promise.resolve();
    this.readyState = WebSocket.CLOSING;
    return Promise.resolve(this._proxy.close()).then(() => {
      this.readyState = WebSocket.CLOSED;
    });
  }
}

module.exports = { ScrcpyDirectStreamSource };
