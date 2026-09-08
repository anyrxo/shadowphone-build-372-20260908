'use strict';

const DEVICE_NAME_FIELD_LENGTH = 64;
const MAGIC_INITIAL = Buffer.from('scrcpy_initial', 'utf8');
const MAGIC_MESSAGE = Buffer.from('scrcpy_message', 'utf8');
const DISPLAY_INFO_BUFFER_LENGTH = 24;
const SCREEN_INFO_BUFFER_LENGTH = 25;
const VIDEO_SETTINGS_BASE_BUFFER_LENGTH = 35;
const FRAME_META_LENGTH = 12;

const CTRL = Object.freeze({
  INJECT_KEYCODE: 0,
  INJECT_TEXT: 1,
  INJECT_TOUCH_EVENT: 2,
  INJECT_SCROLL_EVENT: 3,
  BACK_OR_SCREEN_ON: 4,
  EXPAND_NOTIFICATION_PANEL: 5,
  CHANGE_STREAM_PARAMETERS: 6,
  COLLAPSE_NOTIFICATION_PANEL: 7,
  GET_CLIPBOARD: 8,
  SET_CLIPBOARD: 9,
  SET_SCREEN_POWER_MODE: 10,
  ROTATE_DEVICE: 11,
  PUSH_FILE: 12,
});

function encodeDisplayInfo(d) {
  const buf = Buffer.alloc(DISPLAY_INFO_BUFFER_LENGTH);
  let o = 0;
  buf.writeInt32BE(d.displayId, o); o += 4;
  buf.writeInt32BE(d.width, o); o += 4;
  buf.writeInt32BE(d.height, o); o += 4;
  buf.writeInt32BE(d.rotation, o); o += 4;
  buf.writeInt32BE(d.layerStack, o); o += 4;
  buf.writeInt32BE(d.flags, o); o += 4;
  return buf;
}

function decodeDisplayInfo(buf) {
  if (buf.length !== DISPLAY_INFO_BUFFER_LENGTH) {
    throw new Error(`DisplayInfo expects ${DISPLAY_INFO_BUFFER_LENGTH} bytes, got ${buf.length}`);
  }
  return {
    displayId: buf.readInt32BE(0),
    width: buf.readInt32BE(4),
    height: buf.readInt32BE(8),
    rotation: buf.readInt32BE(12),
    layerStack: buf.readInt32BE(16),
    flags: buf.readInt32BE(20),
  };
}

function encodeScreenInfo(s) {
  const buf = Buffer.alloc(SCREEN_INFO_BUFFER_LENGTH);
  buf.writeInt32BE(s.rect.left, 0);
  buf.writeInt32BE(s.rect.top, 4);
  buf.writeInt32BE(s.rect.right, 8);
  buf.writeInt32BE(s.rect.bottom, 12);
  buf.writeInt32BE(s.size.width, 16);
  buf.writeInt32BE(s.size.height, 20);
  buf.writeUInt8(s.rotation, 24);
  return buf;
}

function decodeScreenInfo(buf) {
  if (buf.length !== SCREEN_INFO_BUFFER_LENGTH) {
    throw new Error(`ScreenInfo expects ${SCREEN_INFO_BUFFER_LENGTH} bytes, got ${buf.length}`);
  }
  return {
    rect: {
      left: buf.readInt32BE(0),
      top: buf.readInt32BE(4),
      right: buf.readInt32BE(8),
      bottom: buf.readInt32BE(12),
    },
    size: {
      width: buf.readInt32BE(16),
      height: buf.readInt32BE(20),
    },
    rotation: buf.readUInt8(24),
  };
}

function encodeVideoSettings(v) {
  const codecOpts = v.codecOptions ? Buffer.from(v.codecOptions, 'utf8') : Buffer.alloc(0);
  const encoderName = v.encoderName ? Buffer.from(v.encoderName, 'utf8') : Buffer.alloc(0);
  const total = VIDEO_SETTINGS_BASE_BUFFER_LENGTH + 4 + codecOpts.length + 4 + encoderName.length;
  const buf = Buffer.alloc(total);
  let o = 0;
  buf.writeInt32BE(v.bitrate, o); o += 4;
  buf.writeInt32BE(v.maxFps, o); o += 4;
  buf.writeInt8(v.iFrameInterval, o); o += 1;
  buf.writeInt16BE(v.bounds ? v.bounds.width : 0, o); o += 2;
  buf.writeInt16BE(v.bounds ? v.bounds.height : 0, o); o += 2;
  buf.writeInt16BE(v.crop ? v.crop.left : 0, o); o += 2;
  buf.writeInt16BE(v.crop ? v.crop.top : 0, o); o += 2;
  buf.writeInt16BE(v.crop ? v.crop.right : 0, o); o += 2;
  buf.writeInt16BE(v.crop ? v.crop.bottom : 0, o); o += 2;
  buf.writeInt8(v.sendFrameMeta ? 1 : 0, o); o += 1;
  buf.writeInt8(v.lockedVideoOrientation, o); o += 1;
  buf.writeInt32BE(v.displayId, o); o += 4;
  buf.writeInt32BE(codecOpts.length, o); o += 4;
  codecOpts.copy(buf, o); o += codecOpts.length;
  buf.writeInt32BE(encoderName.length, o); o += 4;
  encoderName.copy(buf, o);
  return buf;
}

function decodeVideoSettings(buf) {
  let o = 0;
  const bitrate = buf.readInt32BE(o); o += 4;
  const maxFps = buf.readInt32BE(o); o += 4;
  const iFrameInterval = buf.readInt8(o); o += 1;
  const w = buf.readInt16BE(o); o += 2;
  const h = buf.readInt16BE(o); o += 2;
  const left = buf.readInt16BE(o); o += 2;
  const top = buf.readInt16BE(o); o += 2;
  const right = buf.readInt16BE(o); o += 2;
  const bottom = buf.readInt16BE(o); o += 2;
  const sendFrameMeta = !!buf.readInt8(o); o += 1;
  const lockedVideoOrientation = buf.readInt8(o); o += 1;
  const displayId = buf.readInt32BE(o); o += 4;
  const codecLen = buf.readInt32BE(o); o += 4;
  const codecOptions = codecLen ? buf.slice(o, o + codecLen).toString('utf8') : null;
  o += codecLen;
  const nameLen = buf.readInt32BE(o); o += 4;
  const encoderName = nameLen ? buf.slice(o, o + nameLen).toString('utf8') : null;
  return {
    bitrate, maxFps, iFrameInterval,
    bounds: (w !== 0 && h !== 0) ? { width: w, height: h } : null,
    crop: (left || top || right || bottom) ? { left, top, right, bottom } : null,
    sendFrameMeta, lockedVideoOrientation, displayId,
    codecOptions, encoderName,
  };
}

function composeInitialInfo(meta) {
  const parts = [];
  parts.push(MAGIC_INITIAL);
  const nameBuf = Buffer.alloc(DEVICE_NAME_FIELD_LENGTH);
  Buffer.from(meta.deviceName || '', 'utf8').copy(nameBuf, 0, 0, DEVICE_NAME_FIELD_LENGTH);
  parts.push(nameBuf);
  const displaysCount = Buffer.alloc(4);
  displaysCount.writeInt32BE(meta.displays.length, 0);
  parts.push(displaysCount);
  for (const d of meta.displays) {
    parts.push(encodeDisplayInfo(d.info));
    const cc = Buffer.alloc(4); cc.writeInt32BE(d.connectionCount || 0, 0); parts.push(cc);
    const screenBuf = d.screen ? encodeScreenInfo(d.screen) : Buffer.alloc(0);
    const sl = Buffer.alloc(4); sl.writeInt32BE(screenBuf.length, 0); parts.push(sl, screenBuf);
    const vsBuf = d.videoSettings ? encodeVideoSettings(d.videoSettings) : Buffer.alloc(0);
    const vl = Buffer.alloc(4); vl.writeInt32BE(vsBuf.length, 0); parts.push(vl, vsBuf);
  }
  const encCount = Buffer.alloc(4);
  encCount.writeInt32BE(meta.encoders.length, 0);
  parts.push(encCount);
  for (const name of meta.encoders) {
    const nameB = Buffer.from(name, 'utf8');
    const nl = Buffer.alloc(4); nl.writeInt32BE(nameB.length, 0);
    parts.push(nl, nameB);
  }
  const clientId = Buffer.alloc(4);
  clientId.writeInt32BE(Number.isInteger(meta.clientId) ? meta.clientId : 0, 0);
  parts.push(clientId);
  return Buffer.concat(parts);
}

function parseFrameMeta(buf) {
  if (buf.length < FRAME_META_LENGTH) throw new Error(`frame meta needs ${FRAME_META_LENGTH} bytes`);
  const flags = buf.readUInt8(0);
  const size = buf.readUInt32BE(8);
  return {
    keyFrame: (flags & 0x02) !== 0,
    config: (flags & 0x01) !== 0,
    size,
  };
}

function findStartCodeOffset(buf) {
  for (let i = 0; i + 4 < buf.length; i++) {
    if (buf[i] === 0 && buf[i+1] === 0) {
      if (buf[i+2] === 1) return i + 3;
      if (buf[i+2] === 0 && buf[i+3] === 1) return i + 4;
    }
  }
  return -1;
}

function nalType(buf) {
  const off = findStartCodeOffset(buf);
  if (off < 0 || off >= buf.length) return -1;
  return buf[off] & 0x1f;
}

function isKeyframeNAL(buf) {
  return nalType(buf) === 5;
}

function isConfigNAL(buf) {
  const t = nalType(buf);
  return t === 7 || t === 8;
}

function encodeTouchEvent(t) {
  const buf = Buffer.alloc(28);
  let o = 0;
  buf.writeUInt8(CTRL.INJECT_TOUCH_EVENT, o); o += 1;
  buf.writeUInt8(t.action & 0xff, o); o += 1;
  buf.writeBigUInt64BE(BigInt(t.pointerId), o); o += 8;
  buf.writeInt32BE(t.x | 0, o); o += 4;
  buf.writeInt32BE(t.y | 0, o); o += 4;
  buf.writeUInt16BE(t.screenWidth & 0xffff, o); o += 2;
  buf.writeUInt16BE(t.screenHeight & 0xffff, o); o += 2;
  const pressureFixed = Math.min(0xffff, Math.max(0, Math.round((t.pressure || 0) * 0xffff)));
  buf.writeUInt16BE(pressureFixed, o); o += 2;
  buf.writeInt32BE(t.buttons || 0, o);
  return buf;
}

function encodeKeycode(k) {
  const buf = Buffer.alloc(14);
  buf.writeUInt8(CTRL.INJECT_KEYCODE, 0);
  buf.writeUInt8(k.action & 0xff, 1);
  buf.writeInt32BE(k.keycode | 0, 2);
  buf.writeInt32BE(k.repeat | 0, 6);
  buf.writeInt32BE(k.metaState | 0, 10);
  return buf;
}

function encodeScroll(s) {
  const buf = Buffer.alloc(21);
  let o = 0;
  buf.writeUInt8(CTRL.INJECT_SCROLL_EVENT, o); o += 1;
  buf.writeInt32BE(s.x | 0, o); o += 4;
  buf.writeInt32BE(s.y | 0, o); o += 4;
  buf.writeUInt16BE(s.screenWidth & 0xffff, o); o += 2;
  buf.writeUInt16BE(s.screenHeight & 0xffff, o); o += 2;
  const toFixed = v => Math.max(-32768, Math.min(32767, Math.round((v || 0) * 32768)));
  buf.writeInt16BE(toFixed(s.hScroll), o); o += 2;
  buf.writeInt16BE(toFixed(s.vScroll), o); o += 2;
  buf.writeInt32BE(s.buttons | 0, o);
  return buf;
}

module.exports = {
  DEVICE_NAME_FIELD_LENGTH,
  MAGIC_INITIAL,
  MAGIC_MESSAGE,
  DISPLAY_INFO_BUFFER_LENGTH,
  SCREEN_INFO_BUFFER_LENGTH,
  VIDEO_SETTINGS_BASE_BUFFER_LENGTH,
  FRAME_META_LENGTH,
  CTRL,
  encodeDisplayInfo,
  decodeDisplayInfo,
  encodeScreenInfo,
  decodeScreenInfo,
  encodeVideoSettings,
  decodeVideoSettings,
  composeInitialInfo,
  parseFrameMeta,
  findStartCodeOffset,
  nalType,
  isKeyframeNAL,
  isConfigNAL,
  encodeTouchEvent,
  encodeKeycode,
  encodeScroll,
};
