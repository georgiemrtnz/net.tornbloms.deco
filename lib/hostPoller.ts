'use strict';

/**
 * One poll loop per router hostname, shared by every paired Deco node on it.
 *
 * Before this, each paired node ran its own timer and fetched the mesh-wide
 * device_list itself every cycle — three nodes meant three identical
 * device_list calls (plus three sets of allocations and three requests queued
 * on the router's single admin session) every interval. The device list is the
 * same for every node, so it is now fetched once per cycle here and handed to
 * each subscriber, which derives its own per-node state from it. Per-node data
 * the router only returns for a given node (client_list with device_mac: <own
 * MAC>) is still fetched by each subscriber itself.
 *
 * Interval rule: the host polls at the SHORTEST interval any subscriber asked
 * for (timeoutSeconds is a per-device setting). A node with a longer setting
 * is still only run once its own interval has elapsed, so a device never polls
 * faster than it was configured to.
 *
 * Dispatch rule: on a successful fetch, subscribers run one after another (in
 * ascending `order`), so per-node requests arrive as a steady sequence rather
 * than a concurrent burst. On a failed fetch they run concurrently, so their
 * re-authentication attempts all land inside the driver's in-flight auth
 * dedupe (sharedAuthenticate) and produce ONE login rather than one per node.
 */

export interface SharedFetch<T> {
  ok: boolean;
  value: T;
  fetchedAt: number;
}

export interface PollSubscriber<T> {
  intervalMs: number;
  /** Runs this node's poll using the shared result for this cycle. */
  onCycle: (shared: SharedFetch<T>) => Promise<void>;
  /** True while the node has nothing to do (e.g. in re-auth backoff). */
  isIdle?: () => boolean;
  /** Lower runs first; the master uses a higher value so it sees fresh slave data. */
  order?: () => number;
}

export interface PollerTimers {
  setTimeout: (fn: () => void, ms: number) => any;
  clearTimeout: (id: any) => void;
  now: () => number;
}

const defaultTimers: PollerTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  now: () => Date.now(),
};

export class HostPoller<T> {
  private subs = new Map<string, PollSubscriber<T> & { lastRun: number }>();
  private timer: any = null;
  private inFlight: Promise<SharedFetch<T>> | null = null;
  private last: SharedFetch<T> | null = null;
  private cycleRunning = false;
  private stopped = false;

  constructor(
    private readonly fetcher: () => Promise<T>,
    private readonly isSuccess: (v: T) => boolean,
    private readonly log: (...a: any[]) => void = () => {},
    private readonly timers: PollerTimers = defaultTimers,
  ) {}

  get size(): number {
    return this.subs.size;
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  get intervalMs(): number {
    let min = Infinity;
    for (const s of this.subs.values()) min = Math.min(min, s.intervalMs);
    return min;
  }

  /**
   * Adds (or replaces) a subscriber and runs it once straight away, reusing
   * this cycle's shared result if it is still fresh so a late joiner costs no
   * extra device_list call.
   */
  async subscribe(id: string, sub: PollSubscriber<T>): Promise<void> {
    this.stopped = false;
    this.subs.set(id, { ...sub, lastRun: 0 });
    this.reschedule();
    await this.runOne(id);
  }

  /** Changes a subscriber's interval (timeoutSeconds setting) without re-running it. */
  setInterval(id: string, intervalMs: number): void {
    const s = this.subs.get(id);
    if (!s) return;
    s.intervalMs = intervalMs;
    this.reschedule();
  }

  /** Removes a subscriber; returns true when that left the poller empty (and stopped). */
  unsubscribe(id: string): boolean {
    this.subs.delete(id);
    if (this.subs.size === 0) {
      this.stop();
      return true;
    }
    this.reschedule();
    return false;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.last = null;
  }

  /** One shared fetch; concurrent callers get the same promise. */
  fetchShared(maxAgeMs = 0): Promise<SharedFetch<T>> {
    const now = this.timers.now();
    if (this.last && this.last.ok && now - this.last.fetchedAt < maxAgeMs) {
      return Promise.resolve(this.last);
    }
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      let value: T;
      let ok = false;
      try {
        value = await this.fetcher();
        ok = this.isSuccess(value);
      } catch (e) {
        value = undefined as any;
        this.log('Shared poll fetch threw', e);
      }
      const res: SharedFetch<T> = { ok, value: value!, fetchedAt: this.timers.now() };
      this.last = res;
      return res;
    })().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private reschedule(): void {
    if (this.stopped || this.subs.size === 0) return;
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.tick().finally(() => this.reschedule());
    }, this.intervalMs);
  }

  /** One poll cycle for the whole host. Public for tests. */
  async tick(): Promise<void> {
    if (this.cycleRunning) {
      this.log('Shared poll: previous cycle still running — skipping');
      return;
    }
    this.cycleRunning = true;
    try {
      const now = this.timers.now();
      // A subscriber is due once its own interval has (nearly) elapsed. The
      // 1s slack keeps a node from slipping a whole cycle because the timer
      // fired a few ms early relative to its lastRun.
      const due = [...this.subs.entries()]
        .filter(([, s]) => now - s.lastRun >= s.intervalMs - 1000)
        .filter(([, s]) => !(s.isIdle?.() ?? false));
      if (due.length === 0) return;
      const shared = await this.fetchShared(0);
      if (this.stopped) return;
      await this.dispatch(due.map(([id]) => id), shared);
    } finally {
      this.cycleRunning = false;
    }
  }

  private async runOne(id: string): Promise<void> {
    const s = this.subs.get(id);
    if (!s) return;
    if (s.isIdle?.()) return;
    const shared = await this.fetchShared(s.intervalMs - 1000);
    if (!this.subs.has(id)) return;
    await this.dispatch([id], shared);
  }

  private async dispatch(ids: string[], shared: SharedFetch<T>): Promise<void> {
    const run = async (id: string) => {
      const s = this.subs.get(id);
      if (!s) return; // removed mid-cycle
      s.lastRun = this.timers.now();
      try {
        await s.onCycle(shared);
      } catch (e) {
        this.log(`Shared poll: subscriber ${id} failed`, e);
      }
    };
    if (!shared.ok) {
      await Promise.all(ids.map(run));
      return;
    }
    const ordered = ids
      .map((id) => ({ id, o: this.subs.get(id)?.order?.() ?? 0 }))
      .sort((a, b) => a.o - b.o)
      .map((x) => x.id);
    for (const id of ordered) await run(id);
  }
}

export default HostPoller;
