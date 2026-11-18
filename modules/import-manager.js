/**
 * ImportManager contract:
 * Input:
 * - bus: event bus with emit(type, payload)
 * - db: Dexie database with works and meta tables
 * - fetchFn: fetch-compatible function
 * - delayFn: async function receiving milliseconds
 * Output:
 * - Upserts parsed work records to db.works in page-sized chunks.
 * - Persists import progress in db.meta so imports survive restarts.
 * - Emits import:progress, import:paused, import:error, and import:complete.
 *
 * This module does not import other extension modules. background.js wires it
 * into the event bus and database.
 */
// NOTE: importScripts loads every module into one shared worker scope, so these
// must be `var` (redeclaration-safe) rather than `const` — check-manager.js
// declares the same names. They all resolve to the same constants object.
var Constants = globalThis.AO3LostAndFoundConstants
  || (typeof require === "function" ? require("./constants") : {});
var { META, STATUS, EVENTS, IMPORT_STATE } = Constants;

// Record parsing lives in the shared bookmark-parser module so the worker
// import walk and the content-script snapshot path produce identical records.
var Parser = globalThis.AO3LostAndFoundParser
  || (typeof require === "function" ? require("./bookmark-parser") : {});

class ImportManager {
  constructor({
    bus,
    db,
    fetchFn = globalThis.fetch?.bind(globalThis),
    delayFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random = Math.random,
    now = () => Date.now(),
    pageDelayRange = [4000, 8000],
    backoffDelayFn = null,
    // async (work) => boolean. A live "is this work really gone?" check used
    // before a positional (tier 2) match is confirmed. Without one, positional
    // matches are only ever reported, never confirmed.
    verifyDeleted = null
  }) {
    this.bus = bus;
    this.db = db;
    this.fetchFn = fetchFn;
    this.delayFn = delayFn;
    this.random = random;
    this.now = now;
    this.pageDelayRange = pageDelayRange;
    this.backoffDelayFn = backoffDelayFn || delayFn;
    this.verifyDeleted = verifyDeleted;
    this.running = false;
    this.pauseRequested = false;
    this.consecutive429s = 0;
    this.currentRun = null;
  }

  async start({ username, resume = false }) {
    const normalizedUsername = String(username || "").trim();
    if (!normalizedUsername) {
      return { success: false, error: "AO3 username is required." };
    }
    if (this.running) {
      return { success: false, error: "An import is already running." };
    }

    this.running = true;
    this.pauseRequested = false;
    this.consecutive429s = 0;

    await this.setMeta(META.USERNAME, normalizedUsername);
    if (!resume) {
      await this.setMeta(META.LAST_COMPLETED_PAGE, 0);
      await this.setMeta(META.RECORDS_IMPORTED, 0);
      await this.setMeta(META.ESTIMATED_TOTAL_PAGES, null);
    }
    await this.setMeta(META.IMPORT_PAUSED, false);
    await this.setMeta(META.IMPORT_STATUS, IMPORT_STATE.RUNNING);

    this.currentRun = this.run(normalizedUsername)
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        await this.setMeta(META.IMPORT_STATUS, IMPORT_STATE.ERROR);
        await this.bus?.emit?.(EVENTS.IMPORT_ERROR, { message });
      })
      .finally(() => {
        this.running = false;
      });

    return { success: true, status: IMPORT_STATE.RUNNING };
  }

  async pause(reason = "manual", message) {
    this.pauseRequested = true;
    await this.setMeta(META.IMPORT_PAUSED, true);
    await this.setMeta(META.IMPORT_STATUS, IMPORT_STATE.PAUSED);
    await this.bus?.emit?.(EVENTS.IMPORT_PAUSED, message ? { reason, message } : { reason });
    return { success: true };
  }

  async resume() {
    const username = await this.getMeta(META.USERNAME);
    if (!username) {
      return { success: false, error: "No paused import is available to resume." };
    }

    return this.start({ username, resume: true });
  }

  /**
   * Decide whether to start, resume, or skip an import. This is the single
   * source of truth so the background can stay thin and the logic stays
   * testable.
   *
   * Crucially, it self-heals after a service-worker eviction: if the database
   * says an import is IMPORT_STATE.RUNNING but this worker isn't actually running one
   * (a fresh worker after eviction), it resumes from the last completed page
   * instead of refusing forever.
   */
  async ensureRunning({ username } = {}) {
    const name = String(username || "").trim();
    if (!name) {
      return { success: false, error: "AO3 username is required." };
    }

    // Genuinely running in this worker.
    if (this.running) {
      return { success: true, skipped: "already-running" };
    }

    const status = await this.getMeta(META.IMPORT_STATUS);

    // Status says running but nothing is running here: the worker was evicted
    // mid-walk. Resume from where it left off.
    if (status === IMPORT_STATE.RUNNING) {
      return this.start({ username: name, resume: true });
    }

    // A completed walk that produced data is never repeated.
    if (status === IMPORT_STATE.COMPLETE && (await this.db.works.count()) > 0) {
      return { success: true, skipped: "already-imported" };
    }

    return this.start({ username: name, resume: status === IMPORT_STATE.PAUSED });
  }

  /**
   * Incremental sweep for newly added bookmarks. Walks listing pages from the
   * top (newest-first) and stops as soon as a page overlaps works already in
   * the database — so it usually costs a single request, and only fetches more
   * pages when many new bookmarks have piled up. It never touches import status
   * and merge-writes, so existing detection state is preserved.
   */
  async syncRecent(username, { maxPages = 50 } = {}) {
    const name = String(username || "").trim();
    if (!name || !this.fetchFn || this.running) {
      return { success: false, skipped: this.running ? "import-running" : "unavailable" };
    }

    let page = 1;
    let captured = 0;
    let consecutive429s = 0;

    while (page <= maxPages) {
      let response;
      try {
        response = await this.fetchBookmarkPage(name, page);
      } catch (error) {
        return {
          success: false,
          skipped: "network-error",
          transient: true,
          captured,
          error: error instanceof Error ? error.message : String(error)
        };
      }

      if (response.status === 429) {
        consecutive429s += 1;
        if (consecutive429s >= 3) {
          return { success: false, paused: true, captured };
        }
        await this.backoffDelayFn(computeBackoff(consecutive429s));
        continue;
      }
      if (!response.ok) break;

      const html = await response.text();
      if (!isLoggedInBookmarkPage(html)) break; // logged out — stay quiet
      consecutive429s = 0;

      const parsed = Parser.parseBookmarkPage(html, {
        pageNumber: page,
        originalPositionOffset: (page - 1) * BOOKMARKS_PER_PAGE
      });
      if (parsed.works.length === 0) break;

      const existing = await this.db.works.bulkGet(parsed.works.map((work) => work.workId));
      const reachedKnown = existing.some(Boolean);

      await this.writeChunk(parsed.works);
      captured += parsed.works.length;

      if (reachedKnown) break; // overlapped with already-tracked works
      page += 1;
      await this.delayFn(randomDelay(this.pageDelayRange[0], this.pageDelayRange[1], this.random));
    }

    return { success: true, captured, pagesFetched: page };
  }

  /**
   * On-demand "which bookmark went missing?" for a single listing page. Far
   * cheaper and less scraper-shaped than the per-work HEAD sweep: one GET on the
   * user's own bookmarks page, then reconcile what it shows against what we have
   * stored. A deleted work leaves a "this has been deleted" placeholder in the
   * list, and reconcileMissingOnPage maps that placeholder back to the work it
   * used to be (by bookmark id, or by its surviving neighbours). Confidently
   * matched works are confirmed deleted immediately — the in-list notice is
   * authoritative, so there is no need to wait for the 3-strike HEAD dance.
   */
  async findMissingOnPage(username, pageNumber) {
    const name = String(username || "").trim();
    const page = Math.max(1, Math.floor(Number(pageNumber) || 0));
    if (!name) return { success: false, error: "AO3 username is required." };
    if (!Number(pageNumber)) return { success: false, error: "A bookmarks page number is required." };
    if (this.running) return { success: false, skipped: "import-running" };

    let response;
    try {
      response = await this.fetchBookmarkPage(name, page);
    } catch (error) {
      return {
        success: false,
        transient: true,
        error: error instanceof Error ? error.message : String(error)
      };
    }
    if (response.status === 429) {
      return { success: false, paused: true, error: "AO3 is rate-limiting requests. Try again in a minute." };
    }
    if (!response.ok) {
      return { success: false, error: `AO3 returned ${response.status} for bookmarks page ${page}.` };
    }

    const html = await response.text();
    if (!isLoggedInBookmarkPage(html)) {
      return { success: false, loggedOut: true, error: "You appear to be logged out of AO3 — log in and try again." };
    }

    const { works, deleted } = Parser.parseBookmarkPage(html, {
      pageNumber: page,
      originalPositionOffset: (page - 1) * BOOKMARKS_PER_PAGE
    });

    // Refresh metadata + bookmark ids (and current positions) for the live works
    // we just saw; this also sharpens positional anchoring on future runs.
    await this.writeChunk(works);

    if (deleted.length === 0) {
      return { success: true, page, deletedFound: 0, confirmed: [], ambiguous: [] };
    }

    const stored = await this.db.works.toArray();
    const matches = Parser.reconcileMissingOnPage({ works, deleted, stored });

    const confirmed = [];
    const ambiguous = [];
    for (const match of matches) {
      // Tier 1 (bookmark id) is authoritative. Tier 2 rests on stored
      // positions, which go stale, so it must also fail a live check.
      const trusted = match.work && (match.tier === 1 || (await this.isVerifiedDeleted(match.work)));
      if (trusted) {
        const next = await this.confirmDeletedFromListing(match.work);
        confirmed.push(summariseWork(next, match.tier));
      } else {
        ambiguous.push({
          bookmarkId: match.bookmarkId,
          candidates: match.candidates.map((c) => summariseWork(c))
        });
      }
    }

    return { success: true, page, deletedFound: deleted.length, confirmed, ambiguous };
  }

  async isVerifiedDeleted(work) {
    if (typeof this.verifyDeleted !== "function") return false;
    try {
      return Boolean(await this.verifyDeleted(work));
    } catch (error) {
      return false;
    }
  }

  // Confirm a work deleted because the listing said so outright. Mirrors the
  // check-manager's confirmed-deletion shape (status, deletedAt, pin, fail
  // count) and emits the same event so the badge, notification and popup all
  // update through the existing path.
  async confirmDeletedFromListing(work) {
    const now = this.now();
    const wasConfirmed = work.status === STATUS.DELETED;
    const next = {
      ...work,
      status: STATUS.DELETED,
      checkFailCount: Math.max(3, Number(work.checkFailCount) || 0),
      deletedAt: work.deletedAt || now,
      lastChecked: now,
      pinnedToTop: true
    };
    await this.db.works.put(next);
    if (!wasConfirmed) {
      await this.bus?.emit?.(EVENTS.CHECKS_CONFIRMED, { work: next, previousStatus: work.status });
    }
    return next;
  }

  async run(username) {
    const lastCompletedPage = Number(await this.getMeta(META.LAST_COMPLETED_PAGE)) || 0;
    let currentPage = lastCompletedPage + 1;
    let estimatedTotalPages = Number(await this.getMeta(META.ESTIMATED_TOTAL_PAGES)) || null;
    // A running count of imported works (progress only). Positions come from
    // the page number, so a deleted placeholder on a page can't shift them.
    let recordsImported = Number(await this.getMeta(META.RECORDS_IMPORTED)) || 0;

    while (!this.pauseRequested) {
      const response = await this.fetchBookmarkPage(username, currentPage);

      if (response.status === 429) {
        const shouldPause = await this.handle429("rate-limit");
        if (shouldPause) return;
        continue;
      }

      if (!response.ok) {
        throw new Error(`AO3 returned HTTP ${response.status} while importing page ${currentPage}.`);
      }

      const html = await response.text();
      if (!isLoggedInBookmarkPage(html)) {
        await this.pause("logged-out");
        const priorCompletedPage = Number(await this.getMeta(META.LAST_COMPLETED_PAGE)) || 0;
        const message = priorCompletedPage === 0
          ? "Please log in to AO3 before importing bookmarks."
          : "Import paused — please log back in to AO3 to continue.";
        await this.bus?.emit?.(EVENTS.IMPORT_LOGIN_REQUIRED, {
          message
        });
        return;
      }

      this.consecutive429s = 0;

      const parsedPage = Parser.parseBookmarkPage(html, {
        pageNumber: currentPage,
        originalPositionOffset: (currentPage - 1) * BOOKMARKS_PER_PAGE
      });

      estimatedTotalPages = parsedPage.estimatedTotalPages || estimatedTotalPages || currentPage;
      await this.writeChunk(parsedPage.works);

      recordsImported += parsedPage.works.length;
      await this.setMeta(META.LAST_COMPLETED_PAGE, currentPage);
      await this.setMeta(META.RECORDS_IMPORTED, recordsImported);
      await this.setMeta(META.ESTIMATED_TOTAL_PAGES, estimatedTotalPages);

      const progress = buildProgress(currentPage, estimatedTotalPages);
      await this.bus?.emit?.(EVENTS.IMPORT_PROGRESS, progress);

      if (currentPage >= estimatedTotalPages || parsedPage.works.length === 0) {
        await this.setMeta(META.IMPORT_STATUS, IMPORT_STATE.COMPLETE);
        await this.setMeta(META.IMPORT_PAUSED, false);
        await this.bus?.emit?.(EVENTS.IMPORT_COMPLETE, progress);
        return;
      }

      currentPage += 1;
      await this.delayFn(randomDelay(this.pageDelayRange[0], this.pageDelayRange[1], this.random));
    }

    await this.pause("manual");
  }

  async fetchBookmarkPage(username, pageNumber) {
    if (!this.fetchFn) {
      throw new Error("Fetch is unavailable in this browser context.");
    }

    const url = `https://archiveofourown.org/users/${encodeURIComponent(username)}/bookmarks?page=${pageNumber}`;
    return this.fetchFn(url, {
      credentials: "include",
      headers: {
        Accept: "text/html"
      }
    });
  }

  async handle429(reason) {
    this.consecutive429s += 1;
    await this.backoffDelayFn(computeBackoff(this.consecutive429s));

    if (this.consecutive429s >= 3) {
      // pause() announces it; one event, carrying the message.
      await this.pause(reason, "Import paused after repeated AO3 rate-limit responses. Please resume later.");
      return true;
    }
    return false;
  }

  async writeChunk(works) {
    if (!works.length) return;

    // Re-imports must not clobber detection state. Preserve the fields the
    // check-manager owns (status, fail count, deleted marker, notification +
    // pin flags) on works we already track, and only refresh the parsed
    // metadata and current bookmark position.
    const ids = works.map((work) => work.workId);
    const existing = await this.db.works.bulkGet(ids);
    const merged = works.map((incoming, index) => {
      const prior = existing[index];
      if (!prior) return incoming;
      return {
        ...incoming,
        status: prior.status,
        checkFailCount: prior.checkFailCount,
        // When the current run of strikes began; dropping it would restart
        // the 12-hour confirmation span every time the user views the page.
        firstFailedAt: prior.firstFailedAt ?? null,
        lastChecked: prior.lastChecked,
        deletedAt: prior.deletedAt,
        notified: prior.notified,
        pinnedToTop: prior.pinnedToTop,
        priorityScore: prior.priorityScore
      };
    });

    await this.db.works.bulkPut(merged);
  }

  async getMeta(key) {
    const row = await this.db.meta.get(key);
    return row?.value ?? null;
  }

  async setMeta(key, value) {
    await this.db.meta.put({ key, value });
  }
}

// AO3 paginates bookmark listings at 20 per page; used to map a page number to
// the originalPosition range its blurbs occupy.
var BOOKMARKS_PER_PAGE = Constants.BOOKMARKS_PER_PAGE || 20;

// Trim a stored record down to what the popup needs to name a missing work.
function summariseWork(work, tier) {
  const summary = {
    workId: work.workId,
    title: work.title || "",
    authors: work.authors || [],
    dateBookmarked: work.dateBookmarked || ""
  };
  if (tier) summary.tier = tier;
  return summary;
}

function isLoggedInBookmarkPage(html) {
  const source = String(html || "");
  return /id=["']greeting["'][\s\S]*?(class=["'][^"']*(user|current)[^"']*["']|\/logout|Log Out|Log out)/i.test(source)
    || /id=["']user-menu["']/i.test(source);
}

function buildProgress(currentPage, estimatedTotalPages) {
  const total = Math.max(currentPage, estimatedTotalPages || currentPage);
  return {
    currentPage,
    estimatedTotalPages: total,
    percentComplete: Math.min(100, Math.round((currentPage / total) * 100))
  };
}

function computeBackoff(attempt) {
  const sequence = [30000, 60000, 120000];
  return sequence[Math.max(0, Math.min(sequence.length - 1, attempt - 1))];
}

function randomDelay(min, max, random = Math.random) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
    throw new Error("randomDelay requires finite min and max values with min <= max.");
  }

  return Math.floor(random() * (max - min + 1)) + min;
}

globalThis.AO3LostAndFoundImport = {
  ImportManager,
  buildProgress,
  computeBackoff,
  isLoggedInBookmarkPage,
  // Re-exported from the shared parser so existing callers/tests keep working.
  parseBookmarkBlurb: Parser.parseBookmarkBlurb,
  parseBookmarkPage: Parser.parseBookmarkPage,
  randomDelay
};

if (typeof module !== "undefined") {
  module.exports = globalThis.AO3LostAndFoundImport;
}
