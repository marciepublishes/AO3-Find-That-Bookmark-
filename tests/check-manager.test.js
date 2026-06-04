const {
  CheckManager,
  applyStateTransition,
  computeBackoff,
  computeBatchSize,
  getPriorityScore,
  normalizeHeadResult
} = require("../modules/check-manager");

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

  test("third 404 confirms deleted and pins to top", () => {
    const work = { ...baseWork, status: "unconfirmed", checkFailCount: 2 };
    const next = applyStateTransition(work, { statusCode: 404, deleted: true }, 1000);

    expect(next).toMatchObject({
      status: "deleted",
      checkFailCount: 3,
      deletedAt: 1000,
      pinnedToTop: true,
      confirmedStatusChanged: true
    });
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

  test("confirmation fast-lane confirms a deleted work within three runs", async () => {
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
    const manager = new CheckManager({
      bus,
      db,
      delayFn: async () => {},
      backoffDelayFn: async () => {},
      fetchFn: async (url) => ({ status: url.includes("/works/1") ? 404 : 200, url })
    });

    for (let run = 0; run < 3; run += 1) {
      await manager.runBatch({ batchSize: 10 });
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
      fetchFn: async (url) => { calls.push(url); return { status: 404, url }; }
    });

    await manager.runBatch({ batchSize: 10 });

    expect(calls).toHaveLength(1); // not double-checked via both lanes
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
