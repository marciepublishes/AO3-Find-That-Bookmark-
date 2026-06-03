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

class ImportManager {
  constructor({
    bus,
    db,
    fetchFn = globalThis.fetch?.bind(globalThis),
    delayFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random = Math.random,
    now = () => Date.now(),
    pageDelayRange = [4000, 8000],
    backoffDelayFn = null
  }) {
    this.bus = bus;
    this.db = db;
    this.fetchFn = fetchFn;
    this.delayFn = delayFn;
    this.random = random;
    this.now = now;
    this.pageDelayRange = pageDelayRange;
    this.backoffDelayFn = backoffDelayFn || delayFn;
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

  async pause(reason = "manual") {
    this.pauseRequested = true;
    await this.setMeta(META.IMPORT_PAUSED, true);
    await this.setMeta(META.IMPORT_STATUS, IMPORT_STATE.PAUSED);
    await this.bus?.emit?.(EVENTS.IMPORT_PAUSED, { reason });
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
    let positionOffset = 0;
    let consecutive429s = 0;

    while (page <= maxPages) {
      const response = await this.fetchBookmarkPage(name, page);

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

      const parsed = parseBookmarkPage(html, { pageNumber: page, originalPositionOffset: positionOffset });
      if (parsed.works.length === 0) break;

      const existing = await this.db.works.bulkGet(parsed.works.map((work) => work.workId));
      const reachedKnown = existing.some(Boolean);

      await this.writeChunk(parsed.works);
      captured += parsed.works.length;
      positionOffset += parsed.works.length;

      if (reachedKnown) break; // overlapped with already-tracked works
      page += 1;
      await this.delayFn(randomDelay(this.pageDelayRange[0], this.pageDelayRange[1], this.random));
    }

    return { success: true, captured, pagesFetched: page };
  }

  async run(username) {
    const lastCompletedPage = Number(await this.getMeta(META.LAST_COMPLETED_PAGE)) || 0;
    let currentPage = lastCompletedPage + 1;
    let estimatedTotalPages = Number(await this.getMeta(META.ESTIMATED_TOTAL_PAGES)) || null;
    let originalPositionOffset = Number(await this.getMeta(META.RECORDS_IMPORTED)) || 0;

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

      const parsedPage = parseBookmarkPage(html, {
        pageNumber: currentPage,
        originalPositionOffset
      });

      estimatedTotalPages = parsedPage.estimatedTotalPages || estimatedTotalPages || currentPage;
      await this.writeChunk(parsedPage.works);

      originalPositionOffset += parsedPage.works.length;
      await this.setMeta(META.LAST_COMPLETED_PAGE, currentPage);
      await this.setMeta(META.RECORDS_IMPORTED, originalPositionOffset);
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
      await this.pause(reason);
      await this.bus?.emit?.(EVENTS.IMPORT_PAUSED, {
        reason,
        message: "Import paused after repeated AO3 rate-limit responses. Please resume later."
      });
      return true;
    }
    return false;
  }

  async writeChunk(works) {
    if (!works.length) return;

    // Re-imports must not clobber detection state. Preserve the fields the
    // check-manager owns (status, fail counts, deleted/orphaned markers,
    // notification + pin flags) on works we already track, and only refresh the
    // parsed metadata and current bookmark position.
    const ids = works.map((work) => work.workId);
    const existing = await this.db.works.bulkGet(ids);
    const merged = works.map((incoming, index) => {
      const prior = existing[index];
      if (!prior) return incoming;
      return {
        ...incoming,
        status: prior.status,
        checkFailCount: prior.checkFailCount,
        lastChecked: prior.lastChecked,
        deletedAt: prior.deletedAt,
        orphanedAt: prior.orphanedAt,
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

// Parsing runs in the service worker (and on HTML strings sent from the content
// script), where there is no DOMParser — so the regex-based extractor is the
// only path. There is intentionally no DOM-based parser.
function parseBookmarkPage(html, { pageNumber = 1, originalPositionOffset = 0 } = {}) {
  const blurbs = extractBookmarkBlurbHtml(html);
  return {
    works: blurbs.map((blurbHtml, index) => parseBookmarkBlurb(blurbHtml, {
      originalPosition: originalPositionOffset + index + 1
    })).filter(Boolean),
    estimatedTotalPages: getEstimatedTotalPagesFromHtml(html, pageNumber)
  };
}

function parseBookmarkBlurb(input, { originalPosition = 1 } = {}) {
  return parseBookmarkHtml(String(input || ""), originalPosition);
}

function parseBookmarkHtml(html, originalPosition) {
  const workMatch = html.match(/<a\b[^>]*href=["']\/works\/(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
  if (!workMatch) return null;

  const requiredTagsSection = sectionHtml(html, /<ul\b[^>]*class=["'][^"']*required-tags[^"']*["'][^>]*>([\s\S]*?)<\/ul>/i);
  const freeTagsSection = sectionHtml(html, /<ul\b[^>]*class=["'][^"']*tags commas[^"']*["'][^>]*>([\s\S]*?)<\/ul>/i);
  const bookmarkMetaSection = sectionHtml(html, /<ul\b[^>]*class=["'][^"']*meta[^"']*["'][^>]*>([\s\S]*?)<\/ul>/i);
  const allFreeTags = tagTexts(freeTagsSection);

  return createWorkRecord({
    workId: workMatch[1],
    title: cleanText(stripTags(workMatch[2])),
    authors: relAuthorTexts(html),
    fandoms: tagTexts(sectionHtml(html, /<h5\b[^>]*class=["'][^"']*fandoms[^"']*["'][^>]*>([\s\S]*?)<\/h5>/i)),
    rating: tagTexts(requiredTagsSection)[0] || "",
    warnings: tagTexts(requiredTagsSection).slice(1, 2),
    categories: tagTexts(requiredTagsSection).slice(2, 3),
    relationships: allFreeTags.filter((tag) => tag.includes("/")),
    characters: allFreeTags.filter((tag) => !tag.includes("/") && !tag.includes(" ")),
    freeTags: allFreeTags.filter((tag) => tag.includes(" ") || (!tag.includes("/") && tag.includes("-"))),
    wordCount: parseNumber(statValueFromHtml(html, "Words")),
    chapters: statValueFromHtml(html, "Chapters"),
    summary: cleanText(stripTags(sectionHtml(html, /<blockquote\b[^>]*class=["'][^"']*summary[^"']*["'][^>]*>([\s\S]*?)<\/blockquote>/i))),
    bookmarkNotes: cleanText(stripTags(sectionHtml(html, /<blockquote\b[^>]*class=["'][^"']*notes[^"']*["'][^>]*>([\s\S]*?)<\/blockquote>/i))),
    bookmarkTags: tagTexts(bookmarkMetaSection),
    dateBookmarked: cleanText(stripTags(sectionHtml(html, /<p\b[^>]*class=["'][^"']*datetime[^"']*["'][^>]*>([\s\S]*?)<\/p>/i))),
    workLastUpdated: statValueFromHtml(html, "Updated"),
    originalPosition
  });
}

function createWorkRecord(fields) {
  const importedAt = Date.now();
  return {
    workId: fields.workId,
    title: fields.title || "",
    authors: fields.authors || [],
    fandoms: fields.fandoms || [],
    rating: fields.rating || "",
    warnings: fields.warnings || [],
    categories: fields.categories || [],
    relationships: fields.relationships || [],
    characters: fields.characters || [],
    freeTags: fields.freeTags || [],
    wordCount: fields.wordCount || 0,
    chapters: fields.chapters || "",
    summary: fields.summary || "",
    bookmarkNotes: fields.bookmarkNotes || "",
    bookmarkTags: fields.bookmarkTags || [],
    dateBookmarked: fields.dateBookmarked || "",
    workLastUpdated: fields.workLastUpdated || "",
    originalPosition: fields.originalPosition,
    status: STATUS.ACTIVE,
    checkFailCount: 0,
    lastChecked: null,
    deletedAt: null,
    orphanedAt: null,
    importedAt,
    pinnedToTop: false,
    notified: false
  };
}

function isLoggedInBookmarkPage(html) {
  const source = String(html || "");
  return /id=["']greeting["'][\s\S]*?(class=["'][^"']*(user|current)[^"']*["']|\/logout|Log Out|Log out)/i.test(source)
    || /id=["']user-menu["']/i.test(source);
}

function getEstimatedTotalPagesFromHtml(html, fallbackPage) {
  const numbers = [...html.matchAll(/(?:pagination|page)[\s\S]{0,200}?>(\d+)</gi)]
    .map((match) => parseInt(match[1], 10))
    .filter(Number.isFinite);
  return numbers.length ? Math.max(...numbers) : fallbackPage;
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

function statValueFromHtml(html, label) {
  const pattern = new RegExp(`<dt[^>]*>\\s*${escapeRegExp(label)}:?\\s*<\\/dt>\\s*<dd[^>]*>([\\s\\S]*?)<\\/dd>`, "i");
  return cleanText(stripTags(html.match(pattern)?.[1] || ""));
}

function extractBookmarkBlurbHtml(html) {
  return [...html.matchAll(/<li\b[^>]*(?:bookmark|work)[^>]*\bblurb\b[^>]*>[\s\S]*?<\/li>/gi)]
    .map((match) => match[0]);
}

function relAuthorTexts(html) {
  return [...html.matchAll(/<a\b[^>]*rel=["']author["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => cleanText(stripTags(match[1])))
    .filter(Boolean);
}

function tagTexts(html) {
  return [...String(html || "").matchAll(/<a\b[^>]*class=["'][^"']*tag[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => cleanText(stripTags(match[1])))
    .filter(Boolean);
}

function sectionHtml(html, pattern) {
  return String(html || "").match(pattern)?.[1] || "";
}

function extractWorkId(href) {
  return String(href || "").match(/\/works\/(\d+)/)?.[1] || "";
}

function parseNumber(value) {
  return Number(String(value || "").replace(/[^\d]/g, "")) || 0;
}

function cleanText(value) {
  return decodeHtml(String(value || "").replace(/\s+/g, " ").trim());
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]*>/g, " ");
}

function decodeHtml(value) {
  const entities = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    "#039": "'",
    apos: "'"
  };
  return String(value).replace(/&([^;]+);/g, (match, entity) => entities[entity] || match);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

globalThis.AO3LostAndFoundImport = {
  ImportManager,
  buildProgress,
  computeBackoff,
  isLoggedInBookmarkPage,
  parseBookmarkBlurb,
  parseBookmarkPage,
  randomDelay
};

if (typeof module !== "undefined") {
  module.exports = globalThis.AO3LostAndFoundImport;
}
