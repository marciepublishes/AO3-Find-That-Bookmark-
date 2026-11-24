/**
 * Shared string constants for AO3 Find That Bookmark.
 *
 * These values are the contract between the background worker, the content
 * script, and the popup (message types), and between the background and the
 * manager modules (meta keys, statuses, event names). Centralizing them means a
 * typo is a reference error rather than a silent dead channel.
 *
 * Loaded as a plain script (no bundler): it attaches to globalThis for the
 * extension contexts and exports for the Node test runner.
 */
const AO3LostAndFoundConstants = {
  // chrome.alarms name for the periodic check.
  ALARM_CHECK: "ao3-lost-and-found-check",

  // runtime.sendMessage message types.
  MSG: {
    // Requests (content script / popup -> background).
    GET_LOST_WORKS_FILTER: "GET_LOST_WORKS_FILTER",
    ENSURE_IMPORT: "ENSURE_IMPORT",
    FIND_MISSING_ON_PAGE: "FIND_MISSING_ON_PAGE",
    SNAPSHOT_BOOKMARKS: "SNAPSHOT_BOOKMARKS",
    GET_STATS: "GET_STATS",
    ACKNOWLEDGE_LOST: "ACKNOWLEDGE_LOST",
    GET_SETTINGS: "GET_SETTINGS",
    RECHECK_LOST: "RECHECK_LOST",
    DISMISS_OUTAGE_NOTICE: "DISMISS_OUTAGE_NOTICE",
    // Broadcasts (background -> popup / content script).
    IMPORT_PROGRESS: "IMPORT_PROGRESS",
    IMPORT_COMPLETE: "IMPORT_COMPLETE",
    IMPORT_ERROR: "IMPORT_ERROR",
    IMPORT_PAUSED: "IMPORT_PAUSED",
    IMPORT_LOGIN_REQUIRED: "IMPORT_LOGIN_REQUIRED",
    CHECK_CONFIRMED: "CHECK_CONFIRMED",
    CHECK_PAUSED: "CHECK_PAUSED",
    STATS_UPDATED: "STATS_UPDATED"
  },

  // Keys in the db.meta table.
  META: {
    USERNAME: "import:username",
    IMPORT_STATUS: "import:status",
    IMPORT_PAUSED: "import:paused",
    LAST_COMPLETED_PAGE: "import:lastCompletedPage",
    RECORDS_IMPORTED: "import:recordsImported",
    ESTIMATED_TOTAL_PAGES: "import:estimatedTotalPages",
    IMPORT_COMPLETED_AT: "import:completedAt",
    LOST_ACKNOWLEDGED: "lost:acknowledged",
    CHECK_QUEUE: "check:queue",
    CHECK_PENDING: "check:pending",
    CHECK_LAST_RUN: "check:lastRun",
    // Last work that answered 200; HEAD-checked as a canary before a 404 is
    // allowed to count, so a site-wide outage is never read as a deletion.
    CHECK_CANARY: "check:canary",
    // A user-started re-check still in progress: { ids, total, startedAt },
    // or null. Lets the popup keep showing it after being closed.
    RECHECK_STATUS: "check:recheck",
    // When the current AO3 outage was first noticed (null when AO3 is healthy).
    OUTAGE_STARTED: "check:outageStartedAt",
    // One-time re-verification of works flagged from the Oct 29 2026 outage on.
    // (v1.4.1 used "repair:outageReverify" and re-verified everything.)
    REPAIR_OUTAGE_REVERIFY: "repair:outage-2026-10-29",
    // { flagged, restored, resolved, dismissed } for the popup's Oct 29 outage
    // notice: counted at startup, `resolved` once the repair has run.
    OUTAGE_NOTICE: "repair:outageNotice",
    // One-time decode of HTML codes (e.g. &#39;) stored by pre-1.5.0 imports.
    REPAIR_DECODE_ENTITIES: "repair:decode-entities-v1",
    SETTINGS: "settings"
  },

  // AO3 lists bookmarks 20 per page; positions are always derived from this,
  // never from how many blurbs happen to render on a (short last) page.
  BOOKMARKS_PER_PAGE: 20,

  // Adaptive check-budget tuning. The per-run batch size is derived so a full
  // pass through N bookmarks finishes within ~a day (budget = clamp(N, floor,
  // ceiling) checks/day), spread across the day's runs. Raising DAILY_CEILING
  // detects faster for very large libraries at the cost of more AO3 traffic.
  CHECK: {
    DAILY_FLOOR: 150,
    DAILY_CEILING: 1500,
    BATCH_MIN: 2,
    BATCH_MAX: 32,
    // Strikes needed, and the minimum time between the first and last strike,
    // before a work is confirmed deleted. The span outlasts typical AO3 outages.
    CONFIRM_STRIKES: 3,
    CONFIRM_MIN_SPAN_MS: 12 * 60 * 60 * 1000,
    // Consecutive transient (5xx / network) responses before a run gives up.
    OUTAGE_STREAK: 3
  },

  // work.status values.
  STATUS: {
    ACTIVE: "active",
    UNCONFIRMED: "unconfirmed",
    DELETED: "deleted",
    RESTRICTED: "restricted"
  },

  // import:status (meta) values.
  IMPORT_STATE: {
    RUNNING: "running",
    PAUSED: "paused",
    COMPLETE: "complete",
    ERROR: "error"
  },

  // Internal event-bus event names (background <-> managers).
  EVENTS: {
    IMPORT_PROGRESS: "import:progress",
    IMPORT_COMPLETE: "import:complete",
    IMPORT_ERROR: "import:error",
    IMPORT_PAUSED: "import:paused",
    IMPORT_LOGIN_REQUIRED: "import:login-required",
    CHECKS_CONFIRMED: "checks:confirmed",
    CHECKS_BADGE_REFRESH: "checks:badge-refresh",
    CHECKS_PAUSED: "checks:paused",
    CHECKS_ERROR: "checks:error"
  }
};

globalThis.AO3LostAndFoundConstants = AO3LostAndFoundConstants;

if (typeof module !== "undefined") {
  module.exports = AO3LostAndFoundConstants;
}
