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
 * - Never reads an AO3 outage as a deletion: 5xx / network failures are not
 *   strikes, a 404 only counts if a canary work still loads, and confirmation
 *   needs strikes spread over CHECK.CONFIRM_MIN_SPAN_MS.
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
    this.consecutiveTransient = 0;
  }

  async runBatch({ manual = false, batchSize } = {}) {
    if (this.running) {
      return { success: false, error: "A check batch is already running." };
    }

    this.running = true;
    this.consecutiveTransient = 0;
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
        if (outcome.outage) {
          return this.stopForOutage(processed);
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
        if (outcome.outage) {
          return this.stopForOutage(processed);
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

      // First clean run after an outage: anything confirmed deleted since it
      // began gets one more look, in case a strike slipped past the guards,
      // and strikes collected during it are discarded. Statuses are never
      // reset or restored here, so this can't turn any work into a deletion.
      const outageStartedAt = await this.getMeta(META.OUTAGE_STARTED);
      if (outageStartedAt) {
        await this.setMeta(META.OUTAGE_STARTED, null);
        await this.queueDeletedForRecheck({ since: outageStartedAt });
        await this.clearStrikesSince(outageStartedAt);
      }

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

  // AO3 looks down (server errors, or a 404 while the canary also fails). End
  // the run without recording anything; the next scheduled run tries again.
  async stopForOutage(processed) {
    const message = "AO3 seems to be having trouble right now. Checking will resume automatically.";
    await this.setMeta(META.CHECK_LAST_RUN, this.now());
    if (!(await this.getMeta(META.OUTAGE_STARTED))) {
      await this.setMeta(META.OUTAGE_STARTED, this.now());
    }
    await this.bus?.emit?.(EVENTS.CHECKS_PAUSED, { reason: "outage", message });
    return { success: false, outage: true, processed, error: message };
  }

  // Checks the work at the front of `lane`, records the transition, and keeps
  // the confirmation fast-lane in sync. Returns { processed, paused, outage, pending }.
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

    if (result.transient) {
      // Server error / network failure: says nothing about the work. Skip it
      // for this run (it stays in the pending lane, or goes to the back of the
      // rotation) and stop the run if errors keep coming.
      seen.add(workId);
      if (lane === queue) queue.push(workId);
      await this.persistQueues(pending, queue);
      this.consecutiveTransient += 1;
      const outage = this.consecutiveTransient >= checkConfig().OUTAGE_STREAK;
      return { processed: true, paused: false, outage, pending };
    }

    // Before a result is allowed to change anything, make sure AO3 is really
    // serving pages: a maintenance page can come back as 200 or 403, which HEAD
    // can't tell apart from the real thing. Strikes always get a fresh check;
    // other status changes may reuse a recent healthy result.
    const nextWork = applyStateTransition(work, result, this.now());
    const addsStrike = result.deleted && work.status !== STATUS.DELETED;
    if ((addsStrike || nextWork.status !== work.status)
      && !(await this.isArchiveHealthy(workId, { fresh: addsStrike }))) {
      lane.unshift(workId);
      await this.persistQueues(pending, queue);
      return { processed: false, paused: false, outage: true, pending };
    }

    seen.add(workId);
    this.consecutive429s = 0;
    this.consecutiveTransient = 0;
    if (result.ok) {
      await this.rememberCanary(workId);
    }

    const confirmedStatusChanged = nextWork.confirmedStatusChanged;
    delete nextWork.confirmedStatusChanged;
    nextWork.priorityScore = getPriorityScore(nextWork, this.now());
    await this.db.works.put(nextWork);

    // Add to the fast-lane while collecting strikes, drop once resolved either
    // way. A work with all its strikes but not yet the minimum span waits in the
    // normal rotation instead of being re-checked every run.
    let nextPending = pending.filter((id) => id !== workId);
    if (nextWork.status === STATUS.UNCONFIRMED && nextWork.checkFailCount < checkConfig().CONFIRM_STRIKES) {
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

    try {
      const response = await this.fetchFn(`https://archiveofourown.org/works/${encodeURIComponent(work.workId)}`, {
        method: "HEAD",
        credentials: "include",
        redirect: "follow"
      });
      return normalizeHeadResult(response);
    } catch (error) {
      // Offline, DNS failure, connection reset: transient, not a verdict.
      return normalizeHeadResult(null);
    }
  }

  // GET a work that recently loaded fine (or the AO3 homepage if none is
  // known) and read the start of the page. If it errors or is AO3's
  // maintenance page, AO3 itself is unhealthy and results can't be trusted.
  async isArchiveHealthy(excludeWorkId, { fresh = true } = {}) {
    if (!fresh && this.healthyUntil > this.now()) return true;

    let canary = await this.getMeta(META.CHECK_CANARY);
    if (canary === excludeWorkId) canary = null;
    const url = canary
      ? `https://archiveofourown.org/works/${encodeURIComponent(canary)}`
      : "https://archiveofourown.org/";

    await this.delayFn(randomDelay(this.requestDelayRange[0], this.requestDelayRange[1], this.random));
    let statusCode = 0;
    let maintenance = false;
    try {
      const response = await this.fetchFn(url, { method: "GET", credentials: "include", redirect: "follow" });
      statusCode = response?.status || 0;
      // A Cloudflare bot challenge is not AO3 serving pages, whatever its code.
      maintenance = isCloudflareChallenge(response) || isMaintenancePage(await readPageStart(response));
    } catch (error) {
      statusCode = 0;
    }

    if (canary && !maintenance && (statusCode === 404 || statusCode === 410)) {
      // The canary itself may have been deleted; use the homepage next time
      // until another work answers 200.
      this.canaryId = null;
      await this.setMeta(META.CHECK_CANARY, null);
    }

    const healthy = statusCode >= 200 && statusCode < 300 && !maintenance;
    this.healthyUntil = healthy ? this.now() + HEALTH_CACHE_MS : 0;
    return healthy;
  }

  // One live check of a single work, for callers outside the batch (the
  // "Find it now" tool). True only when the work answers 404/410 AND AO3 is
  // demonstrably serving pages; any doubt answers false.
  async verifyDeleted(work) {
    try {
      const result = await this.checkWork(work);
      if (!result.deleted) return false;
      return await this.isArchiveHealthy(work.workId, { fresh: true });
    } catch (error) {
      return false;
    }
  }

  async rememberCanary(workId) {
    if (this.canaryId === workId) return;
    this.canaryId = workId;
    await this.setMeta(META.CHECK_CANARY, workId);
  }

  // The user-facing "re-check deleted works": queue every deleted work (from
  // `since` on, if given) for one more look, WITHOUT touching its status,
  // strikes or deletedAt. A false alarm that loads goes back to active; a real
  // deletion just stays deleted, so it never re-alerts or leaves the list.
  async queueRecheck({ since = null } = {}) {
    if (this.running) {
      return { success: false, error: "A check batch is running; try again in a moment." };
    }

    const reverifying = await this.queueDeletedForRecheck({ since });
    await this.bus?.emit?.(EVENTS.CHECKS_BADGE_REFRESH, { manual: true, processed: 0 });
    return { success: true, reverifying };
  }

  async queueDeletedForRecheck({ since = null } = {}) {
    const ids = (await this.db.works.toArray())
      .filter((work) => work.status === STATUS.DELETED
        && (since == null || Number(work.deletedAt || 0) >= since))
      .map((work) => work.workId);

    if (ids.length > 0) {
      const pending = new Set(await this.getPending());
      ids.forEach((id) => pending.add(id));
      await this.setMeta(META.CHECK_PENDING, [...pending]);
    }
    return ids.length;
  }

  // Strikes first recorded at or after `since` are suspect (they came from an
  // outage window): zero them so the work starts confirmation over.
  async clearStrikesSince(since) {
    const cleared = (await this.db.works.toArray())
      .filter((work) => work.status === STATUS.UNCONFIRMED
        && Number.isFinite(work.firstFailedAt) && work.firstFailedAt >= since)
      .map((work) => ({ ...work, checkFailCount: 0, firstFailedAt: null }));

    if (cleared.length > 0) {
      await this.db.works.bulkPut(cleared);
      const pending = new Set(await this.getPending());
      cleared.forEach((work) => pending.add(work.workId));
      await this.setMeta(META.CHECK_PENDING, [...pending]);
    }
  }

  // ONE-TIME Oct 29 2026 repair only (background.js repairOutageOnceHealthy).
  // Send deleted/unconfirmed works back through confirmation from zero strikes,
  // to undo false positives from an AO3 outage: works that load return to
  // active, real deletions are re-confirmed (already-notified works keep
  // `notified`, so no repeat notification). See requeueLost for `since`.
  async reverifyLost({ since = null } = {}) {
    if (this.running) {
      return { success: false, error: "A check batch is running; try again in a moment." };
    }

    const result = await this.requeueLost({ since });
    await this.bus?.emit?.(EVENTS.CHECKS_BADGE_REFRESH, { manual: true, processed: 0 });
    return { success: true, ...result };
  }

  // With `since` (a timestamp), deletions confirmed before it are trusted and
  // left alone. An unconfirmed work whose deletedAt predates `since` was
  // confirmed back then and only reset by a blanket re-check (v1.4.1), so it is
  // restored to deleted rather than re-verified. Without `since`, everything
  // deleted or unconfirmed is re-verified.
  async requeueLost({ since = null } = {}) {
    const { reset, restored, flaggedIds } = planRequeue(await this.db.works.toArray(), since);

    if (reset.length + restored.length > 0) {
      await this.db.works.bulkPut([...reset, ...restored]);
    }

    const pending = new Set(await this.getPending());
    reset.forEach((work) => pending.add(work.workId));
    restored.forEach((work) => pending.delete(work.workId));
    await this.setMeta(META.CHECK_PENDING, [...pending]);
    return { reverifying: reset.length, restored: restored.length, flaggedIds };
  }

  // What requeueLost would do, without writing anything. `flagged` counts the
  // works currently shown as deleted that would be cleared.
  async previewRequeue({ since = null } = {}) {
    const { reset, restored, flaggedIds } = planRequeue(await this.db.works.toArray(), since);
    return { reverifying: reset.length, restored: restored.length, flagged: flaggedIds.length };
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
      // Ends this run only; the next scheduled run tries again.
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

// Splits works for requeueLost: `reset` go back through confirmation,
// `restored` return to deleted, `flaggedIds` are reset works that were showing
// as deleted (their notifications can be cleared).
function planRequeue(works, since = null) {
  const confirmedBefore = (work) => since != null && Number(work.deletedAt || 0) < since;
  const reset = [];
  const restored = [];
  const flaggedIds = [];

  for (const work of works) {
    if (work.status === STATUS.UNCONFIRMED && Number(work.deletedAt) > 0 && confirmedBefore(work)) {
      restored.push({ ...work, status: STATUS.DELETED, checkFailCount: Math.max(3, Number(work.checkFailCount) || 0) });
    } else if (work.status === STATUS.UNCONFIRMED || (work.status === STATUS.DELETED && !confirmedBefore(work))) {
      if (work.status === STATUS.DELETED) flaggedIds.push(work.workId);
      reset.push({ ...work, status: STATUS.UNCONFIRMED, checkFailCount: 0, firstFailedAt: null });
    }
  }

  return { reset, restored, flaggedIds };
}

// How long a healthy canary result is reused for non-strike status changes.
const HEALTH_CACHE_MS = 5 * 60 * 1000;

// AO3's maintenance / "Request temporarily denied" page. It can arrive with a
// 200, so the status code alone can't be trusted.
function isMaintenancePage(html) {
  return /down for maintenance|Request temporarily denied/i.test(String(html || ""));
}

// Reads only the first few KB of a page (the maintenance marker is near the
// top), so a health check never downloads a whole chapter.
async function readPageStart(response, maxChars = 16384) {
  try {
    const reader = response?.body?.getReader?.();
    if (!reader) {
      return typeof response?.text === "function" ? (await response.text()).slice(0, maxChars) : "";
    }
    const decoder = new TextDecoder();
    let text = "";
    while (text.length < maxChars) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    reader.cancel().catch(() => {});
    return text;
  } catch (error) {
    return "";
  }
}

function checkConfig() {
  return {
    CONFIRM_STRIKES: 3,
    CONFIRM_MIN_SPAN_MS: 12 * 60 * 60 * 1000,
    OUTAGE_STREAK: 3,
    ...(Constants.CHECK || {})
  };
}

// Cloudflare marks its challenge / block responses with a `cf-mitigated`
// header. They usually arrive as 403, which would otherwise read as a locked
// work, but they say nothing about the work itself.
function isCloudflareChallenge(response) {
  try {
    return Boolean(response?.headers?.get?.("cf-mitigated"));
  } catch (error) {
    return false;
  }
}

function normalizeHeadResult(response) {
  const statusCode = response?.status || 0;
  if (isCloudflareChallenge(response)) {
    return { statusCode, deleted: false, restricted: false, ok: false, transient: true };
  }
  const deleted = statusCode === 404 || statusCode === 410;
  // Restricted/locked works still exist; tracked only so a 401/403 is never
  // mistaken for a deletion.
  const restricted = statusCode === 401 || statusCode === 403;
  const ok = statusCode >= 200 && statusCode < 300;

  return {
    statusCode,
    deleted,
    restricted,
    ok,
    // Anything else (5xx, Cloudflare 52x, network failure = 0, odd 3xx/4xx)
    // says nothing about whether the work exists.
    transient: !deleted && !restricted && !ok && statusCode !== 429
  };
}

function applyStateTransition(work, result, now = Date.now()) {
  const statusCode = result?.statusCode;
  const skipped = statusCode === 429 || Boolean(result?.transient);
  const base = {
    ...work,
    lastChecked: skipped ? work.lastChecked ?? null : now,
    confirmedStatusChanged: false
  };

  if (skipped) {
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
    const { CONFIRM_STRIKES, CONFIRM_MIN_SPAN_MS } = checkConfig();
    const previousFails = Number(work.checkFailCount) || 0;
    const nextFailCount = previousFails + 1;
    const firstFailedAt = previousFails > 0 && Number.isFinite(work.firstFailedAt) ? work.firstFailedAt : now;
    const alreadyConfirmed = work.status === STATUS.DELETED;

    if (alreadyConfirmed || (nextFailCount >= CONFIRM_STRIKES && now - firstFailedAt >= CONFIRM_MIN_SPAN_MS)) {
      return {
        ...base,
        status: STATUS.DELETED,
        checkFailCount: nextFailCount,
        firstFailedAt,
        deletedAt: work.deletedAt || now,
        pinnedToTop: alreadyConfirmed ? work.pinnedToTop : true,
        confirmedStatusChanged: !alreadyConfirmed
      };
    }

    return {
      ...base,
      status: STATUS.UNCONFIRMED,
      checkFailCount: nextFailCount,
      firstFailedAt
    };
  }

  if (result?.ok) {
    return {
      ...base,
      status: STATUS.ACTIVE,
      checkFailCount: 0,
      firstFailedAt: null,
      deletedAt: null,
      // It came back, so a future deletion deserves a fresh notification.
      notified: false
    };
  }

  return base;
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
  isMaintenancePage,
  normalizeHeadResult,
  randomDelay
};

if (typeof module !== "undefined") {
  module.exports = globalThis.AO3LostAndFoundCheck;
}
