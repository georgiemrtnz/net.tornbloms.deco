/**
 * Minimal RFC 6265 cookie jar with the two async methods lib/http.ts uses
 * from tough-cookie: setCookie(header, url) and getCookieString(url).
 *
 * tough-cookie 5 pulls in tldts and its whole public-suffix list (~2 MB heap,
 * ~8 MB RSS) to hold what is, for this app, one session cookie for one LAN
 * router per HttpClient. This jar reproduces tough-cookie 5.1.2's observable
 * behaviour for that use (checked by test/regression-cookie-jar.ts, which
 * runs a corpus through both jars and compares the results):
 *
 *  - name=value parsing, including tough-cookie's rejection of an empty name
 *    and of control characters; attributes are case-insensitive and the last
 *    occurrence wins.
 *  - Path: default-path per RFC 6265 5.1.4 when missing or not starting with
 *    "/"; path-match on read.
 *  - Secure: stored even when set over http (as tough-cookie does), but only
 *    sent over https.
 *  - Domain: a Domain that is an IPv4 address or a single label is rejected
 *    (tough-cookie rejects those as public suffixes). Otherwise it must be the
 *    request host or a parent of it. Without a public-suffix list, a parent
 *    that is itself a public suffix (e.g. "co.uk") is accepted where
 *    tough-cookie would refuse it; the router is addressed by IP or by its own
 *    hostname, so this never applies here.
 *  - Max-Age (wins over Expires) and Expires (RFC 6265 5.1.1 date parsing).
 *    Expired cookies are removed when the jar is next read. Like
 *    tough-cookie, Max-Age counts from the cookie's last access.
 *  - HttpOnly and SameSite: no effect (this is always an HTTP API with no
 *    same-site context).
 *  - __Secure- / __Host- prefix rules, silently ignoring a violating cookie.
 *  - A cookie with the same name and path replaces the old one but keeps its
 *    creation time; output order is longest path first, then oldest first.
 */

interface StoredCookie {
  key: string;
  value: string;
  path: string;
  secure: boolean;
  hostOnly: boolean;
  domain: string;
  /** Seconds, as parsed; null when no valid Max-Age was given. */
  maxAge: number | null;
  /** Epoch ms from Expires; null when absent or unparseable. */
  expires: number | null;
  creation: number;
  creationIndex: number;
  lastAccessed: number;
}

let cookiesCreated = 0;

const CONTROL_CHARS = /[\x00-\x1F]/;
const DATE_DELIM = /[\x09\x20-\x2F\x3B-\x40\x5B-\x60\x7B-\x7E]/;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function parseDigits(token: string, min: number, max: number, trailingOK: boolean): number | undefined {
  let count = 0;
  while (count < token.length) {
    const c = token.charCodeAt(count);
    if (c <= 0x2f || c >= 0x3a) break;
    count++;
  }
  if (count < min || count > max) return undefined;
  if (!trailingOK && count !== token.length) return undefined;
  return parseInt(token.slice(0, count), 10);
}

/** RFC 6265 5.1.1 cookie-date parsing (same algorithm as tough-cookie). */
export function parseCookieDate(str: string): number | null {
  let hour: number | undefined, minute: number | undefined, second: number | undefined;
  let day: number | undefined, month: number | undefined, year: number | undefined;
  for (const raw of str.split(DATE_DELIM)) {
    const token = raw.trim();
    if (!token) continue;
    if (second === undefined) {
      const parts = token.split(':');
      if (parts.length === 3) {
        const t = parts.map((p, i) => parseDigits(p, 1, 2, i === 2));
        if (t.every((n) => n !== undefined)) {
          [hour, minute, second] = t as number[];
          continue;
        }
      }
    }
    if (day === undefined) {
      const d = parseDigits(token, 1, 2, true);
      if (d !== undefined) {
        day = d;
        continue;
      }
    }
    if (month === undefined) {
      const m = MONTHS.indexOf(token.slice(0, 3).toLowerCase());
      if (m !== -1) {
        month = m;
        continue;
      }
    }
    if (year === undefined) {
      const y = parseDigits(token, 2, 4, true);
      if (y !== undefined) year = y >= 70 && y <= 99 ? y + 1900 : y >= 0 && y <= 69 ? y + 2000 : y;
    }
  }
  if (
    day === undefined || month === undefined || year === undefined ||
    hour === undefined || minute === undefined || second === undefined ||
    day < 1 || day > 31 || year < 1601 || hour > 23 || minute > 59 || second > 59
  ) {
    return null;
  }
  return Date.UTC(year, month, day, hour, minute, second);
}

function defaultPath(path: string): string {
  if (!path || path[0] !== '/' || path === '/') return '/';
  const right = path.lastIndexOf('/');
  return right === 0 ? '/' : path.slice(0, right);
}

function pathMatch(reqPath: string, cookiePath: string): boolean {
  if (cookiePath === reqPath) return true;
  if (reqPath.startsWith(cookiePath)) {
    if (cookiePath.endsWith('/')) return true;
    if (reqPath[cookiePath.length] === '/') return true;
  }
  return false;
}

function parseUrl(url: string): URL {
  try {
    return new URL(decodeURI(url));
  } catch {
    return new URL(url);
  }
}

function expiryTime(c: StoredCookie): number | null {
  if (c.maxAge !== null) {
    return Number.isFinite(c.maxAge) && c.maxAge > 0 ? c.lastAccessed + c.maxAge * 1000 : -Infinity;
  }
  return c.expires;
}

export class CookieJar {
  /** Keyed by domain, path and name, as a cookie store is. */
  private readonly cookies = new Map<string, StoredCookie>();

  async setCookie(header: string, url: string): Promise<void> {
    const ctx = parseUrl(url);
    const host = ctx.hostname.replace(/^\./, '').toLowerCase();

    // --- parse (tough-cookie strict mode) ---
    if (typeof header !== 'string' || header.length === 0) throw new Error('Cookie failed to parse');
    const str = header.trim();
    const firstSemi = str.indexOf(';');
    let pair = firstSemi === -1 ? str : str.slice(0, firstSemi);
    for (const t of ['\n', '\r', '\0']) {
      const i = pair.indexOf(t);
      if (i !== -1) pair = pair.slice(0, i);
    }
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new Error('Cookie failed to parse');
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (CONTROL_CHARS.test(key) || CONTROL_CHARS.test(value)) throw new Error('Cookie failed to parse');

    let path: string | null = null;
    let domain: string | null = null;
    let secure = false;
    let maxAge: number | null = null;
    let expires: number | null = null;
    if (firstSemi !== -1) {
      for (const rawAv of str.slice(firstSemi + 1).split(';')) {
        const av = rawAv.trim();
        if (!av) continue;
        const sep = av.indexOf('=');
        const avKey = (sep === -1 ? av : av.slice(0, sep)).trim().toLowerCase();
        const avValue = sep === -1 ? null : av.slice(sep + 1).trim();
        switch (avKey) {
          case 'expires':
            if (avValue) {
              const t = parseCookieDate(avValue);
              if (t !== null) expires = t;
            }
            break;
          case 'max-age':
            if (avValue && /^-?[0-9]+$/.test(avValue)) maxAge = parseInt(avValue, 10);
            break;
          case 'domain':
            if (avValue) {
              const d = avValue.trim().replace(/^\./, '');
              if (d) domain = d.toLowerCase();
            }
            break;
          case 'path':
            path = avValue && avValue[0] === '/' ? avValue : null;
            break;
          case 'secure':
            secure = true;
            break;
          default:
            // HttpOnly, SameSite and extensions do not change what this
            // client sends.
            break;
        }
      }
    }

    // --- store (RFC 6265 5.3) ---
    let hostOnly = true;
    if (domain !== null) {
      const cdomain = domain.replace(/^\./, '');
      if (IPV4.test(cdomain) || !cdomain.includes('.')) {
        throw new Error('Cookie has domain set to a public suffix');
      }
      const matches = cdomain === host || (!IPV4.test(host) && host.endsWith(`.${cdomain}`));
      if (!matches) throw new Error(`Cookie not in this host's domain. Cookie:${cdomain} Request:${host}`);
      hostOnly = false;
      domain = cdomain;
    } else {
      domain = host;
    }
    if (path === null) path = defaultPath(ctx.pathname);

    // Prefix rules; tough-cookie's default prefixSecurity is 'silent'.
    if (key.startsWith('__Secure-') && !secure) return;
    if (key.startsWith('__Host-') && !(secure && hostOnly && path === '/')) return;

    const now = Date.now();
    const id = `${domain}\u0000${path}\u0000${key}`;
    const old = this.cookies.get(id);
    const index = ++cookiesCreated;
    this.cookies.set(id, {
      key,
      value,
      path,
      secure,
      hostOnly,
      domain,
      maxAge,
      expires,
      creation: old ? old.creation : now,
      creationIndex: old ? old.creationIndex : index,
      lastAccessed: now,
    });
  }

  async getCookieString(url: string): Promise<string> {
    const ctx = parseUrl(url);
    const host = ctx.hostname.replace(/^\./, '').toLowerCase();
    const reqPath = ctx.pathname || '/';
    const isSecure = ctx.protocol === 'https:' || ctx.protocol === 'wss:';
    const now = Date.now();

    const matched: StoredCookie[] = [];
    for (const [id, c] of this.cookies) {
      const domainOk = c.hostOnly ? c.domain === host : c.domain === host || host.endsWith(`.${c.domain}`);
      if (!domainOk) continue;
      if (!pathMatch(reqPath, c.path)) continue;
      if (c.secure && !isSecure) continue;
      const exp = expiryTime(c);
      if (exp !== null && exp <= now) {
        this.cookies.delete(id);
        continue;
      }
      matched.push(c);
    }
    for (const c of matched) c.lastAccessed = now;
    matched.sort(
      (a, b) => b.path.length - a.path.length || a.creation - b.creation || a.creationIndex - b.creationIndex,
    );
    return matched.map((c) => (c.key ? `${c.key}=${c.value}` : c.value)).join('; ');
  }
}
