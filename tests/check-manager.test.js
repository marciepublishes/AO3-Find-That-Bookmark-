const {
  CheckManager,
  applyStateTransition,
  computeBackoff,
  computeBatchSize,
  getPriorityScore,
  isMaintenancePage,
  normalizeHeadResult
} = require("../modules/check-manager");

// Trimmed copy of the page AO3 served during the Oct 2026 outage.
const MAINTENANCE_HTML = `<!doctypehtml><html lang=en><title>Request temporarily denied. | Archive of Our Own</title>
<header><h1>Archive of Our Own</h1></header><main><h2>The archive is down for maintenance.</h2>
<p>Check our <a href=https://www.otwstatus.org >status page</a> for updates.</main>`;

// In-memory db with a meta map and a works map, enough to drive runBatch.
function makeDb(works = []) {
  const meta = new Map();
  const table = new Map(works.map((work) => [work.workId, { ...work }]));
  return {
    _meta: meta,
    _table: table,
    meta: {
      get: async (key) => (meta.has(key) ? { key, value: meta.get(key) } : undefined),
      put: async ({ key, value }) => { meta.set(key, value); }
    },
    works: {
      get: async (id) => (table.has(id) ? { ...table.get(id) } : undefined),
      put: async (work) => { table.set(work.workId, { ...work }); },
      toArray: async () => [...table.values()].map((work) => ({ ...work })),
      bulkPut: async (rows) => rows.forEach((work) => table.set(work.workId, { ...work })),
      count: async () => table.size
    }
  };
}

const HOUR = 60 * 60 * 1000;

const baseWork = {
  workId: "123456",
  title: "Example Work",
  authors: ["ExampleAuthor"],
  status: "active",
  checkFailCount: 0,
  lastChecked: null,
  deletedAt: null,
  pinnedToTop: false,
  notified: false,
  dateBookmarked: "2026-05-01"
};

describe("CheckManager state machine", () => {
  test("200 normal resets failures and marks active", () => {
    const work = { ...baseWork, status: "unconfirmed", checkFailCount: 2 };
    const next = applyStateTransition(work, { statusCode: 200, ok: true }, 1000);

    expect(next).toMatchObject({
      status: "active",
      checkFailCount: 0,
      lastChecked: 1000,
      deletedAt: null
    });
  });

  test("429 does not count as a check failure", () => {
    const work = { ...baseWork, checkFailCount: 2, lastChecked: 500 };
    const next = applyStateTransition(work, { statusCode: 429 }, 1000);

    expect(next.status).toBe("active");
    expect(next.checkFailCount).toBe(2);
    expect(next.lastChecked).toBe(500);
  });

  test("first 404 becomes unconfirmed", () => {
    const next = applyStateTransition(baseWork, { statusCode: 404, deleted: true }, 1000);

    expect(next).toMatchObject({
      status: "unconfirmed",
      checkFailCount: 1,
      pinnedToTop: false
    });
  });

  test("third 404 confirms deleted and pins to top once strikes span 12h", () => {
    const now = 13 * HOUR;
    const work = { ...baseWork, status: "unconfirmed", checkFailCount: 2, firstFailedAt: 0 };
    const next = applyStateTransition(work, { statusCode: 404, deleted: true }, now);

    expect(next).toMatchObject({
      status: "deleted",
      checkFailCount: 3,
      deletedAt: now,
      pinnedToTop: true,
      confirmedStatusChanged: true
    });
  });

  test("three quick 404s within an outage window do not confirm", () => {
    const work = { ...baseWork, status: "unconfirmed", checkFailCount: 2, firstFailedAt: 0 };
    const next = applyStateTransition(work, { statusCode: 404, deleted: true }, 2 * HOUR);

    expect(next.status).toBe("unconfirmed");
    expect(next.checkFailCount).toBe(3);
    expect(next.confirmedStatusChanged).toBe(false);
  });

  test.each([500, 502, 503, 504, 520, 522, 0])("%i is transient and never a strike", (statusCode) => {
    const work = { ...baseWork, status: "unconfirmed", checkFailCount: 2, firstFailedAt: 0, lastChecked: 500 };
    const next = applyStateTransition(work, normalizeHeadResult(statusCode ? { status: statusCode } : null), 20 * HOUR);

    expect(next.status).toBe("unconfirmed");
    expect(next.checkFailCount).toBe(2);
    expect(next.lastChecked).toBe(500);
  });

  test("a work that loads again clears strikes and its notified flag", () => {
    const work = { ...baseWork, status: "deleted", checkFailCount: 3, firstFailedAt: 0, notified: true };
    const next = applyStateTransition(work, { statusCode: 200, ok: true }, 1000);

    expect(next).toMatchObject({ status: "active", checkFailCount: 0, firstFailedAt: null, notified: false });
  });

  test("restricted responses are tracked separately without failure escalation", () => {
    const next = applyStateTransition(baseWork, { statusCode: 403, restricted: true }, 1000);

    expect(next).toMatchObject({
      status: "restricted",
      checkFailCount: 0,
      lastChecked: 1000
    });
  });
});

describe("CheckManager helpers", () => {
  test("computeBackoff returns 30s, 60s, and 120s", () => {
    expect([computeBackoff(1), computeBackoff(2), computeBackoff(3)]).toEqual([30000, 60000, 120000]);
  });

  test("getPriorityScore ranks recently bookmarked works higher than older works", () => {
    const now = Date.parse("2026-05-29T12:00:00Z");
    const recent = getPriorityScore({ ...baseWork, dateBookmarked: "2026-05-28" }, now);
    const old = getPriorityScore({ ...baseWork, dateBookmarked: "2020-01-01" }, now);

    expect(recent).toBeGreaterThan(old);
  });

  test("normalizeHeadResult identifies deleted and restricted results", () => {
    expect(normalizeHeadResult({ status: 404 }).deleted).toBe(true);
    expect(normalizeHeadResult({ status: 410 }).deleted).toBe(true);
    expect(normalizeHeadResult({ status: 403 }).restricted).toBe(true);
    expect(normalizeHeadResult({ status: 200 }).ok).toBe(true);
    expect(normalizeHeadResult({ status: 200 }).deleted).toBe(false);
  });

  test("computeBatchSize scales the daily budget with library size", () => {
    // 30-minute interval => 48 runs/day.
    expect(computeBatchSize(100, 30)).toBe(Math.ceil(150 / 48)); // floor budget 150
    expect(computeBatchSize(500, 30)).toBe(Math.ceil(500 / 48));
    expect(computeBatchSize(1000, 30)).toBe(Math.ceil(1000 / 48));
  });

  test("computeBatchSize clamps to the safe per-run range", () => {
    expect(computeBatchSize(0, 30)).toBeGreaterThanOrEqual(2);
    // A huge library is capped (budget ceiling 1500 / 48 = 32).
    expect(computeBatchSize(100000, 30)).toBe(32);
    expect(computeBatchSize(100000, 30)).toBeLessThanOrEqual(32);
  });

  test("confirmation fast-lane confirms a deleted work within three spaced runs", async () => {
    const db = makeDb([
      { workId: "1", status: "active", checkFailCount: 0, deletedAt: null, dateBookmarked: "2026-05-01", authors: [] },
      { workId: "2", status: "active", checkFailCount: 0, deletedAt: null, dateBookmarked: "2026-05-01", authors: [] }
    ]);
    const confirmed = [];
    const bus = {
      emit: async (type, payload) => {
        if (type === "checks:confirmed") confirmed.push(payload.work.workId);
      }
    };
    let clock = 0;
    const manager = new CheckManager({
      bus,
      db,
      now: () => clock,
      delayFn: async () => {},
      backoffDelayFn: async () => {},
      fetchFn: async (url) => ({ status: url.includes("/works/1") ? 404 : 200, url })
    });

    for (let run = 0; run < 3; run += 1) {
      await manager.runBatch({ batchSize: 10 });
      clock += 6 * HOUR;
    }

    const work1 = await db.works.get("1");
    expect(work1.status).toBe("deleted");
    expect(work1.checkFailCount).toBe(3);
    expect(confirmed).toContain("1");
    expect((await db.works.get("2")).status).toBe("active");
  });

  test("a work is checked at most once per run (strikes spaced across runs)", async () => {
    const calls = [];
    const db = makeDb([
      { workId: "1", status: "active", checkFailCount: 1, deletedAt: null, dateBookmarked: "2026-05-01", authors: [] }
    ]);
    // Seed the pending fast-lane so work 1 is also in the rebuilt main queue.
    db._meta.set("check:pending", ["1"]);
    const manager = new CheckManager({
      bus: { emit: async () => {} },
      db,
      delayFn: async () => {},
      backoffDelayFn: async () => {},
      fetchFn: async (url) => {
        if (!url.includes("/works/")) return { status: 200, url }; // healthy canary
        calls.push(url);
        return { status: 404, url };
      }
    });

    await manager.runBatch({ batchSize: 10 });

    expect(calls).toHaveLength(1); // not double-checked via both lanes
  });

  test("a site-wide outage (every request 404s) records no strikes", async () => {
    const db = makeDb([
      { workId: "1", status: "active", checkFailCount: 0, deletedAt: null, dateBookmarked: "2026-05-01", authors: [] },
      { workId: "2", status: "active", checkFailCount: 0, deletedAt: null, dateBookmarked: "2026-05-01", authors: [] }
    ]);
    db._meta.set("check:canary", "2");
    const manager = new CheckManager({
      bus: { emit: async () => {} },
      db,
      delayFn: async () => {},
      backoffDelayFn: async () => {},
      fetchFn: async (url) => ({ status: 404, url })
    });

    const result = await manager.runBatch({ batchSize: 10 });

    expect(result).toMatchObject({ success: false, outage: true });
    for (const id of ["1", "2"]) {
      const work = await db.works.get(id);
      expect(work.status).toBe("active");
      expect(work.checkFailCount).toBe(0);
    }
  });

  test("a run of server errors stops the run without touching any work", async () => {
    const calls = [];
    const works = ["1", "2", "3", "4", "5"].map((workId) => (
      { workId, status: "active", checkFailCount: 0, deletedAt: null, dateBookmarked: "2026-05-01", authors: [] }
    ));
    const db = makeDb(works);
    const manager = new CheckManager({
      bus: { emit: async () => {} },
      db,
      delayFn: async () => {},
      backoffDelayFn: async () => {},
      fetchFn: async (url) => { calls.push(url); return { status: 503, url }; }
    });

    const result = await manager.runBatch({ batchSize: 10 });

    expect(result.outage).toBe(true);
    expect(calls).toHaveLength(3);
    for (const work of works) {
      expect((await db.works.get(work.workId)).status).toBe("active");
    }
  });

  test("network failures are transient rather than thrown", async () => {
    const manager = new CheckManager({
      bus: { emit: jest.fn() },
      db: {},
      fetchFn: async () => { throw new TypeError("Failed to fetch"); }
    });

    expect(await manager.checkWork(baseWork)).toMatchObject({ statusCode: 0, transient: true });
  });

  test("reverifyLost sends deleted works back through confirmation", async () => {
    const db = makeDb([
      { workId: "1", status: "deleted", checkFailCount: 3, firstFailedAt: 0, notified: true, deletedAt: 5, authors: [] },
      { workId: "2", status: "unconfirmed", checkFailCount: 2, firstFailedAt: 0, authors: [] },
      { workId: "3", status: "active", checkFailCount: 0, authors: [] }
    ]);
    const manager = new CheckManager({ bus: { emit: async () => {} }, db });

    const result = await manager.reverifyLost();

    expect(result).toEqual({ success: true, reverifying: 2, restored: 0, flaggedIds: ["1"] });
    expect(await db.works.get("1")).toMatchObject({ status: "unconfirmed", checkFailCount: 0, notified: true });
    expect(await db.works.get("2")).toMatchObject({ status: "unconfirmed", checkFailCount: 0 });
    expect((await db.works.get("3")).status).toBe("active");
    expect(db._meta.get("check:pending").sort()).toEqual(["1", "2"]);
  });

  test("isMaintenancePage recognizes AO3's maintenance page", () => {
    expect(isMaintenancePage(MAINTENANCE_HTML)).toBe(true);
    expect(isMaintenancePage("<title>Some Fic - Archive of Our Own</title>")).toBe(false);
  });

  test("a maintenance page served as 200 cannot flip a deleted work back to active", async () => {
    const db = makeDb([
      { workId: "1", status: "deleted", checkFailCount: 3, deletedAt: 5, notified: true, dateBookmarked: "2026-05-01", authors: [] }
    ]);
    const manager = new CheckManager({
      bus: { emit: async () => {} },
      db,
      delayFn: async () => {},
      backoffDelayFn: async () => {},
      fetchFn: async (url) => ({ status: 200, url, text: async () => MAINTENANCE_HTML })
    });

    const result = await manager.runBatch({ batchSize: 10 });

    expect(result.outage).toBe(true);
    expect(await db.works.get("1")).toMatchObject({ status: "deleted", notified: true });
  });

  test("reverifyLost with `since` leaves older deletions alone", async () => {
    const cutoff = 1000;
    const db = makeDb([
      { workId: "old", status: "deleted", checkFailCount: 3, deletedAt: 500, authors: [] },
      { workId: "new", status: "deleted", checkFailCount: 3, deletedAt: 1500, authors: [] },
      // Confirmed before the cutoff, then reset by v1.4.1's blanket re-check.
      { workId: "reset", status: "unconfirmed", checkFailCount: 0, deletedAt: 400, authors: [] },
      { workId: "striking", status: "unconfirmed", checkFailCount: 2, deletedAt: null, authors: [] }
    ]);
    db._meta.set("check:pending", ["reset"]);
    const manager = new CheckManager({ bus: { emit: async () => {} }, db });

    // The preview the popup notice is built from matches, and writes nothing.
    expect(await manager.previewRequeue({ since: cutoff })).toEqual({ reverifying: 2, restored: 1, flagged: 1 });
    expect((await db.works.get("new")).status).toBe("deleted");

    const result = await manager.reverifyLost({ since: cutoff });

    expect(result).toEqual({ success: true, reverifying: 2, restored: 1, flaggedIds: ["new"] });
    expect(await db.works.get("old")).toMatchObject({ status: "deleted", checkFailCount: 3 });
    expect(await db.works.get("reset")).toMatchObject({ status: "deleted", checkFailCount: 3, deletedAt: 400 });
    expect(await db.works.get("new")).toMatchObject({ status: "unconfirmed", checkFailCount: 0 });
    expect(await db.works.get("striking")).toMatchObject({ status: "unconfirmed", checkFailCount: 0 });
    expect(db._meta.get("check:pending").sort()).toEqual(["new", "striking"]);
  });

  test("checkWork uses HEAD requests only", async () => {
    const calls = [];
    const manager = new CheckManager({
      bus: { emit: jest.fn() },
      db: {},
      fetchFn: async (url, options) => {
        calls.push({ url, options });
        return { status: 200, url };
      }
    });

    await manager.checkWork(baseWork);
    expect(calls).toHaveLength(1);
    expect(calls[0].options.method).toBe("HEAD");
  });
});

describe("v1.5.0 phase 1: re-checks never reset or resurrect deletions", () => {
  const quietManager = (db, fetchFn, extra = {}) => new CheckManager({
    bus: { emit: async () => {} },
    db,
    delayFn: async () => {},
    backoffDelayFn: async () => {},
    fetchFn,
    ...extra
  });

  test("queueRecheck keeps deleted works deleted and only queues them", async () => {
    const db = makeDb([
      { workId: "old", status: "deleted", checkFailCount: 3, deletedAt: 5, notified: true, authors: [] },
      { workId: "live", status: "active", checkFailCount: 0, authors: [] }
    ]);
    const manager = quietManager(db, async () => ({ status: 200 }));

    const result = await manager.queueRecheck();

    expect(result).toEqual({ success: true, reverifying: 1 });
    expect(await db.works.get("old")).toMatchObject({ status: "deleted", checkFailCount: 3, deletedAt: 5, notified: true });
    expect(db._meta.get("check:pending")).toEqual(["old"]);
  });

  test("a queued real deletion stays deleted without a new confirmation event", async () => {
    const db = makeDb([
      { workId: "old", status: "deleted", checkFailCount: 3, deletedAt: 5, notified: true, dateBookmarked: "2026-05-01", authors: [] }
    ]);
    const events = [];
    const manager = new CheckManager({
      bus: { emit: async (type) => { events.push(type); } },
      db,
      delayFn: async () => {},
      backoffDelayFn: async () => {},
      fetchFn: async (url) => ({ status: url.includes("/works/old") ? 404 : 200, url })
    });

    await manager.queueRecheck();
    await manager.runBatch({ batchSize: 5 });

    expect((await db.works.get("old")).status).toBe("deleted");
    expect(events).not.toContain("checks:confirmed");
    expect(db._meta.get("check:pending")).toEqual([]);
  });

  test("a queued false alarm that loads again goes back to active", async () => {
    const db = makeDb([
      { workId: "fine", status: "deleted", checkFailCount: 3, deletedAt: 5, notified: true, dateBookmarked: "2026-05-01", authors: [] }
    ]);
    const manager = quietManager(db, async (url) => ({ status: 200, url }));

    await manager.queueRecheck();
    await manager.runBatch({ batchSize: 5 });

    expect(await db.works.get("fine")).toMatchObject({ status: "active", deletedAt: null });
  });

  test("queueRecheck with since only queues deletions from then on", async () => {
    const db = makeDb([
      { workId: "before", status: "deleted", deletedAt: 500, authors: [] },
      { workId: "after", status: "deleted", deletedAt: 1500, authors: [] }
    ]);
    const manager = quietManager(db, async () => ({ status: 200 }));

    expect(await manager.queueRecheck({ since: 1000 })).toEqual({ success: true, reverifying: 1 });
    expect(db._meta.get("check:pending")).toEqual(["after"]);
  });

  test("the end of a later outage never turns an Oct 29-reset work back to deleted", async () => {
    const oct29 = Date.parse("2026-10-29T12:00:00Z");
    const dec1 = Date.parse("2026-12-01T00:00:00Z");
    const db = makeDb([
      { workId: "1", status: "active", checkFailCount: 0, dateBookmarked: "2026-05-01", authors: [] },
      // Reset by the Oct 29 repair: unconfirmed, no strikes, old deletedAt kept.
      { workId: "7", status: "unconfirmed", checkFailCount: 0, firstFailedAt: null, deletedAt: oct29, authors: [] }
    ]);
    db._meta.set("check:outageStartedAt", dec1);
    db._meta.set("check:queue", ["1"]);
    db._meta.set("check:pending", []);
    const manager = quietManager(db, async (url) => ({ status: 200, url }), { now: () => dec1 + 1000 });

    const result = await manager.runBatch({ batchSize: 1 });

    expect(result.success).toBe(true);
    expect((await db.works.get("7")).status).toBe("unconfirmed");
  });

  test("after an outage, deletions from during it are queued, not reset", async () => {
    const db = makeDb([
      { workId: "1", status: "active", checkFailCount: 0, dateBookmarked: "2026-05-01", authors: [] },
      { workId: "old", status: "deleted", checkFailCount: 3, deletedAt: 100, authors: [] },
      { workId: "during", status: "deleted", checkFailCount: 3, deletedAt: 900, authors: [] }
    ]);
    db._meta.set("check:outageStartedAt", 500);
    db._meta.set("check:queue", ["1"]);
    const manager = quietManager(db, async (url) => ({ status: 200, url }), { now: () => 2000 });

    await manager.runBatch({ batchSize: 1 });

    expect(db._meta.get("check:outageStartedAt")).toBeNull();
    expect((await db.works.get("old")).status).toBe("deleted");
    expect((await db.works.get("during")).status).toBe("deleted");
    expect(db._meta.get("check:pending")).toEqual(["during"]);
  });

  test("after an outage, strikes gathered during it are cleared", async () => {
    const db = makeDb([
      { workId: "1", status: "active", checkFailCount: 0, dateBookmarked: "2026-05-01", authors: [] },
      { workId: "during", status: "unconfirmed", checkFailCount: 2, firstFailedAt: 900, authors: [] },
      { workId: "before", status: "unconfirmed", checkFailCount: 2, firstFailedAt: 100, authors: [] }
    ]);
    db._meta.set("check:outageStartedAt", 500);
    db._meta.set("check:queue", ["1"]);
    const manager = quietManager(db, async (url) => ({ status: 200, url }), { now: () => 2000 });

    await manager.runBatch({ batchSize: 1 });

    expect(await db.works.get("during")).toMatchObject({ status: "unconfirmed", checkFailCount: 0, firstFailedAt: null });
    expect(await db.works.get("before")).toMatchObject({ status: "unconfirmed", checkFailCount: 2, firstFailedAt: 100 });
    expect(db._meta.get("check:pending")).toContain("during");
  });
});

describe("v1.5.0 phase 1: live verification and Cloudflare challenges", () => {
  const challenge = (status = 403) => ({
    status,
    headers: { get: (name) => (String(name).toLowerCase() === "cf-mitigated" ? "challenge" : null) }
  });

  test("a Cloudflare challenge is transient, not restricted", () => {
    expect(normalizeHeadResult(challenge())).toMatchObject({ transient: true, restricted: false, deleted: false, ok: false });
  });

  test("a plain 403 without the challenge header is still restricted", () => {
    expect(normalizeHeadResult({ status: 403, headers: { get: () => null } })).toMatchObject({ restricted: true, transient: false });
  });

  test("a challenged health check reports AO3 as unhealthy", async () => {
    const manager = new CheckManager({
      bus: { emit: async () => {} },
      db: makeDb([]),
      delayFn: async () => {},
      fetchFn: async () => challenge(200)
    });
    expect(await manager.isArchiveHealthy("x")).toBe(false);
  });

  test("a Cloudflare challenge does not relabel a work as restricted", async () => {
    const db = makeDb([{ workId: "1", status: "unconfirmed", checkFailCount: 2, firstFailedAt: 0, dateBookmarked: "2026-05-01", authors: [] }]);
    const manager = new CheckManager({
      bus: { emit: async () => {} },
      db,
      delayFn: async () => {},
      backoffDelayFn: async () => {},
      fetchFn: async () => challenge()
    });

    await manager.runBatch({ batchSize: 5 });

    expect(await db.works.get("1")).toMatchObject({ status: "unconfirmed", checkFailCount: 2 });
  });

  test("verifyDeleted needs a 404 and a healthy archive", async () => {
    const work = { workId: "9" };
    const make = (fetchFn) => new CheckManager({ bus: null, db: makeDb([]), delayFn: async () => {}, fetchFn });

    expect(await make(async (url) => ({ status: url.includes("/works/9") ? 404 : 200, url })).verifyDeleted(work)).toBe(true);
    expect(await make(async (url) => ({ status: 200, url })).verifyDeleted(work)).toBe(false);
    expect(await make(async (url) => (url.includes("/works/9")
      ? { status: 404, url }
      : { status: 200, url, text: async () => MAINTENANCE_HTML })).verifyDeleted(work)).toBe(false);
    expect(await make(async () => { throw new TypeError("offline"); }).verifyDeleted(work)).toBe(false);
  });
});

describe("re-check status survives closing the popup", () => {
  const DAY = 24 * HOUR;
  const managerFor = (db, fetchFn, extra = {}) => new CheckManager({
    bus: { emit: async () => {} },
    db,
    delayFn: async () => {},
    backoffDelayFn: async () => {},
    fetchFn,
    ...extra
  });
  const deletedWork = (workId) => ({ workId, status: "deleted", checkFailCount: 3, deletedAt: 5, notified: true, dateBookmarked: "2026-05-01", authors: [] });

  test("queueRecheck records the queued works; a second call merges into the same re-check", async () => {
    const db = makeDb([deletedWork("a"), deletedWork("b")]);
    let clock = 100;
    const manager = managerFor(db, async () => ({ status: 200 }), { now: () => clock });

    await manager.queueRecheck();
    expect(db._meta.get("check:recheck")).toEqual({ ids: ["a", "b"], total: 2, startedAt: 100 });

    await db.works.put(deletedWork("c"));
    clock = 200;
    await manager.queueRecheck();
    expect(db._meta.get("check:recheck")).toEqual({ ids: ["a", "b", "c"], total: 3, startedAt: 100 });
    expect(await manager.getRecheckStatus()).toEqual({ remaining: 3, total: 3, startedAt: 100 });
  });

  test("nothing to re-check records no status", async () => {
    const db = makeDb([{ workId: "1", status: "active", authors: [] }]);
    const manager = managerFor(db, async () => ({ status: 200 }));

    await manager.queueRecheck();

    expect(db._meta.get("check:recheck")).toBeUndefined();
    expect(await manager.getRecheckStatus()).toBeNull();
  });

  test("works come off the status as they are checked, and it clears when the last one is done", async () => {
    const db = makeDb([deletedWork("fine"), deletedWork("gone")]);
    const manager = managerFor(db, async (url) => ({ status: url.includes("/works/gone") ? 404 : 200, url }));

    await manager.queueRecheck();
    await manager.runBatch({ batchSize: 1 });
    expect(await manager.getRecheckStatus()).toMatchObject({ remaining: 1, total: 2 });

    await manager.runBatch({ batchSize: 1 });
    expect(await manager.getRecheckStatus()).toBeNull();
    expect(db._meta.get("check:recheck")).toBeNull();
  });

  test("a transient error leaves the work on the status", async () => {
    const db = makeDb([deletedWork("a")]);
    const manager = managerFor(db, async (url) => ({ status: 503, url }));

    await manager.queueRecheck();
    await manager.runBatch({ batchSize: 1 });

    expect(await manager.getRecheckStatus()).toMatchObject({ remaining: 1 });
  });

  test("rate limiting leaves the work on the status", async () => {
    const db = makeDb([deletedWork("a")]);
    const manager = managerFor(db, async (url) => ({ status: 429, url }));

    await manager.queueRecheck();
    await manager.runBatch({ batchSize: 1 });

    expect(await manager.getRecheckStatus()).toMatchObject({ remaining: 1 });
  });

  test("an unhealthy archive leaves the work on the status", async () => {
    const db = makeDb([deletedWork("a")]);
    // The work loads, but the health check gets AO3's maintenance page.
    const manager = managerFor(db, async (url) => ({ status: 200, url, text: async () => MAINTENANCE_HTML }));

    await manager.queueRecheck();
    await manager.runBatch({ batchSize: 1 });

    expect((await db.works.get("a")).status).toBe("deleted");
    expect(await manager.getRecheckStatus()).toMatchObject({ remaining: 1 });
  });

  test("the automatic post-outage re-check stays silent", async () => {
    const db = makeDb([
      { workId: "1", status: "active", checkFailCount: 0, dateBookmarked: "2026-05-01", authors: [] },
      { workId: "during", status: "deleted", checkFailCount: 3, deletedAt: 900, authors: [] }
    ]);
    db._meta.set("check:outageStartedAt", 500);
    db._meta.set("check:queue", ["1"]);
    const manager = managerFor(db, async (url) => ({ status: 200, url }), { now: () => 2000 });

    await manager.runBatch({ batchSize: 1 });

    expect(db._meta.get("check:pending")).toEqual(["during"]);
    expect(db._meta.get("check:recheck")).toBeUndefined();
  });

  test("a status older than 7 days is treated as finished and cleared", async () => {
    const db = makeDb([]);
    db._meta.set("check:recheck", { ids: ["x"], total: 1, startedAt: 0 });
    const manager = managerFor(db, async () => ({ status: 200 }), { now: () => 8 * DAY });

    expect(await manager.getRecheckStatus()).toBeNull();
    expect(db._meta.get("check:recheck")).toBeNull();
  });
});
