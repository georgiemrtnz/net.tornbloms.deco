// Regression test for the single shared poller (v1.4.84).
//
// Before this, each paired Deco node ran its own timer and fetched the same
// mesh-wide device_list every cycle, so a 3-node mesh made 3 identical calls.
// lib/hostPoller.ts now fetches it once per host per cycle and hands it to
// every node. This test drives HostPoller with fake timers and asserts:
//   1. 3 subscribed devices -> exactly 1 device_list fetch per cycle.
//   2. Each device derives its own node's data from the shared result.
//   3. Concurrent fetch requests share one in-flight call.
//   4. Removing the last device stops the poller (no timer left).
//   5. A failed shared fetch reaches every device in the same cycle, their
//      re-auths collapse into ONE login (in-flight auth dedupe), and devices
//      in backoff cause the shared fetch to be skipped (no storm).
//   6. Per-device interval: host polls at the minimum; slower devices only
//      run once their own interval has elapsed.
//
// Run with: npx tsc -p test/tsconfig.json && node test/dist/test/regression-shared-host-poller.js

import assert from 'assert';
import HostPoller, { PollerTimers } from '../lib/hostPoller';

class FakeClock implements PollerTimers {
  t = 1_000_000;
  private seq = 0;
  timers = new Map<number, { at: number; fn: () => void }>();
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  };
  clearTimeout = (id: any) => {
    this.timers.delete(id);
  };
  now = () => this.t;
  /** Advances time, firing due timers, and lets their async work settle. */
  async advance(ms: number) {
    const target = this.t + ms;
    for (;;) {
      const next = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      this.timers.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
      await flush();
    }
    this.t = target;
    await flush();
  }
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

const MESH = {
  error_code: 0,
  result: {
    device_list: [
      { mac: 'AA', role: 'master', device_ip: '192.168.68.1', group_status: 'connected' },
      { mac: 'BB', role: 'slave', device_ip: '192.168.68.2', group_status: 'connected' },
      { mac: 'CC', role: 'slave', device_ip: '192.168.68.3', group_status: 'disconnected' },
    ],
  },
};
const isOk = (v: any) => v?.error_code === 0 && Array.isArray(v?.result?.device_list);

async function oneFetchPerCycleAndDerivedData() {
  const clock = new FakeClock();
  let fetches = 0;
  const poller = new HostPoller<any>(async () => { fetches++; return MESH; }, isOk, () => {}, clock);
  const derived: Record<string, any[]> = { AA: [], BB: [], CC: [] };
  const order: string[] = [];
  for (const mac of ['AA', 'BB', 'CC']) {
    await poller.subscribe(mac, {
      intervalMs: 30_000,
      onCycle: async (shared) => {
        order.push(mac);
        const self = shared.value.result.device_list.find((d: any) => d.mac === mac);
        derived[mac].push({ role: self.role, ip: self.device_ip, alarm: self.group_status !== 'connected' });
      },
      order: () => (mac === 'AA' ? 1 : 0),
    });
  }
  // All three subscribed within the freshness window: one fetch total.
  assert.strictEqual(fetches, 1, `initial subscribe should share one fetch, got ${fetches}`);
  order.length = 0;
  await clock.advance(30_000);
  assert.strictEqual(fetches, 2, 'one fetch for the first full cycle');
  await clock.advance(30_000);
  await clock.advance(30_000);
  assert.strictEqual(fetches, 4, 'exactly one fetch per cycle with 3 devices');
  assert.deepStrictEqual(order.slice(0, 3), ['BB', 'CC', 'AA'], 'master runs last in a cycle');
  assert.deepStrictEqual(derived.AA[0], { role: 'master', ip: '192.168.68.1', alarm: false });
  assert.deepStrictEqual(derived.BB[0], { role: 'slave', ip: '192.168.68.2', alarm: false });
  assert.deepStrictEqual(derived.CC[0], { role: 'slave', ip: '192.168.68.3', alarm: true });
  assert.strictEqual(derived.AA.length, 4);
  assert.strictEqual(derived.BB.length, 4);
  assert.strictEqual(derived.CC.length, 4);
  poller.stop();
}

async function inFlightDedupe() {
  const clock = new FakeClock();
  let fetches = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const poller = new HostPoller<any>(async () => { fetches++; await gate; return MESH; }, isOk, () => {}, clock);
  const p = [poller.fetchShared(0), poller.fetchShared(0), poller.fetchShared(0)];
  release();
  const res = await Promise.all(p);
  assert.strictEqual(fetches, 1, 'concurrent fetches must share one call');
  assert.ok(res[0] === res[1] && res[1] === res[2]);
}

async function stopsWhenLastRemoved() {
  const clock = new FakeClock();
  let fetches = 0;
  const poller = new HostPoller<any>(async () => { fetches++; return MESH; }, isOk, () => {}, clock);
  const noop = { intervalMs: 30_000, onCycle: async () => {} };
  await poller.subscribe('AA', noop);
  await poller.subscribe('BB', noop);
  assert.strictEqual(poller.unsubscribe('AA'), false);
  assert.ok(poller.isRunning, 'still running with one device');
  assert.strictEqual(poller.unsubscribe('BB'), true, 'reports empty');
  assert.ok(!poller.isRunning, 'timer cleared');
  assert.strictEqual(clock.timers.size, 0, 'no pending timers');
  const before = fetches;
  await clock.advance(120_000);
  assert.strictEqual(fetches, before, 'no fetches after the last device left');
}

async function failureIsConsistentWithoutStorm() {
  const clock = new FakeClock();
  let fetches = 0;
  let healthy = true;
  const poller = new HostPoller<any>(
    async () => { fetches++; if (!healthy) throw new Error('timeout'); return MESH; },
    isOk, () => {}, clock,
  );
  // Mimics driver.sharedAuthenticate: concurrent callers share one login.
  let logins = 0;
  let authInFlight: Promise<boolean> | null = null;
  const sharedAuth = () => {
    if (authInFlight) return authInFlight;
    logins++;
    authInFlight = new Promise<boolean>((r) => setImmediate(() => r(false))).finally(() => { authInFlight = null; });
    return authInFlight;
  };
  // Mimics the device: reAuth on failure with backoff; idle while backing off.
  const devices = ['AA', 'BB', 'CC'].map((mac) => ({ mac, connected: true, blockedUntil: 0, failures: 0, unavailable: false }));
  for (const d of devices) {
    await poller.subscribe(d.mac, {
      intervalMs: 30_000,
      isIdle: () => !d.connected && clock.now() < d.blockedUntil,
      onCycle: async (shared) => {
        if (!shared.ok) {
          d.connected = await sharedAuth();
          if (!d.connected) {
            d.failures++;
            if (d.failures >= 2) d.unavailable = true;
            d.blockedUntil = clock.now() + Math.min(30_000 * 2 ** (d.failures - 1), 600_000);
          }
        }
      },
    });
  }
  healthy = false;
  fetches = 0;
  await clock.advance(30_000);
  assert.strictEqual(fetches, 1, 'one failed fetch');
  assert.strictEqual(logins, 1, `failure must cause ONE login for 3 devices, got ${logins}`);
  assert.ok(devices.every((d) => !d.connected && d.failures === 1), 'all devices marked consistently');
  // Next tick: all devices in 30s backoff -> isIdle -> shared fetch skipped.
  await clock.advance(29_000);
  assert.strictEqual(fetches, 1, 'no fetch while every device is backing off');
  await clock.advance(31_000);
  assert.strictEqual(logins, 2, 'second cycle: still one login');
  assert.ok(devices.every((d) => d.failures === 2 && d.unavailable), 'all unavailable together');
  poller.stop();
}

async function perDeviceIntervals() {
  const clock = new FakeClock();
  let fetches = 0;
  const poller = new HostPoller<any>(async () => { fetches++; return MESH; }, isOk, () => {}, clock);
  const runs: Record<string, number> = { fast: 0, slow: 0 };
  await poller.subscribe('fast', { intervalMs: 15_000, onCycle: async () => { runs.fast++; } });
  await poller.subscribe('slow', { intervalMs: 60_000, onCycle: async () => { runs.slow++; } });
  assert.strictEqual(poller.intervalMs, 15_000, 'host uses the minimum interval');
  await clock.advance(60_000);
  assert.strictEqual(runs.fast, 5, `fast: 1 initial + 4 ticks, got ${runs.fast}`);
  assert.strictEqual(runs.slow, 2, `slow: 1 initial + 1 after 60s, got ${runs.slow}`);
  poller.setInterval('fast', 60_000);
  assert.strictEqual(poller.intervalMs, 60_000);
  poller.stop();
}

async function main() {
  await oneFetchPerCycleAndDerivedData();
  await inFlightDedupe();
  await stopsWhenLastRemoved();
  await failureIsConsistentWithoutStorm();
  await perDeviceIntervals();
  console.log('PASS: shared host poller - one fetch per cycle, dedupe, stop on empty, no auth storm on failure.');
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
