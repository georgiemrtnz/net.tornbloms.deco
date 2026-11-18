// Differential test: lib/cookieJar.ts vs tough-cookie for the Deco session use.
import assert from 'assert';
import { CookieJar } from '../lib/cookieJar';
const tough = require('tough-cookie');

const HTTP = 'http://192.168.0.1/cgi-bin/luci/';
const HTTPS = 'https://192.168.0.1/cgi-bin/luci/';
const URLS = [
  HTTP,
  HTTPS,
  'http://192.168.0.1/cgi-bin/luci/;stok=abc/admin/device?form=list',
  'https://192.168.0.1/cgi-bin/luci/;stok=abc/login?form=login',
  'http://192.168.0.1/',
  'https://192.168.0.1/other',
];
const past = new Date(Date.now() - 86400000).toUTCString();
const future = new Date(Date.now() + 86400000).toUTCString();

const SCENARIOS: Array<Array<[string, string]>> = [
  [['sysauth=abc123; path=/cgi-bin/luci; HttpOnly', HTTP]],
  [['sysauth=abc123; Path=/cgi-bin/luci; Secure; HttpOnly', HTTPS]],
  [['sysauth=abc123; Path=/cgi-bin/luci; Secure', HTTP]],
  [['sysauth=abc; Path=/cgi-bin/luci', HTTP], ['sysauth=; Path=/cgi-bin/luci; Max-Age=0', HTTP]],
  [['sysauth=abc; Path=/cgi-bin/luci', HTTP], [`sysauth=gone; Path=/cgi-bin/luci; Expires=${past}`, HTTP]],
  [[`sysauth=x; Path=/cgi-bin/luci; Expires=${future}`, HTTP]],
  [['sysauth=x; Domain=example.com; Path=/', HTTP]],
  [['sysauth=x; Domain=192.168.0.1; Path=/', HTTP]],
  [['a=1; Path=/', HTTP], ['a=2; Path=/', HTTP], ['a=3; Path=/cgi-bin/luci', HTTP], ['b=1', HTTP]],
  [['sysauth=old; Path=/cgi-bin/luci', HTTP], ['sysauth=new; Path=/cgi-bin/luci; Secure', HTTPS]],
  [['noPath=1', 'http://192.168.0.1/cgi-bin/luci/;stok=1/login?form=login']],
  [['x=1; Path=relative', HTTP], ['y=2; max-age=3600', HTTP], ['z=3; max-age=-1', HTTP]],
  [['=bad', HTTP], ['ok=1', HTTP]],
  [['__Secure-a=1; Path=/', HTTPS], ['__Host-b=1; Path=/; Secure', HTTPS]],
];

async function run(jar: any, steps: Array<[string, string]>) {
  const errs: boolean[] = [];
  for (const [h, u] of steps) {
    try {
      await jar.setCookie(h, u);
      errs.push(false);
    } catch {
      errs.push(true);
    }
  }
  const out: string[] = [];
  for (const u of URLS) out.push(await jar.getCookieString(u));
  return { errs, out };
}

async function main() {
  for (const s of SCENARIOS) {
    const a = await run(new CookieJar(), s);
    const b = await run(new tough.CookieJar(), s);
    assert.deepStrictEqual(a, b, `mismatch for ${JSON.stringify(s)}`);
  }
  console.log(`PASS: cookie jar matches tough-cookie on ${SCENARIOS.length} scenarios x ${URLS.length} URLs.`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
