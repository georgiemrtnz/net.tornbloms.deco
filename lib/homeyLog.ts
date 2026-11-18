'use strict';

// In-repo copy of homey-betterstack 0.3.5 (Martijn Poppen, ISC), kept
// API-compatible: log/info/debug/trace/warn/error/fatal/addHomeyLogChild and
// the HomeyLogData object.
//
// The one change: @logtail/node and @logtail/winston are now required only
// inside the HOMEY_BETTERSTACK_TOKEN branch. The upstream module requires both
// at the top, which pulls in cross-fetch, node-fetch, whatwg-url, tr46,
// msgpack, serialize-error and friends (~44 modules, ~2 MB heap) on every app
// start, even though no token is configured and Logtail is never constructed.
// With a token set, the code path below is exactly the upstream one.
//
// winston and its Console transport (including handleExceptions /
// handleRejections) are loaded and set up exactly as before.

import Homey from 'homey';
import util from 'util';

const { transports, format, Container, addColors } = require('winston');
const { combine, printf, colorize } = format;

const logLevels = {
  levels: {
    trace: 6,
    debug: 5,
    info: 4,
    warn: 3,
    error: 2,
    fatal: 1,
  },
  colors: {
    trace: 'blue',
    debug: 'magenta',
    info: 'green',
    warn: 'yellow',
    error: 'red',
    fatal: 'bold white redBG',
  },
};

export interface HomeyLogConfig {
  console_enabled: string;
  publish_enabled: string;
  console_level: string;
  publish_level: string;
}

export interface HomeyLogDataShape {
  logtail: any;
  config: HomeyLogConfig;
  [key: string]: any;
}

export default class HomeyLog extends Homey.App {
  HomeyLogInstance: any;
  HomeyLogData: HomeyLogDataShape;

  constructor(...args: any[]) {
    // @ts-ignore -- forwarded verbatim to Homey.App, exactly as upstream does
    super(...args);

    this.HomeyLogInstance = console;

    this.HomeyLogData = {
      logtail: null,
      config: {
        console_enabled: '1',
        publish_enabled: '1',
        console_level: 'info',
        publish_level: 'info',
      },
    };

    const env: any = (Homey as any).env;
    if (env.HOMEY_BETTERSTACK_CONFIG) {
      this.HomeyLogData.config = {
        ...this.HomeyLogData.config,
        ...env.HOMEY_BETTERSTACK_CONFIG,
      };
    }

    this.setupHomeyLogLogtail();
  }

  async setupHomeyLogLogtail() {
    this.HomeyLogData['HomeyId'] = await this.homey.cloud.getHomeyId();

    const env: any = (Homey as any).env;
    if (env.HOMEY_BETTERSTACK_TOKEN) {
      const { Logtail } = require('@logtail/node');
      this.HomeyLogData.logtail = new Logtail(env.HOMEY_BETTERSTACK_TOKEN);
      this.HomeyLogData.logtail.use((data: any) => ({
        ...data,
        homeyId: this.HomeyLogData['HomeyId'],
        homeyApp: this.homey.manifest.id,
        homeyAppVersion: this.homey.manifest.version,
        homeyPlatformVersion: (this.homey as any).platformVersion,
        homeyPlatform: (this.homey as any).platform,
      }));
    } else {
      console.error('HomeyLog: No Homey log token found. Please add HOMEY_BETTERSTACK_TOKEN to your env.json');
    }

    this.setupHomeyLogLogger();
  }

  setupHomeyLogLogger() {
    addColors(logLevels.colors);

    this.HomeyLogData['container'] = new Container();

    this.HomeyLogData['transports'] = [
      new transports.Console({
        handleExceptions: true,
        handleRejections: true,
        format: combine(
          colorize(),
          printf(({ level, message }: any) => {
            return `[${level}] ${message}`;
          }),
        ),
        silent: !parseInt(this.HomeyLogData.config.console_enabled),
        level: this.HomeyLogData.config.console_level,
      }),
    ];

    if (this.HomeyLogData.logtail) {
      const { LogtailTransport } = require('@logtail/winston');
      this.HomeyLogData['transports'].push(
        new LogtailTransport(this.HomeyLogData.logtail, {
          handleExceptions: true,
          handleRejections: true,
          silent: !parseInt(this.HomeyLogData.config.publish_enabled),
          level: this.HomeyLogData.config.publish_level,
        }),
      );
    }

    this.HomeyLogData['container'].add('HomeyLogInstance', {
      levels: logLevels.levels,
      transports: this.HomeyLogData['transports'],
    });

    this.HomeyLogInstance = this.HomeyLogData['container'].get('HomeyLogInstance');
  }

  trace(...args: any[]) {
    this.HomeyLogInstance.log('trace', util.format(...args));
  }

  debug(...args: any[]) {
    this.HomeyLogInstance.log('debug', util.format(...args));
  }

  info(...args: any[]) {
    this.HomeyLogInstance.log('info', util.format(...args));
  }

  log(...args: any[]) {
    this.HomeyLogInstance.log('info', util.format(...args));
  }

  warn(...args: any[]) {
    this.HomeyLogInstance.log('warn', util.format(...args));
  }

  error(...args: any[]) {
    this.HomeyLogInstance.log('error', util.format(...args));
  }

  fatal(...args: any[]) {
    this.HomeyLogInstance.log('fatal', util.format(...args));
  }

  addHomeyLogChild(scope: string) {
    if (!scope.length || !this.HomeyLogData.logtail) {
      return this.HomeyLogInstance;
    }

    this.HomeyLogData['container'].add(scope, {
      levels: logLevels.levels,
      transports: this.HomeyLogData['transports'],
    });

    return this.HomeyLogData['container'].get(scope);
  }
}
