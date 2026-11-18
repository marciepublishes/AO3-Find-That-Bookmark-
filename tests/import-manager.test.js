const fs = require("fs");
const path = require("path");

const {
  ImportManager,
  buildProgress,
  computeBackoff,
  isLoggedInBookmarkPage,
  parseBookmarkBlurb,
  randomDelay
} = require("../modules/import-manager");

const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");

function fakeDb(initialMeta = {}, worksCount = 0) {
  const meta = new Map(Object.entries(initialMeta));
  return {
    meta: {
      get: async (key) => (meta.has(key) ? { key, value: meta.get(key) } : undefined),
      put: async ({ key, value }) => { meta.set(key, value); }
    },
    works: {
      count: async () => worksCount,
      bulkGet: async (ids) => ids.map(() => undefined),
      bulkPut: async () => {}
    }
  };
}

describe("ImportManager parser", () => {
  test("parseBookmarkBlurb extracts all work record fields from standard AO3 bookmark HTML", () => {
    const work = parseBookmarkBlurb(fixture("bookmark-standard.html"), { originalPosition: 7 });

    expect(work).toMatchObject({
      workId: "123456",
      title: "The Cartographer's Archive",
      authors: ["ExampleAuthor"],
      fandoms: ["Example Fandom"],
      rating: "Teen And Up Audiences",
      warnings: ["No Archive Warnings Apply"],
      categories: ["F/M"],
      relationships: ["Alice/Bob"],
      characters: ["Alice"],
      freeTags: ["Found Family"],
      wordCount: 42000,
      chapters: "10/10",
      summary: "A map, a mystery, and a promise kept.",
      bookmarkNotes: "Private note with useful context.",
      bookmarkTags: ["comfort reread", "private marker"],
      dateBookmarked: "10 Jan 2025",
      workLastUpdated: "2024-03-01",
      originalPosition: 7,
      status: "active",
      checkFailCount: 0,
      lastChecked: null,
      deletedAt: null,
      pinnedToTop: false,
      notified: false
    });
    expect(typeof work.importedAt).toBe("number");
    expect(work.orphanedAt).toBeUndefined();
  });

  test("parseBookmarkBlurb handles minimal metadata without inventing values", () => {
    const work = parseBookmarkBlurb(fixture("bookmark-minimal.html"), { originalPosition: 2 });

    expect(work).toMatchObject({
      workId: "987654",
      title: "Signal Lost",
      authors: ["MinimalAuthor"],
      fandoms: ["Small Fandom"],
      rating: "General Audiences",
      warnings: [],
      categories: [],
      relationships: [],
      characters: [],
      freeTags: [],
      wordCount: 1234,
      chapters: "1/1",
      summary: "",
      bookmarkNotes: "",
      bookmarkTags: [],
      dateBookmarked: "02 Feb 2025",
      workLastUpdated: "",
      originalPosition: 2,
      status: "active",
      deletedAt: null
    });
    expect(work.orphanedAt).toBeUndefined();
  });

  test("logged-in detection accepts user menu markers and rejects anonymous pages", () => {
    expect(isLoggedInBookmarkPage("<div id=\"greeting\"><a href=\"/logout\">Log Out</a></div>")).toBe(true);
    expect(isLoggedInBookmarkPage("<div id=\"greeting\"><a href=\"/users/login\">Log In</a></div>")).toBe(false);
  });
});

describe("ImportManager.ensureRunning", () => {
  function manager({ status = null, running = false, worksCount = 0 } = {}) {
    const instance = new ImportManager({
      bus: { emit: jest.fn() },
      db: fakeDb({ "import:status": status }, worksCount),
      fetchFn: async () => ({})
    });
    instance.running = running;
    instance.start = jest.fn(async (args) => ({ success: true, started: args }));
    return instance;
  }

  test("requires a username", async () => {
    const instance = manager();
    expect((await instance.ensureRunning({ username: "  " })).success).toBe(false);
    expect(instance.start).not.toHaveBeenCalled();
  });

  test("skips when a run is genuinely in progress", async () => {
    const instance = manager({ status: "running", running: true });
    expect(await instance.ensureRunning({ username: "marcie" })).toMatchObject({ skipped: "already-running" });
    expect(instance.start).not.toHaveBeenCalled();
  });

  test("resumes when status is running but no run is active (worker was evicted)", async () => {
    const instance = manager({ status: "running", running: false });
    await instance.ensureRunning({ username: "marcie" });
    expect(instance.start).toHaveBeenCalledWith({ username: "marcie", resume: true });
  });

  test("skips a completed import that already has data", async () => {
    const instance = manager({ status: "complete", worksCount: 12 });
    expect(await instance.ensureRunning({ username: "marcie" })).toMatchObject({ skipped: "already-imported" });
    expect(instance.start).not.toHaveBeenCalled();
  });

  test("re-walks a completed import that produced no data", async () => {
    const instance = manager({ status: "complete", worksCount: 0 });
    await instance.ensureRunning({ username: "marcie" });
    expect(instance.start).toHaveBeenCalledWith({ username: "marcie", resume: false });
  });

  test("resumes a paused import", async () => {
    const instance = manager({ status: "paused" });
    await instance.ensureRunning({ username: "marcie" });
    expect(instance.start).toHaveBeenCalledWith({ username: "marcie", resume: true });
  });

  test("starts fresh when never imported", async () => {
    const instance = manager({ status: null });
    await instance.ensureRunning({ username: "marcie" });
    expect(instance.start).toHaveBeenCalledWith({ username: "marcie", resume: false });
  });
});

describe("ImportManager resume", () => {
  test("continues from the page after the last completed one", async () => {
    const urls = [];
    const instance = new ImportManager({
      bus: { emit: jest.fn() },
      db: fakeDb({ "import:lastCompletedPage": 3, "import:username": "marcie" }),
      fetchFn: async (url) => {
        urls.push(url);
        return { ok: true, status: 200, text: async () => "<div id=\"user-menu\"></div>" };
      },
      delayFn: async () => {}
    });

    await instance.start({ username: "marcie", resume: true });
    await instance.currentRun;

    expect(urls[0]).toContain("page=4");
  });
});

describe("ImportManager.syncRecent", () => {
  const loggedIn = "<div id=\"user-menu\"></div>";
  const blurb = (workId) => `<li class="bookmark blurb"><a href="/works/${workId}">Work ${workId}</a></li>`;
  const page = (ids) => loggedIn + ids.map(blurb).join("");

  function syncManager({ pages = {}, known = [] } = {}) {
    const knownIds = new Set(known.map(String));
    const fetched = [];
    const written = [];
    const db = {
      works: {
        bulkGet: async (ids) => ids.map((id) => (knownIds.has(String(id)) ? { workId: String(id) } : undefined)),
        bulkPut: async (records) => { records.forEach((record) => written.push(record.workId)); }
      }
    };
    const instance = new ImportManager({
      bus: { emit: jest.fn() },
      db,
      delayFn: async () => {},
      fetchFn: async (url) => {
        const pageNumber = Number(new URL(url).searchParams.get("page"));
        fetched.push(pageNumber);
        return { ok: true, status: 200, text: async () => (pages[pageNumber] || page([])) };
      }
    });
    return { instance, fetched, written };
  }

  test("stops after one page when it already overlaps known works", async () => {
    const { instance, fetched } = syncManager({
      pages: { 1: page(["100", "101"]) },
      known: ["100"]
    });

    const result = await instance.syncRecent("marcie");

    expect(fetched).toEqual([1]);
    expect(result.captured).toBe(2);
  });

  test("walks consecutive all-new pages until it reaches known territory", async () => {
    const { instance, fetched, written } = syncManager({
      pages: {
        1: page(["201", "202"]),
        2: page(["203", "300"])
      },
      known: ["300"]
    });

    const result = await instance.syncRecent("marcie");

    expect(fetched).toEqual([1, 2]);
    expect(result.captured).toBe(4);
    expect(written).toEqual(["201", "202", "203", "300"]);
  });

  test("stops when a page has no bookmarks", async () => {
    const { instance, fetched } = syncManager({
      pages: { 1: page(["401"]) }, // page 2 falls back to empty
      known: []
    });

    const result = await instance.syncRecent("marcie");

    expect(fetched).toEqual([1, 2]);
    expect(result.captured).toBe(1);
  });

  test("does nothing while a full import is running", async () => {
    const { instance, fetched } = syncManager();
    instance.running = true;

    const result = await instance.syncRecent("marcie");

    expect(result).toMatchObject({ skipped: "import-running" });
    expect(fetched).toEqual([]);
  });

  test("treats network-level fetch failures as transient skips", async () => {
    const instance = new ImportManager({
      bus: { emit: jest.fn() },
      db: {
        works: {
          bulkGet: async () => [],
          bulkPut: async () => {}
        }
      },
      fetchFn: async () => {
        throw new TypeError("Failed to fetch");
      }
    });

    await expect(instance.syncRecent("marcie")).resolves.toMatchObject({
      success: false,
      skipped: "network-error",
      transient: true,
      error: "Failed to fetch"
    });
  });
});

describe("ImportManager.findMissingOnPage", () => {
  // A backing store so reconcile + confirm-deletion can be observed end to end.
  function worksDb(seed = []) {
    const rows = new Map(seed.map((r) => [String(r.workId), { ...r }]));
    return {
      _rows: rows,
      get: async (id) => rows.get(String(id)),
      put: async (rec) => { rows.set(String(rec.workId), { ...rec }); },
      bulkGet: async (ids) => ids.map((id) => rows.get(String(id))),
      bulkPut: async (recs) => { recs.forEach((r) => rows.set(String(r.workId), { ...r })); },
      toArray: async () => [...rows.values()]
    };
  }

  function manager({ html, seed = [], verifyDeleted } = {}) {
    const works = worksDb(seed);
    const emit = jest.fn();
    const instance = new ImportManager({
      bus: { emit },
      db: { works },
      delayFn: async () => {},
      now: () => 1000,
      fetchFn: async () => ({ ok: true, status: 200, text: async () => html }),
      verifyDeleted
    });
    return { instance, works, emit };
  }

  const tier2Seed = () => [
    { workId: "900", originalPosition: 1, status: "active", title: "Ghost Fic" }, // no bookmarkId
    { workId: "33761359", originalPosition: 2, status: "active" },
    { workId: "73617951", originalPosition: 3, status: "active" }
  ];

  const page = fixture("bookmark-listing-page.html"); // deleted bookmark 2907130126 + works 33761359, 73617951

  test("Tier 1: matches the deleted placeholder by stored bookmarkId and confirms it", async () => {
    const { instance, works, emit } = manager({
      html: page,
      seed: [
        { workId: "900", bookmarkId: "2907130126", originalPosition: 1, status: "active", title: "Ghost Fic", checkFailCount: 0 },
        { workId: "33761359", bookmarkId: "2895346471", originalPosition: 2, status: "active" },
        { workId: "73617951", bookmarkId: "2799293576", originalPosition: 3, status: "active" }
      ]
    });

    const result = await instance.findMissingOnPage("marcie", 1);

    expect(result.success).toBe(true);
    expect(result.confirmed).toHaveLength(1);
    expect(result.confirmed[0]).toMatchObject({ workId: "900", title: "Ghost Fic", tier: 1 });
    // Persisted as a confirmed deletion.
    const stored = await works.get("900");
    expect(stored).toMatchObject({ status: "deleted", deletedAt: 1000, pinnedToTop: true });
    expect(stored.checkFailCount).toBeGreaterThanOrEqual(3);
    // Fired the shared confirmed-deletion event so badge/notification update.
    expect(emit).toHaveBeenCalledWith("checks:confirmed", expect.objectContaining({ work: expect.objectContaining({ workId: "900" }) }));
  });

  test("Tier 2: resolves by neighbour anchors once a live check agrees", async () => {
    const verifyDeleted = jest.fn(async () => true);
    const { instance, works } = manager({ html: page, seed: tier2Seed(), verifyDeleted });

    const result = await instance.findMissingOnPage("marcie", 1);

    expect(verifyDeleted).toHaveBeenCalledWith(expect.objectContaining({ workId: "900" }));
    expect(result.confirmed).toHaveLength(1);
    expect(result.confirmed[0]).toMatchObject({ workId: "900", tier: 2 });
    expect((await works.get("900")).status).toBe("deleted");
  });

  test("Tier 2: a candidate that still loads is reported, not confirmed", async () => {
    const { instance, works, emit } = manager({ html: page, seed: tier2Seed(), verifyDeleted: async () => false });

    const result = await instance.findMissingOnPage("marcie", 1);

    expect(result.confirmed).toEqual([]);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0].candidates).toEqual([expect.objectContaining({ workId: "900" })]);
    expect((await works.get("900")).status).toBe("active");
    expect(emit).not.toHaveBeenCalledWith("checks:confirmed", expect.anything());
  });

  test("Tier 2: never auto-confirms without a verifier", async () => {
    const { instance, works } = manager({ html: page, seed: tier2Seed() });

    const result = await instance.findMissingOnPage("marcie", 1);

    expect(result.confirmed).toEqual([]);
    expect(result.ambiguous).toHaveLength(1);
    expect((await works.get("900")).status).toBe("active");
  });

  test("reports logged-out without touching the database", async () => {
    const { instance, works } = manager({ html: "<html><body>Please log in</body></html>", seed: [] });
    const result = await instance.findMissingOnPage("marcie", 1);
    expect(result).toMatchObject({ success: false, loggedOut: true });
    expect(await works.toArray()).toEqual([]);
  });

  test("requires a page number", async () => {
    const { instance } = manager({ html: page });
    expect(await instance.findMissingOnPage("marcie")).toMatchObject({ success: false });
  });

  test("a page with no deletions confirms nothing", async () => {
    const clean = '<div id="user-menu"></div><ol class="bookmark index group">'
      + '<li class="bookmark blurb work-1"><h4 class="heading"><a href="/works/1">A</a></h4></li>'
      + "</ol>";
    const { instance, emit } = manager({ html: clean, seed: [{ workId: "1", originalPosition: 1, status: "active" }] });
    const result = await instance.findMissingOnPage("marcie", 1);
    expect(result).toMatchObject({ success: true, deletedFound: 0, confirmed: [] });
    expect(emit).not.toHaveBeenCalledWith("checks:confirmed", expect.anything());
  });
});

describe("ImportManager timing helpers", () => {
  test("randomDelay stays within range across 1000 samples", () => {
    for (let index = 0; index < 1000; index += 1) {
      const value = randomDelay(4000, 8000);
      expect(value).toBeGreaterThanOrEqual(4000);
      expect(value).toBeLessThanOrEqual(8000);
    }
  });

  test("computeBackoff returns the required 429 sequence", () => {
    expect([computeBackoff(1), computeBackoff(2), computeBackoff(3)]).toEqual([30000, 60000, 120000]);
  });

  test("buildProgress reports bounded percentages", () => {
    expect(buildProgress(2, 5)).toEqual({
      currentPage: 2,
      estimatedTotalPages: 5,
      percentComplete: 40
    });
  });
});
