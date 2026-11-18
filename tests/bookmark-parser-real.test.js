/**
 * @jest-environment jsdom
 */
const fs = require("fs");
const path = require("path");

const { parseBlurbElement, parseBookmarkBlurb } = require("../modules/bookmark-parser");

const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");

// Parse a fixture's <li> through the DOM path, the way the content script does.
// The jsdom test environment provides the global `document`.
function domBlurb(name) {
  document.body.innerHTML = `<ol>${fixture(name)}</ol>`;
  return parseBlurbElement(document.querySelector("li.bookmark.blurb"), { originalPosition: 1 });
}

describe("parseBlurbElement on real AO3 markup", () => {
  const work = domBlurb("bookmark-real-multi.html");

  test("reads the work id from the title link, not injected/absolute links", () => {
    // The page also contains an injected ao3t "Ch. 14/14" link pointing at
    // /works/73617951/chapters/224934991 — the title link must still win.
    expect(work.workId).toBe("73617951");
    expect(work.title).toBe("The Theory of Transference");
  });

  test("rating comes from the required-tags symbol span", () => {
    expect(work.rating).toBe("Explicit");
  });

  test("captures the bookmark id from the <li id> (DOM path)", () => {
    expect(work.bookmarkId).toBe("2799293576");
  });

  test("keeps both warnings (from the split tag list)", () => {
    expect(work.warnings).toEqual(["Graphic Depictions Of Violence", "Rape/Non-Con"]);
  });

  test("splits the comma-joined categories from the symbol", () => {
    expect(work.categories).toEqual(["Gen", "M/M"]);
  });

  test("classifies relationships/characters/freeforms by AO3's li classes", () => {
    expect(work.relationships).toEqual([
      "Harry Potter/Severus Snape",
      "Harry Potter & Voldemort"
    ]);
    expect(work.characters).toEqual(["Harry Potter", "Severus Snape", "Voldemort (Harry Potter)"]);
    expect(work.freeTags).toEqual(["Drug Addiction", "Slow Burn"]);
  });

  test("is not poisoned by another extension's injected nodes", () => {
    // The neighbouring extension injects "Hide relationship: …" / "Hide tag:
    // Slow Burn" buttons inside <h4>. None of that should leak into the tags.
    expect(work.relationships).toHaveLength(2);
    expect(work.freeTags).not.toContain("Slow Burn".repeat(2)); // no duplication from the hide menu
    expect(work.characters).not.toContain("");
  });

  test("captures a nested-blockquote summary in full", () => {
    expect(work.summary).toContain("In 1998");
    expect(work.summary).toContain("Lie down"); // text inside the NESTED blockquote
    expect(work.summary).toContain("documented history");
  });

  test("distinguishes the bookmark date from the work date", () => {
    expect(work.dateBookmarked).toBe("25 Apr 2026"); // user module
    expect(work.workLastUpdated).toBe("20 May 2026"); // header
  });

  test("reads word count and chapters cleanly", () => {
    expect(work.wordCount).toBe(116565);
    expect(work.chapters).toBe("14/15");
  });

  test("captures the bookmarker's own tags when present", () => {
    const tagged = domBlurb("bookmark-real-tagged.html");
    expect(tagged.bookmarkTags).toEqual(["Worth Re-Reading"]);
    expect(tagged.warnings).toEqual(["Creator Chose Not To Use Archive Warnings"]);
    expect(tagged.categories).toEqual(["F/M"]);
    expect(tagged.dateBookmarked).toBe("13 Apr 2026");
  });
});

describe("regex path now reads real AO3 markup too (import walk)", () => {
  const work = parseBookmarkBlurb(fixture("bookmark-real-multi.html"), { originalPosition: 1 });

  test("symbol-span rating/categories and tag-list warnings are extracted", () => {
    expect(work.rating).toBe("Explicit");
    expect(work.warnings).toEqual(["Graphic Depictions Of Violence", "Rape/Non-Con"]);
    expect(work.categories).toEqual(["Gen", "M/M"]);
  });

  test("bookmark date is the user-module datetime, not the work date", () => {
    expect(work.dateBookmarked).toBe("25 Apr 2026");
    expect(work.workLastUpdated).toBe("20 May 2026");
  });

  test("nested-blockquote summary is not truncated", () => {
    expect(work.summary).toContain("Lie down");
    expect(work.summary).toContain("documented history");
  });
});

describe("DOM and regex paths converge on the same real blurb", () => {
  test("structured fields match across both parsers", () => {
    const dom = domBlurb("bookmark-real-multi.html");
    const rgx = parseBookmarkBlurb(fixture("bookmark-real-multi.html"), { originalPosition: 1 });

    // Compare everything except free-text summary (whitespace differs between
    // textContent and stripped HTML) and the per-call importedAt timestamp.
    const normalize = ({ summary, importedAt, ...rest }) => rest;
    expect(normalize(dom)).toEqual(normalize(rgx));
  });
});
