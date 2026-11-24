const {
  decodeHtml,
  decodeRecordText,
  parseBookmarkBlurb
} = require("../modules/bookmark-parser");
const { ImportManager } = require("../modules/import-manager");
const { positionOnPage } = require("../modules/injection-manager");

const loggedIn = '<div id="user-menu"></div>';

describe("HTML entity decoding", () => {
  test("decodes AO3's numeric apostrophe and other numeric codes in the worker parse path", () => {
    const work = parseBookmarkBlurb(
      `<li class="bookmark blurb"><h4 class="heading"><a href="/works/1">Don&#39;t Go &#8212; Please</a></h4></li>`
    );
    expect(work.title).toBe("Don't Go — Please");
  });

  test("decodes hex codes and common named entities", () => {
    expect(decodeHtml("caf&#xE9; &hellip; &ldquo;hi&rdquo; &lsquo;x&rsquo; a&ndash;b a&mdash;b")).toBe(
      "café … “hi” ‘x’ a–b a—b"
    );
    expect(decodeHtml("a&nbsp;b")).toBe("a b");
  });

  test("decodes a single level only", () => {
    expect(decodeHtml("&amp;#39;")).toBe("&#39;");
  });

  test("leaves invalid or unknown codes untouched", () => {
    expect(decodeHtml("&#0; &#xD800; &#99999999; &bogus;")).toBe("&#0; &#xD800; &#99999999; &bogus;");
  });

  test("decodeRecordText fixes stored text fields and lists, and reports no change when clean", () => {
    const changes = decodeRecordText({
      workId: "1",
      title: "Don&#39;t",
      authors: ["A&#39;s", "B"],
      summary: "fine",
      status: "deleted"
    });
    expect(changes).toEqual({ title: "Don't", authors: ["A's", "B"] });
    expect(decodeRecordText({ workId: "2", title: "Clean", authors: ["A"] })).toBeNull();
  });
});

function memoryDb(seed = []) {
  const rows = new Map(seed.map((row) => [String(row.workId), { ...row }]));
  const meta = new Map();
  return {
    rows,
    meta: {
      get: async (key) => (meta.has(key) ? { key, value: meta.get(key) } : undefined),
      put: async ({ key, value }) => { meta.set(key, value); }
    },
    works: {
      get: async (id) => rows.get(String(id)),
      bulkGet: async (ids) => ids.map((id) => rows.get(String(id))),
      bulkPut: async (records) => records.forEach((record) => rows.set(String(record.workId), { ...record })),
      count: async () => rows.size,
      toArray: async () => [...rows.values()]
    }
  };
}

describe("writeChunk keeps check state", () => {
  test("re-capturing a work mid-confirmation keeps its first strike time", async () => {
    const db = memoryDb([{ workId: "5", status: "unconfirmed", checkFailCount: 2, firstFailedAt: 1234, title: "Old" }]);
    const manager = new ImportManager({ bus: null, db });

    await manager.writeChunk([{ workId: "5", title: "New title", status: "active", checkFailCount: 0 }]);

    expect(db.rows.get("5")).toMatchObject({ title: "New title", status: "unconfirmed", checkFailCount: 2, firstFailedAt: 1234 });
  });
});

describe("positions always assume 20 bookmarks per page", () => {
  const blurb = (id) => `<li class="bookmark blurb" id="bookmark_${id}0"><h4 class="heading"><a href="/works/${id}">W${id}</a></h4></li>`;
  const placeholder = '<li class="bookmark blurb" id="bookmark_77"><p class="message">This has been deleted, sorry!</p></li>';

  test("positionOnPage", () => {
    expect(positionOnPage(1, 0)).toBe(1);
    expect(positionOnPage(3, 0)).toBe(41);
    expect(positionOnPage(3, 4)).toBe(45);
  });

  test("syncRecent places page 2 at 21+ even when page 1 was short", async () => {
    const db = memoryDb([{ workId: "300", originalPosition: 99, status: "active" }]);
    const pages = { 1: loggedIn + blurb("201") + blurb("202"), 2: loggedIn + blurb("203") + blurb("300") };
    const manager = new ImportManager({
      bus: null,
      db,
      delayFn: async () => {},
      fetchFn: async (url) => ({
        ok: true,
        status: 200,
        text: async () => pages[Number(new URL(url).searchParams.get("page"))] || loggedIn
      })
    });

    await manager.syncRecent("marcie");

    expect(db.rows.get("201").originalPosition).toBe(1);
    expect(db.rows.get("203").originalPosition).toBe(21);
    expect(db.rows.get("300").originalPosition).toBe(22);
  });

  test("the full import walk does not drift when a page holds a deleted placeholder", async () => {
    const db = memoryDb();
    const pagination = '<ol class="pagination actions"><li><a href="?page=2">2</a></li></ol>';
    const pages = {
      1: loggedIn + placeholder + blurb("101") + pagination,
      2: loggedIn + blurb("102") + pagination
    };
    const manager = new ImportManager({
      bus: null,
      db,
      delayFn: async () => {},
      fetchFn: async (url) => ({
        ok: true,
        status: 200,
        text: async () => pages[Number(new URL(url).searchParams.get("page"))] || loggedIn
      })
    });

    await manager.start({ username: "marcie" });
    await manager.currentRun;

    expect(db.rows.get("101").originalPosition).toBe(2);
    expect(db.rows.get("102").originalPosition).toBe(21);
  });
});

describe("rate-limit pauses", () => {
  test("an import paused by repeated 429s announces it once, with the message", async () => {
    const emit = jest.fn();
    const manager = new ImportManager({
      bus: { emit },
      db: memoryDb(),
      delayFn: async () => {},
      backoffDelayFn: async () => {},
      fetchFn: async () => ({ ok: false, status: 429, text: async () => "" })
    });

    await manager.start({ username: "marcie" });
    await manager.currentRun;

    const paused = emit.mock.calls.filter(([type]) => type === "import:paused");
    expect(paused).toHaveLength(1);
    expect(paused[0][1]).toMatchObject({ reason: "rate-limit", message: expect.stringContaining("rate-limit") });
  });
});

describe("pages without trackable works don't end the import early", () => {
  const login = '<div id="greeting"><a href="/logout">Log Out</a></div>';
  const series = (id) => `<li class="bookmark blurb" id="bookmark_${id}"><h4 class="heading"><a href="/series/${id}">Series</a></h4></li>`;
  const work = (id) => `<li class="bookmark blurb" id="bookmark_${id}0"><h4 class="heading"><a href="/works/${id}">Work ${id}</a></h4></li>`;
  const pager = '<ol class="pagination actions"><li><a href="?page=2">2</a></li></ol>';
  const importerFor = (db, pages, urls = []) => new ImportManager({
    bus: null,
    db,
    delayFn: async () => {},
    fetchFn: async (url) => {
      urls.push(url);
      const page = Number(new URL(url).searchParams.get("page"));
      return { ok: true, status: 200, text: async () => pages[page] || login };
    }
  });

  test("a series-only page 1 doesn't stop the full import before page 2", async () => {
    const db = memoryDb();
    const urls = [];
    const importer = importerFor(db, { 1: login + series(7) + pager, 2: login + work(9) + pager }, urls);

    await importer.start({ username: "marcie" });
    await importer.currentRun;

    expect(urls).toHaveLength(2);
    expect(db.rows.has("9")).toBe(true);
    expect(db.meta && (await db.meta.get("import:status")).value).toBe("complete");
  });

  test("a genuinely empty account completes after one request", async () => {
    const db = memoryDb();
    const urls = [];
    const importer = importerFor(db, { 1: login }, urls);

    await importer.start({ username: "marcie" });
    await importer.currentRun;

    expect(urls).toHaveLength(1);
    expect((await db.meta.get("import:status")).value).toBe("complete");
  });

  test("the recent-bookmarks sweep looks past a series-only page", async () => {
    const db = memoryDb([{ workId: "300", status: "active", originalPosition: 30 }]);
    const importer = importerFor(db, { 1: login + series(7) + pager, 2: login + work(201) + work(300) });

    const result = await importer.syncRecent("marcie");

    expect(result.success).toBe(true);
    expect(db.rows.has("201")).toBe(true);
  });
});

describe("a failed start never leaves the importer stuck as running", () => {
  test("a database error while starting is reported, and a later start works", async () => {
    const db = memoryDb();
    const realPut = db.meta.put;
    let failNext = true;
    db.meta.put = async (row) => {
      if (failNext) { failNext = false; throw new Error("temporary db failure"); }
      return realPut(row);
    };
    const importer = new ImportManager({
      bus: null,
      db,
      delayFn: async () => {},
      fetchFn: async () => ({ ok: true, status: 200, text: async () => '<div id="user-menu"></div>' })
    });

    const first = await importer.start({ username: "marcie" });
    expect(first).toMatchObject({ success: false, error: "temporary db failure" });
    expect(importer.running).toBe(false);

    const second = await importer.start({ username: "marcie" });
    expect(second.success).toBe(true);
    await importer.currentRun;
  });
});
