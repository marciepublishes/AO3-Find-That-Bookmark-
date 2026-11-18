const fs = require("fs");
const path = require("path");

const {
  parseBookmarkBlurb,
  parseBookmarkPage,
  reconcileMissingOnPage,
  classifyFreeTags,
  heuristicClassify
} = require("../modules/bookmark-parser");

const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");

describe("class-based tag classification (regex path)", () => {
  // The multitag fixture is the regression case for the old heuristic, which
  // misfiled spaced characters / "&"-style relationships and dropped all but
  // the first warning and category.
  const work = parseBookmarkBlurb(fixture("bookmark-multitag.html"), { originalPosition: 1 });

  test("keeps every warning instead of only the first", () => {
    expect(work.warnings).toEqual([
      "Graphic Depictions Of Violence",
      "Major Character Death"
    ]);
  });

  test("keeps every category instead of only the first", () => {
    expect(work.categories).toEqual(["M/M", "F/M"]);
  });

  test("files an '&'-style relationship as a relationship, not a freeform", () => {
    expect(work.relationships).toEqual(["Steve Rogers & Bucky Barnes"]);
  });

  test("files spaced character names as characters, not freeforms", () => {
    expect(work.characters).toEqual(["Steve Rogers", "Bucky Barnes"]);
  });

  test("keeps genuine freeforms separate", () => {
    expect(work.freeTags).toEqual(["Slow Burn"]);
  });

  test("decodes HTML entities in tag text", () => {
    // &amp; in the fixture must come back as a literal ampersand.
    expect(work.relationships[0]).toContain(" & ");
  });
});

describe("heuristic fallback when <li> type classes are absent", () => {
  const legacy = `
    <li class="bookmark blurb">
      <h4 class="heading"><a href="/works/777">Fallback Fic</a></h4>
      <ul class="tags commas">
        <li><a class="tag">Alice/Bob</a></li>
        <li><a class="tag">Carol</a></li>
        <li><a class="tag">Slow Burn</a></li>
      </ul>
    </li>`;

  test("classifyFreeTags degrades to the text heuristic", () => {
    expect(classifyFreeTags(legacy)).toEqual({
      relationships: ["Alice/Bob"],
      characters: ["Carol"],
      freeTags: ["Slow Burn"]
    });
  });

  test("heuristicClassify is the documented legacy behavior", () => {
    expect(heuristicClassify(["Alice/Bob", "Carol", "Slow Burn"])).toEqual({
      relationships: ["Alice/Bob"],
      characters: ["Carol"],
      freeTags: ["Slow Burn"]
    });
  });
});

describe("blurbs without a trackable work are skipped", () => {
  test("series bookmarks return null", () => {
    const html = `<li class="bookmark blurb"><h4 class="heading"><a href="/series/42">My Series</a></h4></li>`;
    expect(parseBookmarkBlurb(html)).toBeNull();
  });

  test("external-work bookmarks return null", () => {
    const html = `<li class="bookmark blurb"><h4 class="heading"><a href="https://example.com/fic">External</a></h4></li>`;
    expect(parseBookmarkBlurb(html)).toBeNull();
  });
});

describe("missing optional fields do not throw or invent data", () => {
  test("a work with no rel=author link yields an empty author list", () => {
    const html = `<li class="bookmark blurb"><h4 class="heading"><a href="/works/888">Anon Work</a></h4></li>`;
    const work = parseBookmarkBlurb(html);
    expect(work).toMatchObject({ workId: "888", title: "Anon Work", authors: [] });
  });
});

describe("parseBookmarkPage splits a full listing page (regex import walk)", () => {
  // Regression: real blurbs nest <li>s (required-tag icons, action buttons), so
  // splitting on the first </li> truncated every record after the rating —
  // dropping warnings, categories, cast, stats, summary and bookmark notes. The
  // extractor must balance <li>/</li> depth to slice whole blurbs.
  const { works } = parseBookmarkPage(fixture("bookmark-listing-page.html"), { pageNumber: 1 });

  test("skips the deleted-work blurb (no /works/ link) and keeps the live ones", () => {
    expect(works.map((w) => w.workId)).toEqual(["33761359", "73617951"]);
  });

  test("captures fields that live AFTER the nested required-tags <li>s", () => {
    expect(works[0]).toMatchObject({
      workId: "33761359",
      title: "The Storyteller",
      authors: ["gzdacz"],
      rating: "Mature",
      warnings: ["Graphic Depictions Of Violence"],
      categories: ["M/M"],
      relationships: ["Will Graham/Hannibal Lecter"],
      characters: ["Hannibal Lecter"],
      freeTags: ["Slow Burn"],
      wordCount: 188614,
      chapters: "33/33",
      bookmarkNotes: "Love, love, love this one.",
      dateBookmarked: "04 Jun 2026"
    });
  });

  test("does not bleed one blurb's fields into the next", () => {
    expect(works[1]).toMatchObject({
      workId: "73617951",
      title: "The Theory of Transference",
      rating: "Explicit",
      wordCount: 116565,
      chapters: "14/15",
      dateBookmarked: "25 Apr 2026"
    });
  });

  test("keeps a summary that contains a nested blockquote", () => {
    expect(works[0].summary).toContain("nested quote");
  });

  test("originalPosition tracks listing order; a skipped blurb leaves a gap", () => {
    // Position is assigned before null blurbs are filtered, so the skipped
    // deleted blurb at slot 1 leaves the live works at 2 and 3. Order stays
    // monotonic, which is all the check-queue prioritization needs.
    expect(works.map((w) => w.originalPosition)).toEqual([2, 3]);
  });
});

describe("bookmarkId capture", () => {
  test("regex path reads the bookmark id from the <li id>", () => {
    const html = `<li id="bookmark_2895346471" class="bookmark blurb work-33761359"><h4 class="heading"><a href="/works/33761359">T</a></h4></li>`;
    expect(parseBookmarkBlurb(html).bookmarkId).toBe("2895346471");
  });

  test("regex path falls back to a /bookmarks/<id>/ action link", () => {
    const html = `<li class="bookmark blurb work-1"><h4 class="heading"><a href="/works/1">T</a></h4><a href="/bookmarks/777/edit">Edit</a></li>`;
    expect(parseBookmarkBlurb(html).bookmarkId).toBe("777");
  });
});

describe("deleted-work placeholders are surfaced, not silently dropped", () => {
  const { works, deleted } = parseBookmarkPage(fixture("bookmark-listing-page.html"), { pageNumber: 1 });

  test("the deleted blurb becomes a placeholder with its surviving bookmark id", () => {
    expect(deleted).toEqual([{ bookmarkId: "2907130126", position: 1, deleted: true }]);
  });

  test("live works are still parsed normally alongside it", () => {
    expect(works.map((w) => w.workId)).toEqual(["33761359", "73617951"]);
  });

  test("a series bookmark (title link, no deleted notice) is NOT a placeholder", () => {
    const series = `<ol><li class="bookmark blurb"><h4 class="heading"><a href="/series/42">My Series</a></h4></li></ol>`;
    expect(parseBookmarkPage(series).deleted).toEqual([]);
  });
});

describe("reconcileMissingOnPage", () => {
  // A page showing one dead slot (bookmark 500) between two live works.
  const works = [
    { workId: "10", originalPosition: 2 },
    { workId: "30", originalPosition: 4 }
  ];
  const deleted = [{ bookmarkId: "500", position: 3, deleted: true }];

  test("Tier 1: an exact bookmark-id match resolves the work, order-independent", () => {
    const stored = [
      { workId: "10", bookmarkId: "100", originalPosition: 2 },
      { workId: "20", bookmarkId: "500", originalPosition: 3, title: "Ghost Fic" },
      { workId: "30", bookmarkId: "300", originalPosition: 4 }
    ];
    const [match] = reconcileMissingOnPage({ works, deleted, stored });
    expect(match.tier).toBe(1);
    expect(match.work.workId).toBe("20");
  });

  test("Tier 2: no bookmark-id match falls back to the work between the live anchors", () => {
    const stored = [
      { workId: "10", originalPosition: 2 },
      { workId: "20", originalPosition: 3, title: "Ghost Fic" }, // no bookmarkId
      { workId: "30", originalPosition: 4 }
    ];
    const [match] = reconcileMissingOnPage({ works, deleted, stored });
    expect(match.tier).toBe(2);
    expect(match.work.workId).toBe("20");
    expect(match.candidates).toHaveLength(1);
  });

  test("Tier 2: two stored works in the same gap are ambiguous (no auto-confirm)", () => {
    const stored = [
      { workId: "10", originalPosition: 2 },
      { workId: "20", originalPosition: 3 },
      { workId: "21", originalPosition: 3.5 },
      { workId: "30", originalPosition: 4 }
    ];
    const [match] = reconcileMissingOnPage({ works, deleted, stored });
    expect(match.tier).toBe(2);
    expect(match.work).toBeNull();
    expect(match.candidates.map((c) => c.workId)).toEqual(["20", "21"]);
  });

  test("a work still present on the page is never proposed as missing", () => {
    const stored = [
      { workId: "10", originalPosition: 2 },
      { workId: "30", originalPosition: 4 }
    ];
    // No stored ghost between the anchors → no candidates.
    const [match] = reconcileMissingOnPage({ works, deleted, stored });
    expect(match.candidates).toEqual([]);
  });
});
