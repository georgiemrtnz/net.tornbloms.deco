// Memory regression: with no HOMEY_BETTERSTACK_TOKEN / HOMEY_LOG_URL in env,
// @logtail/* and homey-log/raven must not be loaded, and logging must still
// print through winston's '[level] message' console transport. With the env
// vars set, the same modules and transports are wired as before.
import assert from 'assert';
import { installFakeHomey, fakeAppHomey } from './fakeHomey';

const loaded = (frag: string) => Object.keys(require.cache).some((k) => k.includes(frag));
const tick = () => new Promise((r) => setTimeout(r, 30));

async function main() {
  const fake = installFakeHomey({});
  const mod = require('../app');
  const AppClass = mod.default || mod;

  const lines: string[] = [];
  const origErr = console.error;
  const origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (chunk: any, ...rest: any[]) => {
    lines.push(String(chunk));
    return origWrite(chunk, ...rest);
  };
  console.error = (...a: any[]) => {
    lines.push(a.join(' '));
    origErr(...a);
  };

  const app = new AppClass({ homey: fakeAppHomey() });
  await tick();
  await app.onInit();
  app.log('msg');
  app.reportIssue('x', { a: 1 });
  await tick();
  (process.stdout as any).write = origWrite;
  console.error = origErr;

  assert.ok(!loaded('@logtail'), '@logtail must not load without a token');
  assert.ok(!loaded('/raven/'), 'raven must not load without HOMEY_LOG_URL');
  assert.ok(!loaded('/homey-log/'), 'homey-log must not load without HOMEY_LOG_URL');
  assert.strictEqual(app.homeyLog, null);
  assert.strictEqual(app.HomeyLogData.logtail, null);
  assert.strictEqual(app.HomeyLogData.transports.length, 1);
  const tr = app.HomeyLogData.transports[0];
  assert.ok(tr.handleExceptions && tr.handleRejections, 'console transport keeps exception/rejection handling');
  const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  assert.ok(plain.some((l) => l.includes('[info] msg')), 'log() prints [info] msg');
  assert.ok(plain.some((l) => l.includes('homey-log is disabled')), 'homey-log disabled line kept');

  // With credentials: same wiring as homey-betterstack / homey-log.
  fake.env.HOMEY_BETTERSTACK_TOKEN = 'fake-token';
  fake.env.HOMEY_LOG_URL = 'https://key@sentry.invalid/1';
  const app2 = new AppClass({ homey: fakeAppHomey() });
  await tick();
  await app2.onInit();
  assert.ok(app2.HomeyLogData.logtail, 'Logtail created with token');
  assert.strictEqual(app2.HomeyLogData.transports.length, 2);
  assert.strictEqual(app2.HomeyLogData.transports[1].constructor.name, 'LogtailTransport');
  assert.ok(app2.homeyLog, 'homey-log Log built when HOMEY_LOG_URL set');
  assert.ok(loaded('/raven/'));
  console.log('PASS: logtail/homey-log load lazily; logging output and handlers unchanged.');
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
