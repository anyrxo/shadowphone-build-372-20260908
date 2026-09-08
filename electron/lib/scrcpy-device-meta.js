'use strict';

const { runAdb } = require('./adb-util');

function parseDeviceName(propsOutput) {
  const m = propsOutput.match(/\[ro\.product\.model\]:\s*\[([^\]]+)\]/);
  return m ? m[1] : 'Android Device';
}

function parseDumpsysDisplay(dump) {
  const sizeMatch = dump.match(/(\d+)\s*x\s*(\d+)/);
  const rotMatch = dump.match(/rotation\s+(\d+)/);
  if (!sizeMatch) return null;
  return {
    displayId: 0,
    width: parseInt(sizeMatch[1], 10),
    height: parseInt(sizeMatch[2], 10),
    rotation: rotMatch ? parseInt(rotMatch[1], 10) : 0,
    layerStack: 0,
    flags: 0,
  };
}

async function fetchDeviceMeta(adbPath, serial) {
  const propsResult = await runAdb(adbPath, ['-s', serial, 'shell', 'getprop ro.product.model']);
  const dumpResult = await runAdb(adbPath, ['-s', serial, 'shell', 'dumpsys display']);

  if (propsResult.code !== 0) {
    throw new Error(`Failed to get device props: ${propsResult.stderr}`);
  }
  if (dumpResult.code !== 0) {
    throw new Error(`Failed to get display info: ${dumpResult.stderr}`);
  }

  return {
    deviceName: parseDeviceName(propsResult.stdout),
    displayInfo: parseDumpsysDisplay(dumpResult.stdout),
  };
}

module.exports = { fetchDeviceMeta, parseDeviceName, parseDumpsysDisplay };
