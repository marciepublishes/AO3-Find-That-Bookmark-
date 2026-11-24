// Loads the real background.js (the worker that wires everything together)
// against an in-memory database and fake browser APIs.

require("../modules/constants");
require("../modules/bookmark-parser");
require("../modules/import-manager");
require("../modules/check-manager");

const C = globalThis.AO3LostAndFoundConstants;

function fakeDb(works = [], meta = {}) {
  const rows = new Map(works.map((work) => [String(work.workId), { ...work }]));
  const metaRows = new Map(Object.entries(meta));
  const all = () => [...rows.values()].map((work) => ({ ...work }));
  return {
    rows,
    metaRows,
    meta: {
      get: async (key) => (metaRows.has(key) ? { key, value: metaRows.get(key) } : undefined),
      put: async ({ key, value }) => { metaRows.set(key, value); }
    },
    works: {
      get: async (id) => (rows.has(String(id)) ? { ...rows.get(String(id)) } : undefined),
      put: async (work) => { rows.set(String(work.workId), { ...work }); },
      update: async (id, changes) => { if (rows.has(String(id))) Object.assign(rows.get(String(id)), changes); },
      bulkGet: async (ids) => ids.map((id) => (rows.has(String(id)) ? { ...rows.get(String(id)) } : undefined)),
      bulkPut: async (list) => list.forEach((work) => rows.set(String(work.workId), { ...work })),
      toArray: async () => all(),
      count: async () => rows.size,
      where: (field) => ({
        equals: (value) => ({
          count: async () => all().filter((work) => work[field] === value).length,
          toArray: async () => all().filter((work) => work[field] === value)
        })
      }),
      orderBy: (field) => ({
        last: async () => all().sort((a, b) => (a[field] || 0) - (b[field] || 0)).pop()
      }),
      toCollection: () => ({
        modify: async (fn) => { for (const work of rows.values()) fn(work); }
      })
    }
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

async function loadBackground({ works = [], meta = {}, existingAlarm = null, fetchFn } = {}) {
  const db = fakeDb(works, meta);
  const alarms = new Map(existingAlarm ? [[C.ALARM_CHECK, existingAlarm]] : []);
  const created = [];
  let onMessage;
  let onAlarm;
  const fetched = [];

  globalThis.AO3LostAndFoundDB = { initDatabase: () => db };
  globalThis.fetch = async (url, options) => {
    fetched.push(String(url));
    return fetchFn ? fetchFn(String(url), options) : { status: 200, url };
  };
  globalThis.chrome = {
    runtime: {
      onMessage: { addListener: (fn) => { onMessage = fn; } },
      sendMessage: async () => {}
    },
    alarms: {
      get: async (name) => alarms.get(name),
      create: (name, info) => { created.push({ name, info }); alarms.set(name, { name, ...info }); },
      clear: async (name) => alarms.delete(name),
      onAlarm: { addListener: (fn) => { onAlarm = fn; } }
    },
    action: {
      setBadgeBackgroundColor: async () => {},
      setBadgeTextColor: async () => {},
      setBadgeText: async () => {},
      setTitle: async () => {}
    },
    notifications: { create: () => {}, clear: () => {}, onClicked: { addListener: () => {} } },
    tabs: { create: () => {} }
  };

  jest.isolateModules(() => require("../background.js"));
  // No real 3-6s pauses between requests in tests.
  globalThis.ao3LostAndFound.checkManager.delayFn = async () => {};
  globalThis.ao3LostAndFound.checkManager.backoffDelayFn = async () => {};
  await settle();

  const send = (message) => new Promise((resolve) => {
    const async = onMessage(message, {}, resolve);
    if (!async) resolve(undefined);
  });

  return { db, created, fetched, send, fireAlarm: (name = C.ALARM_CHECK) => onAlarm({ name }) };
}

afterEach(() => {
  delete globalThis.chrome;
  delete globalThis.fetch;
  delete globalThis.AO3LostAndFoundDB;
  delete globalThis.ao3LostAndFound;
});

describe("check scheduling across worker restarts", () => {
  test("a fresh start with no alarm schedules one", async () => {
    const { created } = await loadBackground();
    expect(created).toHaveLength(1);
    expect(created[0].name).toBe(C.ALARM_CHECK);
  });

  test("a restart keeps the alarm already counting down instead of pushing it back", async () => {
    const { created } = await loadBackground({ existingAlarm: { scheduledTime: Date.now() + 60000 } });
    expect(created).toHaveLength(0);
  });

  test("when the alarm fires, the next check is scheduled", async () => {
    const { created, fireAlarm } = await loadBackground({ existingAlarm: { scheduledTime: Date.now() } });
    fireAlarm();
    await settle();
    expect(created).toHaveLength(1);
  });
});

describe("re-check starts right away", () => {
  const deleted = (workId) => ({ workId, status: "deleted", checkFailCount: 3, deletedAt: 5, notified: true, dateBookmarked: "2026-05-01", authors: [] });
  const active = (workId) => ({ workId, status: "active", checkFailCount: 0, dateBookmarked: "2026-05-01", authors: [] });

  test("checks the queued work immediately and clears the status, without routine checks", async () => {
    const { db, fetched, send } = await loadBackground({ works: [deleted("a"), active("b"), active("c")] });

    const response = await send({ type: C.MSG.RECHECK_LOST });
    await settle();

    expect(response).toMatchObject({ success: true, reverifying: 1 });
    expect(db.rows.get("a").status).toBe("active");
    expect(fetched.filter((url) => /\/works\/(b|c)$/.test(url))).toEqual([]);
    expect((await send({ type: C.MSG.GET_STATS })).recheck).toBeNull();
  });

  test("a real deletion stays deleted after the immediate check", async () => {
    const { db, send } = await loadBackground({
      works: [deleted("a")],
      fetchFn: async (url) => ({ status: url.includes("/works/a") ? 404 : 200, url })
    });

    await send({ type: C.MSG.RECHECK_LOST });
    await settle();

    expect(db.rows.get("a").status).toBe("deleted");
    expect((await send({ type: C.MSG.GET_STATS })).recheck).toBeNull();
  });

  test("nothing to re-check makes no requests", async () => {
    const { fetched, send } = await loadBackground({ works: [active("b")] });

    expect(await send({ type: C.MSG.RECHECK_LOST })).toMatchObject({ success: true, reverifying: 0 });
    await settle();

    expect(fetched).toEqual([]);
  });
});

describe("one-time repairs on startup", () => {
  test("stored HTML codes are decoded once", async () => {
    const { db } = await loadBackground({
      works: [{ workId: "1", status: "active", title: "Don&#39;t Go", authors: ["A&#39;s"] }]
    });

    expect(db.rows.get("1")).toMatchObject({ title: "Don't Go", authors: ["A's"] });
    expect(db.metaRows.get(C.META.REPAIR_DECODE_ENTITIES)).toEqual(expect.any(Number));
  });
});
