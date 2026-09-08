// Stable device identity across transports. The adb "serial" is volatile — a
// USB udid OR a rotating tailnet ip:port — so one physical phone can appear
// under several serials over its lifetime. ro.serialno (hwSerial) is the
// stable id. These pure helpers collapse + resolve serials by hwSerial.
//
// No adb calls happen here: callers pass a live device list whose records
// already carry { serial, hwSerial, transport, tailnetIp?, tailnetPort? }.
// This keeps the identity rule in ONE place (device-handlers enumeration,
// the fleet registry, schedule reconciliation, and toolbar routing all share
// it) instead of re-deriving `serial.includes(':')` in a dozen spots.

const TAILNET_SERIAL_RE = /^\d+\.\d+\.\d+\.\d+:\d+$/

function classifyTransport(serial) {
  return TAILNET_SERIAL_RE.test(String(serial || '')) ? 'tcp' : 'usb'
}

function withStableHwSerialProvenance(device) {
  const stableHwSerial = device.hwSerial || null
  return {
    ...device,
    hwSerial: stableHwSerial || device.serial,
    stableHwSerial,
  }
}

function ipPort(serial) {
  const [ip, port] = String(serial).split(':')
  return { ip, port: parseInt(port, 10) || 5555 }
}

// Collapse USB + TCP rows of the same physical phone (matched by hwSerial)
// into one record. USB stays canonical (keeps its udid as `serial` so the
// nickname map still resolves); the TCP twin contributes tailnetIp/tailnetPort.
// Pure — does not mutate the input array's objects. Extracted verbatim from
// device-handlers.getConnectedDevices so every consumer dedups identically.
//
// `tailnetEndpoints` (optional): the caller's live tailnet endpoint cache,
// devKey(hwSerial) -> { ip }, accumulated from prior polls. It is the ONLY
// sound signal that links a null-hwSerial TCP IP to a specific USB host in the
// common 2-entry case [USB(udid,hwSerial), TCP(ip:port, hwSerial=null)]: the
// USB host's serial is its udid and carries no tailnet IP, so nothing INSIDE
// the row pair connects them. A tailnet IP belongs to exactly one phone, so
// reverse-resolving ip -> hwSerial via this cache and folding the orphan into
// that hwSerial's USB host is correct and can never merge two DIFFERENT phones.
function mergeByHwSerial(raw, tailnetEndpoints) {
  const byHw = new Map()
  const out = []
  // Reverse the devKey->{ip} cache into ip->devKey so a null-hwSerial TCP row's
  // IP can be resolved back to the phone that last advertised it.
  const hwByIp = new Map()
  // Guard 3: cache IPs that two different devKeys claim are poisoned — the cache
  // is internally inconsistent for that IP (a stale entry was never pruned for a
  // now-absent phone while a second phone picked up the freed Tailscale IP), so
  // we MUST NOT cache-fold it this poll. Let device-handlers prune/refresh next
  // poll. A folded host this poll proving an IP now belongs to a different
  // hwSerial also poisons that IP (handled in tryFoldOrphan).
  const poisonedIps = new Set()
  if (tailnetEndpoints) {
    for (const [devKey, ep] of Object.entries(tailnetEndpoints)) {
      if (!ep || !ep.ip) continue
      const prior = hwByIp.get(ep.ip)
      if (prior !== undefined && prior !== devKey) poisonedIps.add(ep.ip)
      hwByIp.set(ep.ip, devKey)
    }
  }
  // Process USB rows before TCP rows. The H4 fold + the usb<-tcp merge branch
  // both look up an ALREADY-SEEN usb host (out.find / byHw.get), so a TCP twin
  // that happened to enumerate before its USB host would miss the host and ship
  // a duplicate card (or key a null-hwSerial twin on its own ip:port). adb
  // devices has no guaranteed ordering, so make the merge order-independent with
  // a stable usb-first sort. Pure: copies the array, never mutates input.
  const ordered = (raw || []).slice().sort((a, b) => {
    const at = classifyTransport(a && a.serial) === 'usb' ? 0 : 1
    const bt = classifyTransport(b && b.serial) === 'usb' ? 0 : 1
    return at - bt
  })
  // Null-hwSerial TCP rows that found no USB host on the first pass. We can't
  // discard them yet (their host may sort after them in pathological orders, or
  // be linkable only via the injected cache), so defer to a second pass.
  const deferredOrphans = []
  for (const d of ordered) {
    // H4: a TCP entry whose ro.serialno read failed (hwSerial===null) would
    // otherwise key on its own ip:port and ship as a SECOND card for a phone
    // already merged under its USB hwSerial. Before falling back to serial as
    // the key, try to match this null-hwSerial TCP entry's IP against a known
    // USB record and fold it in as that phone's tailnet transport. Additive:
    // only fires for null-hwSerial TCP rows; non-null rows are unaffected.
    if (!d.hwSerial && classifyTransport(d.serial) === 'tcp') {
      const { ip, port } = ipPort(d.serial)
      // Match this null-hwSerial TCP twin to its USB host by IP, comparing
      // against the host's classifyTransport-derived IP (tailnetIpOf) — its
      // folded tailnetIp OR, failing that, the IP parsed from the host's own
      // serial. This catches the 3-entry case where a sibling TCP row already
      // populated host.tailnetIp. The 2-entry [USB(udid), null-TCP] case has
      // NO such signal (USB serial is a udid, tailnetIp not yet folded), so it
      // misses here and is deferred to the cache-backed second pass below.
      const host = out.find(r => r.transport === 'usb' && tailnetIpOf(r) === ip)
      if (host) {
        host.tailnetIp = ip; host.tailnetPort = port
        continue
      }
      // No LIVE in-row signal yet. Defer the cache-backed fold to the second pass
      // unconditionally: a sibling TCP row carrying a real hwSerial may still be
      // unprocessed in this same poll, and folding eagerly here would route this
      // orphan off the STALE cache before that live evidence binds its host. By
      // the second pass every host (and every live tailnetIp) is bound, so
      // tryFoldOrphan's guards can compare the cache against live data and
      // DECLINE a stale cross-fold instead of guessing.
      deferredOrphans.push({ d, ip, port })
      continue
    }
    const key = d.hwSerial || d.serial
    const existing = byHw.get(key)
    if (existing) {
      if (d.transport === 'tcp' && existing.transport === 'usb') {
        const { ip, port } = ipPort(d.serial)
        existing.tailnetIp = ip; existing.tailnetPort = port
      } else if (d.transport === 'usb' && existing.transport === 'tcp') {
        const { ip, port } = ipPort(existing.serial)
        Object.assign(existing, d, { tailnetIp: ip, tailnetPort: port })
      }
      continue
    }
    const rec = { ...d }
    if (rec.transport === 'tcp') {
      const { ip, port } = ipPort(rec.serial)
      rec.tailnetIp = ip; rec.tailnetPort = port
    }
    byHw.set(key, rec)
    out.push(rec)
  }
  // Second pass: every USB host is now in `out`. Retry each deferred orphan —
  // fold it into the cache-resolved USB host if that host materialized, else
  // emit it as its own record (the safe pre-existing behavior: a real lone TCP
  // phone, or a cache miss we must not guess on).
  for (const { d, ip, port } of deferredOrphans) {
    if (tryFoldOrphan(d, ip, port, out, hwByIp, poisonedIps)) continue
    const rec = { ...d, tailnetIp: ip, tailnetPort: port }
    byHw.set(d.serial, rec)
    out.push(rec)
  }
  return out
}

// Fold a null-hwSerial TCP orphan into its USB host using the injected tailnet
// endpoint cache: reverse-resolve ip -> hwSerial, then find that hwSerial's USB
// host already in `out`. Returns true if folded, false if no sound link exists
// or the link is untrustworthy — in which case the caller keeps the orphan
// separate (its own card / second pass), so the worst case is a transient
// duplicate card for one poll, never a misroute.
//
// The cache (lastKnownTailnet) is only pruned when a phone is present-but-
// twinless for several polls and is NEVER pruned for a fully-absent phone, so
// across a reboot/Tailscale-recycle two phones can swap IPs while the cache
// still maps the orphan's CURRENT ip to the PREVIOUS owner's hwSerial. The
// guards below ensure live in-row evidence always overrides the stale cache and
// we DECLINE rather than guess on any conflict — only ever declining a fold,
// never reassigning a transport.
function tryFoldOrphan(d, ip, port, out, hwByIp, poisonedIps) {
  // Guard 3: this IP is internally inconsistent in the cache this poll — do not
  // cache-fold it. (Live in-row matches below still apply and can win.)
  const poisoned = poisonedIps && poisonedIps.has(ip)
  // Guard 2 (live wins): if a present USB host independently advertises this IP
  // as its OWN live tailnet endpoint (its folded tailnetIp, or an ip:port serial),
  // that live in-row evidence is authoritative — fold into THAT host regardless
  // of what the (possibly stale) cache says.
  const liveHost = out.find(r => r.transport === 'usb' && tailnetIpOf(r) === ip)
  const hw = hwByIp.get(ip)
  if (liveHost) {
    if (hw && liveHost.hwSerial !== hw) poisonedIps && poisonedIps.add(ip)
    liveHost.tailnetIp = ip; liveHost.tailnetPort = port
    return true
  }
  if (poisoned) return false
  if (!hw) return false
  const host = out.find(r => r.transport === 'usb' && r.hwSerial === hw)
  if (!host) return false
  // Guard 1: the cache resolved this IP to `host`, but if `host` has ALREADY
  // bound a DIFFERENT live tailnet IP this poll, the cache disagrees with live
  // data (the IPs were swapped/recycled) — the in-row signal wins, so decline
  // and poison the IP so no later orphan trusts this stale mapping either.
  if (host.tailnetIp && host.tailnetIp !== ip) {
    poisonedIps && poisonedIps.add(ip)
    return false
  }
  host.tailnetIp = ip; host.tailnetPort = port
  return true
}

// IP a host record resolves to: its folded tailnetIp if a TCP twin already
// populated it, else — if its own serial is an ip:port form — the IP parsed
// from that serial via classifyTransport. The H4 fold uses this so a
// null-hwSerial TCP twin can match a USB host by its classifyTransport-derived
// IP, not only a pre-populated tailnetIp.
function tailnetIpOf(d) {
  return d.tailnetIp || (classifyTransport(d.serial) === 'tcp' ? ipPort(d.serial).ip : null)
}

// Resolve a stored/target serial (udid, hwSerial, or ip:port — including a
// rotated tailnet port) to the live adb serial of the SAME physical phone.
// Match order: exact serial -> hwSerial -> tailnet-IP (rotated-port tolerant).
// Returns null if nothing matches — deliberately NO "only one phone, so it
// must be that one" fallback, which silently misroutes on a multi-phone fleet
// during transient enumeration.
function resolveLiveSerial(target, liveDevices) {
  if (!target) return null
  const list = liveDevices || []
  for (const d of list) if (d.serial === target) return d.serial
  for (const d of list) if (d.hwSerial && d.hwSerial === target) return d.serial
  if (TAILNET_SERIAL_RE.test(target)) {
    const { ip } = ipPort(target)
    for (const d of list) {
      if (tailnetIpOf(d) === ip) return d.serial
    }
  }
  return null
}

// hwSerial of a stored/target serial as seen in the live device list (or null).
function hwSerialFor(target, liveDevices) {
  if (!target) return null
  const list = liveDevices || []
  for (const d of list) {
    if (d.serial === target || (d.hwSerial && d.hwSerial === target)) return d.hwSerial || d.serial
  }
  if (TAILNET_SERIAL_RE.test(target)) {
    const { ip } = ipPort(target)
    for (const d of list) if (tailnetIpOf(d) === ip) return d.hwSerial || d.serial
  }
  return null
}

// Resolve a schedule row's STORED serial to a live adb serial given only a
// plain serial list (no hwSerial — e.g. raw `adb devices` at dispatch time).
// Tailnet rows (<ip>:port) match by IP so a rotated boot port still resolves;
// otherwise exact match. The single-phone convenience fallback fires ONLY for a
// NON-tailnet row: a tailnet row whose IP matched no live phone is a DIFFERENT
// phone, and returning the lone live serial would post to the wrong account.
function resolveFromSerialList(rowSerial, serials) {
  const list = (serials || []).filter(Boolean)
  // Match ANY IPv4 tailnet row (not just the 100.x Tailscale CGNAT block) so a
  // custom/non-100.x range still resolves a rotated boot port — and, critically,
  // so the lone-phone fallback below NEVER fires for an ip:port-shaped row whose
  // IP simply matched no live phone (that's a DIFFERENT phone; returning the lone
  // live serial would post to the wrong account). Aligned with TAILNET_SERIAL_RE.
  const ipM = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::\d+)?$/.exec(rowSerial || '')
  if (ipM) {
    const live = list.find(s => s.startsWith(ipM[1] + ':'))
    if (live) return live
  }
  if (rowSerial && list.includes(rowSerial)) return rowSerial
  if (list.length === 1 && !ipM) return list[0]
  return null
}

// Do two serials refer to the same physical phone, per the live device list?
function sameDevice(a, b, liveDevices) {
  const ra = resolveLiveSerial(a, liveDevices)
  const rb = resolveLiveSerial(b, liveDevices)
  return !!ra && ra === rb
}

module.exports = {
  TAILNET_SERIAL_RE, classifyTransport, mergeByHwSerial,
  resolveLiveSerial, hwSerialFor, sameDevice, resolveFromSerialList,
  withStableHwSerialProvenance,
}
