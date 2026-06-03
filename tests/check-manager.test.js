const {
  CheckManager,
  applyStateTransition,
  computeBackoff,
  getPriorityScore,
  normalizeHeadResult
} = require("../modules/check-manager");

const baseWork = {
  workId: "123456",
  title: "Example Work",
  authors: ["ExampleAuthor"],
  status: "active",
  checkFailCount: 0,
  lastChecked: null,
  deletedAt: null,
  orphanedAt: null,
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
      deletedAt: null,
      orphanedAt: null
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

  test("third orphaned result confirms orphaned and pins to top", () => {
    const work = { ...baseWork, status: "unconfirmed", checkFailCount: 2 };
    const next = applyStateTransition(work, { statusCode: 200, ok: true, orphaned: true }, 1000);

    expect(next).toMatchObject({
      status: "orphaned",
      checkFailCount: 3,
      orphanedAt: 1000,
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

  test("normalizeHeadResult identifies deleted, restricted, and orphaned results", () => {
    expect(normalizeHeadResult({ status: 404 }, baseWork).deleted).toBe(true);
    expect(normalizeHeadResult({ status: 403 }, baseWork).restricted).toBe(true);
    expect(normalizeHeadResult({ status: 200, url: "https://archiveofourown.org/users/orphan_account" }, baseWork).orphaned).toBe(true);
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
