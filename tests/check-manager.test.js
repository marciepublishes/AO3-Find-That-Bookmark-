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

  test("the first clean run after an outage re-verifies deletions made since it began", async () => {
    const db = makeDb([
      { workId: "1", status: "active", checkFailCount: 0, dateBookmarked: "2026-05-01", authors: [] },
      { workId: "old", status: "deleted", checkFailCount: 3, deletedAt: 100, authors: [] },
      { workId: "during", status: "deleted", checkFailCount: 3, deletedAt: 900, authors: [] }
    ]);
    db._meta.set("check:outageStartedAt", 500);
    const manager = new CheckManager({
      bus: { emit: async () => {} },
      db,
      now: () => 2000,
      delayFn: async () => {},
      backoffDelayFn: async () => {},
      fetchFn: async (url) => ({ status: url.includes("/works/1") ? 200 : 404, url })
    });

    await manager.runBatch({ batchSize: 1 });

    expect(db._meta.get("check:outageStartedAt")).toBeNull();
    expect((await db.works.get("old")).status).toBe("deleted");
    expect((await db.works.get("during")).status).toBe("unconfirmed");
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
