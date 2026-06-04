const fs = require("fs");
const path = require("path");

const {
  parseBookmarkBlurb,
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
