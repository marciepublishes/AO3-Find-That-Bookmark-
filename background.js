if (typeof importScripts === "function" && !globalThis.AO3LostAndFoundDB) {
  importScripts("lib/dexie.min.js");
  importScripts("modules/constants.js");
  importScripts("modules/db.js");
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
  db
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
  checkFrequencyMinutes: 720,
  autoCheckEnabled: true,
  deletedColor: "#e089a0",
  orphanedColor: "#9d89e0"
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

async function getStats() {
  const [total, active, deleted, orphaned, lastChecked] = await Promise.all([
    db.works.count(),
    countByStatus(C.STATUS.ACTIVE),
    countByStatus(C.STATUS.DELETED),
    countByStatus(C.STATUS.ORPHANED),
    db.works.orderBy("lastChecked").last()
  ]);

  const lost = deleted + orphaned;
  let acknowledged = Number(await getMeta(C.META.LOST_ACKNOWLEDGED)) || 0;
  if (acknowledged > lost) {
    // A previously-lost work came back; keep the baseline in step.
    acknowledged = lost;
    await setMeta(C.META.LOST_ACKNOWLEDGED, acknowledged);
  }
  const newLost = Math.max(0, lost - acknowledged);

  return {
    total,
    active,
    deleted,
    orphaned,
    lost,
    newLost,
    lastChecked: lastChecked?.lastChecked ?? null,
    username: await getMeta(C.META.USERNAME),
    importStatus: await getMeta(C.META.IMPORT_STATUS),
    importLastCompletedPage: await getMeta(C.META.LAST_COMPLETED_PAGE),
    importEstimatedTotalPages: await getMeta(C.META.ESTIMATED_TOTAL_PAGES)
  };
}

async function acknowledgeLostWorks() {
  await setMeta(C.META.LOST_ACKNOWLEDGED, await getLostWorkCount());
  return { success: true, stats: await getStats() };
}

async function getLostWorkCount() {
  const [deleted, orphaned] = await Promise.all([
    countByStatus(C.STATUS.DELETED),
    countByStatus(C.STATUS.ORPHANED)
  ]);
  return deleted + orphaned;
}

const BADGE_BG_COLOR = "#EC1F32";
const BADGE_TEXT_COLOR = "#FFFFFF";

async function updateBadgeCount() {
  const count = await getLostWorkCount();
  await actionApi?.setBadgeBackgroundColor?.({ color: BADGE_BG_COLOR });
  await actionApi?.setBadgeTextColor?.({ color: BADGE_TEXT_COLOR });
  await actionApi?.setBadgeText?.({ text: count > 0 ? String(count) : "" });
  await actionApi?.setTitle?.({
    title: count > 0
      ? `AO3 Find That Bookmark! — ${count} bookmarked work${count === 1 ? "" : "s"} may be deleted or orphaned. Click to investigate.`
      : "AO3 Find That Bookmark!"
  });
  return count;
}

async function getBookmarksUrl() {
  const username = await getMeta(C.META.USERNAME);
  return username
    ? `https://archiveofourown.org/users/${encodeURIComponent(username)}/bookmarks`
    : "https://archiveofourown.org/users/login";
}

async function fireLostWorkNotification(work) {
  if (work.notified) return;

  const status = work.status === C.STATUS.ORPHANED ? C.STATUS.ORPHANED : C.STATUS.DELETED;
  const author = Array.isArray(work.authors) && work.authors.length > 0
    ? work.authors.join(", ")
    : "Unknown author";
  const title = status === C.STATUS.ORPHANED ? "Orphaned Work Detected" : "Lost Work Detected";
  const message = status === C.STATUS.ORPHANED
    ? `${work.title} by ${author} has been orphaned on AO3.`
    : `${work.title} by ${author} has been deleted from AO3.`;

  await db.works.update(work.workId, { notified: true });
  notificationsApi?.create?.(`ao3-lost-and-found-${status}-${work.workId}`, {
    type: "basic",
    iconUrl: "icons/icon-128.png",
    title,
    message
  });
}

async function getDeletedWorksForPage({ workIds = [], pageNumber = 1, pageSize = 20 }) {
  const idSet = new Set(Array.isArray(workIds) ? workIds.map(String) : []);
  const page = Math.max(1, Number(pageNumber) || 1);
  const size = Math.max(1, Number(pageSize) || 20);
  const firstPosition = (page - 1) * size + 1;
  const lastPosition = page * size;

  const [deleted, orphaned] = await Promise.all([
    db.works.where("status").equals(C.STATUS.DELETED).toArray(),
    db.works.where("status").equals(C.STATUS.ORPHANED).toArray()
  ]);

  return [...deleted, ...orphaned]
    .filter((work) => {
      if (idSet.has(String(work.workId))) return true;
      if (work.pinnedToTop) return true;
      const position = Number(work.originalPosition) || 0;
      return position >= firstPosition && position <= lastPosition;
    })
    .sort((left, right) => {
      if (left.pinnedToTop !== right.pinnedToTop) {
        return left.pinnedToTop ? -1 : 1;
      }
      return (Number(left.originalPosition) || 0) - (Number(right.originalPosition) || 0);
    });
}

async function getLostWorksByStatus({ status, pageNumber = 1, pageSize = 20 }) {
  if (status !== C.STATUS.DELETED && status !== C.STATUS.ORPHANED) {
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
  await scheduleNextCheck(settings);
  await updateBadgeCount();
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
async function snapshotBookmarks({ blurbs = [], username } = {}) {
  const parse = globalThis.AO3LostAndFoundImport.parseBookmarkBlurb;
  const records = [];
  for (const item of Array.isArray(blurbs) ? blurbs : []) {
    const record = parse(item?.html, { originalPosition: Number(item?.position) || 1 });
    if (record) records.push(record);
  }

  if (records.length > 0) {
    await importManager.writeChunk(records);
  }

  const name = String(username || "").trim();
  if (name && !(await getMeta(C.META.USERNAME))) {
    await setMeta(C.META.USERNAME, name);
  }

  await updateBadgeCount();
  return { success: true, captured: records.length };
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
  [C.MSG.GET_DELETED_WORKS]: async (message) => ({ works: await getDeletedWorksForPage(message) }),
  [C.MSG.GET_LOST_WORKS_FILTER]: async (message) => getLostWorksByStatus(message),
  [C.MSG.SET_PINNED_TOP]: async ({ workId, value }) => {
    if (!workId || typeof value !== "boolean") {
      return { success: false, error: "workId and boolean value are required." };
    }

    await db.works.update(String(workId), { pinnedToTop: value });
    return { success: true };
  },
  [C.MSG.ENSURE_IMPORT]: async (message) => ensureImport(message.username),
  [C.MSG.SNAPSHOT_BOOKMARKS]: async (message) => snapshotBookmarks(message),
  [C.MSG.GET_STATS]: async () => {
    await updateBadgeCount();
    return getStats();
  },
  [C.MSG.ACKNOWLEDGE_LOST]: async () => acknowledgeLostWorks(),
  [C.MSG.GET_SETTINGS]: async () => getSettings()
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

async function runScheduledMaintenance(alarm) {
  // Resume any import an eviction left unfinished before anything else.
  await reconcileImport();

  // Sweep in any newly added bookmarks first (cheap — usually one request),
  // then run the deletion/orphan check over the up-to-date set.
  const username = await getMeta(C.META.USERNAME);
  const status = await getMeta(C.META.IMPORT_STATUS);
  if (username && status === C.IMPORT_STATE.COMPLETE) {
    try {
      await importManager.syncRecent(username);
    } catch (error) {
      console.error("AO3 Lost and Found incremental sweep failed.", error);
    }
  }
  await checkManager.runBatch({ manual: false, alarm });
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
