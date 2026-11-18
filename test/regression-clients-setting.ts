// The read-only `clients` setting is written only when its text changes,
// seeded from the stored value so the first change after restart is written.
import assert from 'assert';
import { installFakeHomey } from './fakeHomey';

async function main() {
  installFakeHomey({});
  const mod = require('../drivers/tplink_deco/device');
  const DeviceClass = mod.default || mod;
  const write = DeviceClass.prototype.writeClientsSetting;
  const writes: string[] = [];
  const dev: any = {
    lastClientsSetting: undefined,
    stored: 'A, B',
    getSetting() {
      return this.stored;
    },
    async setSettings(s: any) {
      writes.push(s.clients);
      this.stored = s.clients;
    },
  };
  await write.call(dev, 'A, B'); // same as stored after restart: no write
  await write.call(dev, 'A, B, C');
  await write.call(dev, 'A, B, C');
  await write.call(dev, 'A');
  assert.deepStrictEqual(writes, ['A, B, C', 'A']);

  // A failed write is retried on the next poll.
  const dev2: any = { ...dev, lastClientsSetting: undefined, stored: '', fail: true };
  dev2.setSettings = async (s: any) => {
    if (dev2.fail) {
      dev2.fail = false;
      throw new Error('ipc');
    }
    writes.push(`2:${s.clients}`);
  };
  await assert.rejects(write.call(dev2, 'X'));
  await write.call(dev2, 'X');
  assert.strictEqual(writes[writes.length - 1], '2:X');
  console.log('PASS: clients setting written only on change; failed writes retried.');
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
