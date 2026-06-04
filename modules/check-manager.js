/**
 * CheckManager contract:
 * Input:
 * - bus: event bus with emit(type, payload)
 * - db: Dexie database with works and meta tables
 * - fetchFn: fetch-compatible function
 * - delayFn: async function receiving milliseconds
 * Output:
 * - Maintains a persistent check queue in db.meta.
 * - Performs HEAD-only checks in bounded batches.
 * - Emits checks:confirmed when a work is newly confirmed deleted.
 * - Emits checks:badge-refresh when badge count should be re-queried.
 *
 * This module does not import other extension modules. background.js owns the
 * database, event bus, notifications, alarms, and badge APIs.
 */
// NOTE: importScripts loads every module into one shared worker scope, so these
// must be `var` (redeclaration-safe) rather than `const` — import-manager.js
// declares the same names. They all resolve to the same constants object.
var Constants = globalThis.AO3LostAndFoundConstants
  || (typeof require === "function" ? require("./constants") : {});
var { META, STATUS, EVENTS } = Constants;

class CheckManager {
  constructor({
    bus,
    db,
    fetchFn = globalThis.fetch?.bind(globalThis),
    delayFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random = Math.random,
    now = () => Date.now(),
    batchSizeRange = [20, 30],
    requestDelayRange = [3000, 6000],
    backoffDelayFn = null
  }) {
    this.bus = bus;
    this.db = db;
    this.fetchFn = fetchFn;
    this.delayFn = delayFn;
    this.random = random;
    this.now = now;
    this.batchSizeRange = batchSizeRange;
    this.requestDelayRange = requestDelayRange;
    this.backoffDelayFn = backoffDelayFn || delayFn;
    this.running = false;
    this.consecutive429s = 0;
  }

  async runBatch({ manual = false, batchSize } = {}) {
    if (this.running) {
      return { success: false, error: "A check batch is already running." };
    }

    this.running = true;
    const limit = Math.max(1, Number(batchSize)
      || randomDelay(this.batchSizeRange[0], this.batchSizeRange[1], this.random));
    let processed = 0;

    // Shared state for the two lanes. `pending` is the confirmation fast-lane
    // (works that already looked deleted, re-checked ahead of the rotation so
    // the 3-strike confirmation completes within a few runs instead of a few
    // full passes). `seen` ensures a work is checked at most once per run, so
    // strikes stay spaced by the run interval.
    let pending = await this.getPending();
    let queue = await this.getQueue();
    if (queue.length === 0) {
      queue = await this.rebuildQueue();
    }
    const seen = new Set();

    try {
      // Lane 1: confirmation fast-lane (snapshot so mutating `pending` is safe).
      const fastLane = [...pending];
      while (fastLane.length > 0 && processed < limit) {
        const outcome = await this.processWorkId(fastLane, seen, () => ({ pending, queue }));
        if (outcome.paused) {
          return { success: false, paused: true, processed, error: "Paused after repeated AO3 rate-limit responses." };
        }
        if (outcome.processed) {
          pending = outcome.pending;
          processed += 1;
          if (processed < limit) {
            await this.delayFn(randomDelay(this.requestDelayRange[0], this.requestDelayRange[1], this.random));
          }
        }
      }

      // Lane 2: main rotation.
      while (queue.length > 0 && processed < limit) {
        if (seen.has(queue[0])) {
          queue.shift();
          continue;
        }
        const outcome = await this.processWorkId(queue, seen, () => ({ pending, queue }));
        if (outcome.paused) {
          return { success: false, paused: true, processed, error: "Paused after repeated AO3 rate-limit responses." };
        }
        if (outcome.processed) {
          pending = outcome.pending;
          processed += 1;
          if (processed < limit) {
            await this.delayFn(randomDelay(this.requestDelayRange[0], this.requestDelayRange[1], this.random));
          }
        }
      }

      if (queue.length === 0) {
        // Pass finished: rebuild the rotation for next time (capture it so the
        // final persist below does not clobber it with the drained queue).
        queue = await this.rebuildQueue();
      }

      await this.setMeta(META.CHECK_LAST_RUN, this.now());
      await this.persistQueues(pending, queue);
      await this.bus?.emit?.(EVENTS.CHECKS_BADGE_REFRESH, { manual, processed });
      return { success: true, processed };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.bus?.emit?.(EVENTS.CHECKS_ERROR, { message });
      return { success: false, error: message };
    } finally {
      this.running = false;
    }
  }

  // Checks the work at the front of `lane`, records the transition, and keeps
  // the confirmation fast-lane in sync. Returns { processed, paused, pending }.
  async processWorkId(lane, seen, getState) {
    const { pending, queue } = getState();
    const workId = lane.shift();

    const work = await this.db.works.get(workId);
    if (!work) {
      const trimmed = pending.filter((id) => id !== workId);
      await this.persistQueues(trimmed, queue);
      return { processed: false, paused: false, pending: trimmed };
    }

    const result = await this.checkWork(work);
    if (result.statusCode === 429) {
      lane.unshift(workId);
      await this.persistQueues(pending, queue);
      const shouldPause = await this.handle429();
      return { processed: false, paused: shouldPause, pending };
    }

    seen.add(workId);
    this.consecutive429s = 0;

    const nextWork = applyStateTransition(work, result, this.now());
    const confirmedStatusChanged = nextWork.confirmedStatusChanged;
    delete nextWork.confirmedStatusChanged;
    nextWork.priorityScore = getPriorityScore(nextWork, this.now());
    await this.db.works.put(nextWork);

    // Add to the fast-lane while unconfirmed, drop once resolved either way.
    let nextPending = pending.filter((id) => id !== workId);
    if (nextWork.status === STATUS.UNCONFIRMED) {
      nextPending.push(workId);
    }

    if (confirmedStatusChanged && nextWork.status === STATUS.DELETED) {
      await this.bus?.emit?.(EVENTS.CHECKS_CONFIRMED, { work: nextWork, previousStatus: work.status });
    }

    await this.persistQueues(nextPending, queue);
    return { processed: true, paused: false, pending: nextPending };
  }

  async checkWork(work) {
    if (!this.fetchFn) {
      throw new Error("Fetch is unavailable in this browser context.");
    }

    const response = await this.fetchFn(`https://archiveofourown.org/works/${encodeURIComponent(work.workId)}`, {
      method: "HEAD",
      credentials: "include",
      redirect: "follow"
    });

    return normalizeHeadResult(response);
  }

  async rebuildQueue() {
    const works = await this.db.works.toArray();
    const scoredWorks = works
      .map((work) => ({ ...work, priorityScore: getPriorityScore(work, this.now()) }))
      .sort(compareQueueItems);

    if (scoredWorks.length > 0) {
      await this.db.works.bulkPut(scoredWorks);
    }

    const queue = scoredWorks.map((work) => work.workId);
    await this.setQueue(queue);
    return queue;
  }

  async handle429() {
    this.consecutive429s += 1;
    await this.backoffDelayFn(computeBackoff(this.consecutive429s));

    if (this.consecutive429s >= 3) {
      await this.setMeta(META.CHECK_PAUSED, true);
      await this.bus?.emit?.(EVENTS.CHECKS_PAUSED, {
        reason: "rate-limit",
        message: "Checking paused after repeated AO3 rate-limit responses. Please try again later."
      });
      return true;
    }

    return false;
  }

  async getQueue() {
    return (await this.getMeta(META.CHECK_QUEUE)) || [];
  }

  async setQueue(queue) {
    await this.setMeta(META.CHECK_QUEUE, queue);
  }

  async getPending() {
    return (await this.getMeta(META.CHECK_PENDING)) || [];
  }

  async persistQueues(pending, queue) {
    await this.setMeta(META.CHECK_PENDING, pending);
    await this.setMeta(META.CHECK_QUEUE, queue);
  }

  async getMeta(key) {
    const row = await this.db.meta.get(key);
    return row?.value ?? null;
  }

  async setMeta(key, value) {
    await this.db.meta.put({ key, value });
  }
}

function normalizeHeadResult(response) {
  const statusCode = response?.status || 0;

  return {
    statusCode,
    deleted: statusCode === 404 || statusCode === 410,
    // Restricted/locked works still exist; tracked only so a 401/403 is never
    // mistaken for a deletion.
    restricted: statusCode === 401 || statusCode === 403,
    ok: statusCode >= 200 && statusCode < 300
  };
}

function applyStateTransition(work, result, now = Date.now()) {
  const statusCode = result?.statusCode;
  const base = {
    ...work,
    lastChecked: statusCode === 429 ? work.lastChecked ?? null : now,
    confirmedStatusChanged: false
  };

  if (statusCode === 429) {
    return base;
  }

  if (result?.restricted) {
    return {
      ...base,
      status: STATUS.RESTRICTED,
      checkFailCount: 0
    };
  }

  if (result?.deleted) {
    const nextFailCount = (Number(work.checkFailCount) || 0) + 1;

    if (nextFailCount >= 3) {
      const wasConfirmed = work.status === STATUS.DELETED;
      return {
        ...base,
        status: STATUS.DELETED,
        checkFailCount: nextFailCount,
        deletedAt: work.deletedAt || now,
        pinnedToTop: true,
        confirmedStatusChanged: !wasConfirmed
      };
    }

    return {
      ...base,
      status: STATUS.UNCONFIRMED,
      checkFailCount: nextFailCount
    };
  }

  if (result?.ok) {
    return {
      ...base,
      status: STATUS.ACTIVE,
      checkFailCount: 0,
      deletedAt: null
    };
  }

  const nextFailCount = (Number(work.checkFailCount) || 0) + 1;
  return {
    ...base,
    status: nextFailCount >= 3 ? STATUS.DELETED : STATUS.UNCONFIRMED,
    checkFailCount: nextFailCount,
    deletedAt: nextFailCount >= 3 ? work.deletedAt || now : work.deletedAt ?? null,
    pinnedToTop: nextFailCount >= 3,
    confirmedStatusChanged: nextFailCount >= 3 && work.status !== STATUS.DELETED
  };
}

function compareQueueItems(left, right) {
  if (right.priorityScore !== left.priorityScore) {
    return right.priorityScore - left.priorityScore;
  }

  return (left.lastChecked || 0) - (right.lastChecked || 0);
}

function computeBackoff(attempt) {
  const sequence = [30000, 60000, 120000];
  return sequence[Math.max(0, Math.min(sequence.length - 1, attempt - 1))];
}

function getPriorityScore(work, now = Date.now()) {
  const bookmarkedTime = Date.parse(work?.dateBookmarked || "") || 0;
  const ageDays = bookmarkedTime ? Math.max(0, (now - bookmarkedTime) / 86400000) : 3650;
  const recencyScore = Math.max(1, Math.round(10000 / (ageDays + 1)));
  const staleDays = work?.lastChecked ? Math.max(0, (now - work.lastChecked) / 86400000) : 365;
  const staleBoost = Math.min(5000, Math.round(staleDays * 25));
  const statusBoost = work?.status === STATUS.UNCONFIRMED ? 1000 : 0;

  return recencyScore + staleBoost + statusBoost;
}

function randomDelay(min, max, random = Math.random) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
    throw new Error("randomDelay requires finite min and max values with min <= max.");
  }

  return Math.floor(random() * (max - min + 1)) + min;
}

// Per-run batch size so a full pass over `total` works finishes in ~a day:
// daily budget = clamp(total, floor, ceiling), divided across the day's runs
// (derived from the check interval), then clamped to a safe per-run range.
function computeBatchSize(total, intervalMinutes, config = (Constants.CHECK || {})) {
  const {
    DAILY_FLOOR = 150,
    DAILY_CEILING = 1500,
    BATCH_MIN = 2,
    BATCH_MAX = 32
  } = config;

  const interval = Number(intervalMinutes) > 0 ? Number(intervalMinutes) : 30;
  const runsPerDay = Math.max(1, Math.round(1440 / interval));
  const budget = Math.min(DAILY_CEILING, Math.max(DAILY_FLOOR, Number(total) || 0));
  return Math.min(BATCH_MAX, Math.max(BATCH_MIN, Math.ceil(budget / runsPerDay)));
}

globalThis.AO3LostAndFoundCheck = {
  CheckManager,
  applyStateTransition,
  computeBackoff,
  computeBatchSize,
  getPriorityScore,
  normalizeHeadResult,
  randomDelay
};

if (typeof module !== "undefined") {
  module.exports = globalThis.AO3LostAndFoundCheck;
}
