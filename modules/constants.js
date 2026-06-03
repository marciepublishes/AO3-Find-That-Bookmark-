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
    GET_DELETED_WORKS: "GET_DELETED_WORKS",
    GET_LOST_WORKS_FILTER: "GET_LOST_WORKS_FILTER",
    SET_PINNED_TOP: "SET_PINNED_TOP",
    ENSURE_IMPORT: "ENSURE_IMPORT",
    SNAPSHOT_BOOKMARKS: "SNAPSHOT_BOOKMARKS",
    GET_STATS: "GET_STATS",
    ACKNOWLEDGE_LOST: "ACKNOWLEDGE_LOST",
    GET_SETTINGS: "GET_SETTINGS",
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
    CHECK_LAST_RUN: "check:lastRun",
    CHECK_PAUSED: "check:paused",
    SETTINGS: "settings"
  },

  // work.status values.
  STATUS: {
    ACTIVE: "active",
    UNCONFIRMED: "unconfirmed",
    DELETED: "deleted",
    ORPHANED: "orphaned",
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
