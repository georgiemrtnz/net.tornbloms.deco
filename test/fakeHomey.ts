// Installs a minimal stand-in for the 'homey' module, which only exists inside
// the Homey runtime. Must run before anything that imports 'homey' is
// required, so tests load app/driver code with require() after calling this.

import Module from 'module';
import path from 'path';

export function installFakeHomey(env: Record<string, any>): any {
  class Base {
    homey: any;
    constructor(opts?: any) {
      Object.assign(this, opts || {});
    }
    log(...args: any[]) {
      console.log(...args);
    }
    error(...args: any[]) {
      console.error(...args);
    }
  }
  const fake = {
    App: class App extends Base {},
    Driver: class Driver extends Base {},
    Device: class Device extends Base {},
    env,
    manifest: { id: 'net.tornbloms.deco', version: 'test' },
  };
  const fakePath = path.join(__dirname, '__fake_homey__.js');
  const m = new Module(fakePath);
  m.filename = fakePath;
  m.loaded = true;
  m.exports = fake;
  (require.cache as any)[fakePath] = m;
  const orig = (Module as any)._resolveFilename;
  (Module as any)._resolveFilename = function (request: string, ...rest: any[]) {
    if (request === 'homey') return fakePath;
    return orig.call(this, request, ...rest);
  };
  return fake;
}

export function fakeAppHomey(): any {
  return {
    settings: { get: () => false },
    cloud: { getHomeyId: async () => 'homey-id' },
    manifest: { id: 'net.tornbloms.deco', version: 'test' },
    drivers: { getDrivers: () => ({}) },
    version: 'test',
    platform: 'local',
    platformVersion: 2,
  };
}
