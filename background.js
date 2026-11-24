if (typeof importScripts === "function" && !globalThis.AO3LostAndFoundDB) {
  importScripts("lib/dexie.min.js");
  importScripts("modules/constants.js");
  importScripts("modules/db.js");
  importScripts("modules/bookmark-parser.js");
  importScripts("modules/import-manager.js");
  importScripts("modules/check-manager.js");
}

const C = globalThis.AO3LostAndFoundConstants;

const runtime = globalThis.browser || globalThis.chrome;
const alarmApi = runtime?.alarms;
const actionApi = runtime?.action;
const notificationsApi = runtime?.notifications;
const db = globalThis.AO3LostAndFoundDB.initDatabase(globalThis.Dexie);

class EventBus {
  constructor() {
    this.listeners = new Map();
  }

  on(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
    return () => listeners.delete(listener);
  }

  async emit(type, payload) {
    const listeners = [...(this.listeners.get(type) || [])];
    return Promise.all(listeners.map((listener) => listener(payload)));
  }
}

const eventBus = new EventBus();
const importManager = new globalThis.AO3LostAndFoundImport.ImportManager({
  bus: eventBus,
  db,
  // "Find it now" positional matches must fail a live check before they are
  // confirmed. checkManager is declared just below; this only runs later.
  verifyDeleted: (work) => checkManager.verifyDeleted(work)
});
const checkManager = new globalThis.AO3LostAndFoundCheck.CheckManager({
  bus: eventBus,
  db
});

const DEFAULT_SETTINGS = {
  importDelayMin: 4000,
  importDelayMax: 8000,
  checkDelayMin: 3000,
  checkDelayMax: 6000,
  checkFrequencyMinutes: 30,
  autoCheckEnabled: true,
  deletedColor: "#41653E"
};

async function getMeta(key) {
  const row = await db.meta.get(key);
  return row?.value ?? null;
}

async function setMeta(key, value) {
  await db.meta.put({ key, value });
}

async function countByStatus(status) {
  return db.works.where("status").equals(status).count();
}

async function getVisibleOutageNotice() {
  const notice = await getMeta(C.META.OUTAGE_NOTICE);
  return notice && !notice.dismissed ? notice : null;
}

async function getStats() {
  const [total, active, deleted, lastChecked] = await Promise.all([
    db.works.count(),
    countByStatus(C.STATUS.ACTIVE),
    countByStatus(C.STATUS.DELETED),
    db.works.orderBy("lastChecked").last()
  ]);

  let acknowledged = Number(await getMeta(C.META.LOST_ACKNOWLEDGED)) || 0;
  if (acknowledged > deleted) {
    // A previously-deleted work came back; keep the baseline in step.
    acknowledged = deleted;
    await setMeta(C.META.LOST_ACKNOWLEDGED, acknowledged);
  }
  const newLost = Math.max(0, deleted - acknowledged);

  return {
    total,
    active,
    deleted,
    newLost,
    lastChecked: lastChecked?.lastChecked ?? null,
    username: await getMeta(C.META.USERNAME),
    outageNotice: await getVisibleOutageNotice(),
    // Keeps the outage write-up in the help panel even after the notice is dismissed.
    outageAffected: Boolean(await getMeta(C.META.OUTAGE_NOTICE)),
    // A user-started re-check still in progress ({ remaining, total }), or null.
    recheck: await checkManager.getRecheckStatus(),
    importStatus: await getMeta(C.META.IMPORT_STATUS),
    importLastCompletedPage: await getMeta(C.META.LAST_COMPLETED_PAGE),
    importEstimatedTotalPages: await getMeta(C.META.ESTIMATED_TOTAL_PAGES)
  };
}

async function acknowledgeLostWorks() {
  // Mark every currently-deleted work as seen, so newLost (and the badge) go to
  // zero. Refresh the badge and push fresh stats so an open popup clears live.
  await setMeta(C.META.LOST_ACKNOWLEDGED, await getLostWorkCount());
  await updateBadgeCount();
  const stats = await getStats();
  broadcast({ type: C.MSG.STATS_UPDATED, stats });
  return { success: true, stats };
}

async function getLostWorkCount() {
  return countByStatus(C.STATUS.DELETED);
}

const BADGE_BG_COLOR = "#EC1F32";
const BADGE_TEXT_COLOR = "#FFFFFF";

async function updateBadgeCount() {
  // The badge is an alert channel: it counts deletions the user hasn't looked at
  // yet (newLost), not the permanent deleted total. Viewing the deleted-works
  // list acknowledges them, dropping newLost — and the badge — back to empty.
  const { newLost, outageNotice } = await getStats();
  await actionApi?.setBadgeBackgroundColor?.({ color: BADGE_BG_COLOR });
  await actionApi?.setBadgeTextColor?.({ color: BADGE_TEXT_COLOR });
  await actionApi?.setBadgeText?.({ text: newLost > 0 ? String(newLost) : "" });
  await actionApi?.setTitle?.({
    title: outageNotice && !outageNotice.resolved
      ? "AO3 Find That Bookmark! — deletion alerts from the Oct 29 AO3 outage are false alarms. They'll clear on their own once AO3 is back."
      : newLost > 0
      ? `AO3 Find That Bookmark! — ${newLost} newly deleted bookmarked work${newLost === 1 ? "" : "s"}. Click to investigate.`
      : "AO3 Find That Bookmark!"
  });
  return newLost;
}

async function getBookmarksUrl() {
  const username = await getMeta(C.META.USERNAME);
  return username
    ? `https://archiveofourown.org/users/${encodeURIComponent(username)}/bookmarks`
    : "https://archiveofourown.org/users/login";
}

async function fireLostWorkNotification(work) {
  if (work.notified) return;

  const author = Array.isArray(work.authors) && work.authors.length > 0
    ? work.authors.join(", ")
    : "Unknown author";

  await db.works.update(work.workId, { notified: true });
  notificationsApi?.create?.(`ao3-lost-and-found-${C.STATUS.DELETED}-${work.workId}`, {
    type: "basic",
    iconUrl: "icons/icon-128.png",
    title: "Deleted Work Detected",
    message: `${work.title} by ${author} has been deleted from AO3.`
  });
}

async function getLostWorksByStatus({ status, pageNumber = 1, pageSize = 20 }) {
  if (status !== C.STATUS.DELETED) {
    return { works: [], total: 0, pageNumber: 1, pageSize: Number(pageSize) || 20 };
  }

  const page = Math.max(1, Number(pageNumber) || 1);
  const size = Math.max(1, Number(pageSize) || 20);
  const allWorks = await db.works.where("status").equals(status).toArray();
  const sorted = allWorks.sort((left, right) => (Number(left.originalPosition) || 0) - (Number(right.originalPosition) || 0));
  const start = (page - 1) * size;

  return {
    works: sorted.slice(start, start + size),
    total: sorted.length,
    pageNumber: page,
    pageSize: size
  };
}

// Settings are fixed defaults now; there is no settings UI. getSettings still
// merges any stored overrides for forward compatibility, but nothing writes
// them today.
async function getSettings() {
  return {
    ...DEFAULT_SETTINGS,
    ...((await getMeta(C.META.SETTINGS)) || {})
  };
}

async function applySettings(settings) {
  importManager.pageDelayRange = [settings.importDelayMin, settings.importDelayMax];
  checkManager.requestDelayRange = [settings.checkDelayMin, settings.checkDelayMax];
  await ensureCheckScheduled(settings);
  await updateBadgeCount();
}

// Runs on every worker start. The worker restarts often (opening the popup,
// visiting AO3 profile/bookmark pages), so it must keep a check that's already
// scheduled: re-creating the alarm each time replaced it, pushing the next
// check back indefinitely for anyone who kept looking.
async function ensureCheckScheduled(settings) {
  if (settings.autoCheckEnabled) {
    const existing = await alarmApi?.get?.(C.ALARM_CHECK);
    if (existing) return;
  }
  await scheduleNextCheck(settings);
}

// Schedule the next check as a one-shot alarm with ±25% jitter around the
// configured frequency, so the cadence is irregular rather than clockwork. The
// alarm handler reschedules after each run.
async function scheduleNextCheck(settings) {
  const current = settings || (await getSettings());
  if (!current.autoCheckEnabled) {
    alarmApi?.clear?.(C.ALARM_CHECK);
    return;
  }
  const base = current.checkFrequencyMinutes;
  const jittered = Math.round(base * (0.75 + Math.random() * 0.5));
  alarmApi?.create?.(C.ALARM_CHECK, { delayInMinutes: jittered });
}

// Silent auto-import entry point. Called by the content script when the user
// lands on their own bookmarks page. Does ONE gentle full walk the first time
// (or resumes a paused/interrupted one); after that it stays quiet and relies
// on opportunistic capture of pages the user browses. The decision logic lives
// in the manager so it is testable and self-heals after worker eviction.
async function ensureImport(username) {
  return importManager.ensureRunning({ username });
}

// Resume an import that a service-worker eviction left mid-walk. Safe to call on
// any wake: it only acts when the database says an import is running but no run
// is actually in progress in this worker.
async function reconcileImport() {
  const username = await getMeta(C.META.USERNAME);
  if (!username) return;
  if ((await getMeta(C.META.IMPORT_STATUS)) === C.IMPORT_STATE.RUNNING && !importManager.running) {
    await importManager.ensureRunning({ username });
  }
}

// Opportunistic capture: merge in the bookmark blurbs the user is actually
// viewing, with no extra page fetches. Reuses the import parser and the
// merge-safe writer, so it never clobbers detection state.
async function snapshotBookmarks({ records = [], blurbs = [], username } = {}) {
  // The content script now parses blurbs against the live DOM and sends
  // structured records. Validate the shape (it comes from a content script).
  let incoming = (Array.isArray(records) ? records : []).filter((record) => record && record.workId);

  // Back-compat: an older content script may still send raw blurb HTML.
  if (incoming.length === 0 && Array.isArray(blurbs) && blurbs.length > 0) {
    const parse = globalThis.AO3LostAndFoundParser.parseBookmarkBlurb;
    incoming = blurbs
      .map((item) => parse(item?.html, { originalPosition: Number(item?.position) || 1 }))
      .filter(Boolean);
  }

  if (incoming.length > 0) {
    await importManager.writeChunk(incoming);
  }

  const name = String(username || "").trim();
  if (name && !(await getMeta(C.META.USERNAME))) {
    await setMeta(C.META.USERNAME, name);
  }

  await updateBadgeCount();
  return { success: true, captured: incoming.length };
}

function broadcast(message) {
  try {
    // Fire-and-forget notification to the popup. When the popup is closed there
    // is no receiver, so the returned promise rejects with "Could not establish
    // connection" — swallow it rather than letting it surface as unhandled.
    const result = runtime?.runtime?.sendMessage?.(message);
    if (result && typeof result.catch === "function") {
      result.catch(() => {});
    }
  } catch (error) {
    // No receiving end (e.g., popup closed) — safe to ignore.
  }
}

eventBus.on(C.EVENTS.IMPORT_PROGRESS, (progress) => {
  broadcast({ type: C.MSG.IMPORT_PROGRESS, progress });
});

eventBus.on(C.EVENTS.IMPORT_COMPLETE, async (progress) => {
  await setMeta(C.META.IMPORT_COMPLETED_AT, Date.now());
  broadcast({ type: C.MSG.IMPORT_COMPLETE, progress });
  // Run an initial status pass so detection happens without user action.
  checkManager.runBatch({ manual: false }).catch(console.error);
});

eventBus.on(C.EVENTS.IMPORT_ERROR, ({ message }) => {
  broadcast({ type: C.MSG.IMPORT_ERROR, message });
});

eventBus.on(C.EVENTS.IMPORT_PAUSED, ({ reason, message }) => {
  broadcast({ type: C.MSG.IMPORT_PAUSED, reason, message });
});

eventBus.on(C.EVENTS.IMPORT_LOGIN_REQUIRED, ({ message }) => {
  const body = message || "Import paused - please log back in to AO3 to continue.";
  broadcast({ type: C.MSG.IMPORT_LOGIN_REQUIRED, message: body });
  notificationsApi?.create?.("ao3-lost-and-found-import-paused", {
    type: "basic",
    iconUrl: "icons/icon-128.png",
    title: "AO3 Lost and Found",
    message: body
  });
});

eventBus.on(C.EVENTS.CHECKS_CONFIRMED, async ({ work }) => {
  await fireLostWorkNotification(work);
  await updateBadgeCount();
  broadcast({ type: C.MSG.CHECK_CONFIRMED, workId: work.workId, status: work.status });
});

eventBus.on(C.EVENTS.CHECKS_BADGE_REFRESH, async () => {
  await updateBadgeCount();
  broadcast({ type: C.MSG.STATS_UPDATED, stats: await getStats() });
});

eventBus.on(C.EVENTS.CHECKS_PAUSED, ({ message }) => {
  broadcast({ type: C.MSG.CHECK_PAUSED, message });
});

const messageHandlers = {
  [C.MSG.GET_LOST_WORKS_FILTER]: async (message) => getLostWorksByStatus(message),
  [C.MSG.ENSURE_IMPORT]: async (message) => ensureImport(message.username),
  [C.MSG.FIND_MISSING_ON_PAGE]: async ({ page } = {}) => {
    const username = await getMeta(C.META.USERNAME);
    if (!username) {
      return { success: false, error: "Visit your AO3 bookmarks page once so the extension knows your username." };
    }
    return importManager.findMissingOnPage(username, page);
  },
  [C.MSG.SNAPSHOT_BOOKMARKS]: async (message) => snapshotBookmarks(message),
  [C.MSG.GET_STATS]: async () => {
    await updateBadgeCount();
    return getStats();
  },
  [C.MSG.ACKNOWLEDGE_LOST]: async () => acknowledgeLostWorks(),
  [C.MSG.GET_SETTINGS]: async () => getSettings(),
  [C.MSG.RECHECK_LOST]: async () => {
    // Queue-only: deleted works stay deleted (no re-alerts) unless they load.
    const result = await checkManager.queueRecheck();
    if (result.success) {
      await updateBadgeCount();
      // Start checking now rather than at the next scheduled run, but only the
      // queued works (no extra routine checks); anything over one run's size
      // continues in the scheduled runs. Not awaited, so the popup gets its
      // answer straight away.
      if (result.reverifying > 0) {
        const queued = (await checkManager.getPending()).length;
        runCheckBatch({ maxChecks: queued }).catch(console.error);
      }
    }
    return result;
  },
  [C.MSG.DISMISS_OUTAGE_NOTICE]: async () => dismissOutageNotice()
};

runtime?.runtime?.onMessage?.addListener((message, sender, sendResponse) => {
  const handler = messageHandlers[message?.type];

  if (!handler) {
    if (String(message?.type || "").startsWith("IMPORT_")
      || String(message?.type || "").startsWith("CHECK_")
      || message?.type === C.MSG.STATS_UPDATED) {
      return false;
    }
    sendResponse({ success: false, error: `Unknown message type: ${message?.type || "missing"}` });
    return false;
  }

  handler(message, sender, eventBus)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
    });

  return true;
});

// Local midnight, Oct 29 2026: deletions confirmed before this are trusted.
const OUTAGE_2026_10_CUTOFF = new Date(2026, 9, 29).getTime();

// Oct 2026 AO3 outage: older versions counted server errors and maintenance
// pages as deletion strikes. On wake, count what the outage flagged. If there's
// nothing, the repair is marked done silently; otherwise the popup shows an
// informational notice until the user reads or dismisses it, and the repair
// itself runs after the first clean check run (repairOutageOnceHealthy).
async function prepareOutageNotice() {
  if (await getMeta(C.META.REPAIR_OUTAGE_REVERIFY)) return;
  if (await getMeta(C.META.OUTAGE_NOTICE)) return;
  const { flagged, restored } = await checkManager.previewRequeue({ since: OUTAGE_2026_10_CUTOFF });
  if (flagged + restored === 0) {
    await setMeta(C.META.REPAIR_OUTAGE_REVERIFY, Date.now());
    return;
  }
  await setMeta(C.META.OUTAGE_NOTICE, { flagged, restored, resolved: false, dismissed: false });
}

// Once AO3 answers normally again: re-verify everything flagged from the cutoff
// on, restore earlier deletions a v1.4.1 blanket re-check had reset, and clear
// the flagged works' notifications.
async function repairOutageOnceHealthy() {
  if (await getMeta(C.META.REPAIR_OUTAGE_REVERIFY)) return;
  const result = await checkManager.reverifyLost({ since: OUTAGE_2026_10_CUTOFF });
  if (!result.success) return;

  if (result.restored > 0) {
    // Restored works are old news; don't re-alert on them.
    const acknowledged = Number(await getMeta(C.META.LOST_ACKNOWLEDGED)) || 0;
    await setMeta(C.META.LOST_ACKNOWLEDGED, acknowledged + result.restored);
  }
  for (const workId of result.flaggedIds) {
    notificationsApi?.clear?.(`ao3-lost-and-found-${C.STATUS.DELETED}-${workId}`);
  }

  await setMeta(C.META.REPAIR_OUTAGE_REVERIFY, Date.now());
  const notice = await getMeta(C.META.OUTAGE_NOTICE);
  if (notice) {
    await setMeta(C.META.OUTAGE_NOTICE, { ...notice, resolved: true, cleared: result.flaggedIds.length, restored: result.restored });
  }
  await updateBadgeCount();
  broadcast({ type: C.MSG.STATS_UPDATED, stats: await getStats() });
}

async function dismissOutageNotice() {
  const notice = await getMeta(C.META.OUTAGE_NOTICE);
  if (notice) await setMeta(C.META.OUTAGE_NOTICE, { ...notice, dismissed: true });
  await updateBadgeCount();
  return { success: true };
}

// One-time (v1.5.0): earlier imports stored HTML codes literally, so titles
// read e.g. "Don&#39;t Go". Decode them in place. modify() rewrites only the
// text fields that change, inside one transaction, so it can't overwrite a
// check result being saved at the same moment.
async function decodeStoredEntitiesOnce() {
  if (await getMeta(C.META.REPAIR_DECODE_ENTITIES)) return;
  const { decodeRecordText } = globalThis.AO3LostAndFoundParser;
  await db.works.toCollection().modify((work) => {
    const changes = decodeRecordText(work);
    if (changes) Object.assign(work, changes);
  });
  await setMeta(C.META.REPAIR_DECODE_ENTITIES, Date.now());
}

async function runScheduledMaintenance(alarm) {
  // Resume any import an eviction left unfinished before anything else.
  await reconcileImport();

  // Sweep in any newly added bookmarks first (cheap — usually one request),
  // then run the deletion check over the up-to-date set.
  const username = await getMeta(C.META.USERNAME);
  const status = await getMeta(C.META.IMPORT_STATUS);
  if (username && status === C.IMPORT_STATE.COMPLETE) {
    const result = await importManager.syncRecent(username);
    if (result?.transient) {
      console.info("AO3 Lost and Found incremental sweep skipped transiently.", result.error || result.skipped);
    } else if (result && result.success === false && !result.skipped && !result.paused) {
      console.warn("AO3 Lost and Found incremental sweep did not complete.", result.error || result);
    }
  }

  const result = await runCheckBatch({ alarm });
  // A clean run means AO3 is answering normally again.
  if (result?.success) {
    await repairOutageOnceHealthy();
  }
}

// One check run, sized so a full pass over the library finishes in ~a day.
// Used by the schedule and to start a user's re-check right away (with
// `maxChecks` capping it lower); runBatch refuses to overlap a run already in
// progress.
async function runCheckBatch({ alarm, maxChecks } = {}) {
  const settings = await getSettings();
  const total = await db.works.count();
  let batchSize = globalThis.AO3LostAndFoundCheck.computeBatchSize(total, settings.checkFrequencyMinutes);
  if (Number(maxChecks) > 0) batchSize = Math.min(batchSize, Number(maxChecks));
  return checkManager.runBatch({ manual: false, alarm, batchSize });
}

alarmApi?.onAlarm?.addListener((alarm) => {
  if (alarm.name === C.ALARM_CHECK) {
    // Reschedule first (fresh jitter) so the next run is always queued.
    scheduleNextCheck().catch(console.error);
    runScheduledMaintenance(alarm).catch(console.error);
  }
});

actionApi?.setBadgeBackgroundColor?.({ color: BADGE_BG_COLOR });
getSettings().then(applySettings).catch(console.error);
prepareOutageNotice().catch(console.error);
decodeStoredEntitiesOnce().catch(console.error);
// Recover an import interrupted by a previous worker eviction.
reconcileImport().catch(console.error);

notificationsApi?.onClicked?.addListener((notificationId) => {
  if (!String(notificationId).startsWith("ao3-lost-and-found-")) return;

  getBookmarksUrl()
    .then((url) => runtime?.tabs?.create?.({ url }))
    .catch(console.error);
});

globalThis.ao3LostAndFound = {
  eventBus,
  checkManager,
  importManager,
  messageHandlers
};
