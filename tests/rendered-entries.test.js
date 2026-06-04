/**
 * @jest-environment jsdom
 */
const fs = require("fs");
const path = require("path");

const { getRenderedWorkEntries, workIdFromBlurb } = require("../modules/injection-manager");

const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
const onBookmarks = { search: "", pathname: "/users/marcie_writes_garbage/bookmarks" };

function listFrom(...names) {
  document.body.innerHTML = `<ol class="bookmark index group">${names.map(fixture).join("")}</ol>`;
  return document;
}

describe("getRenderedWorkEntries on real AO3 bookmark markup", () => {
  test("reads work ids from the work-<id> class, not the bookmark id or the count link", () => {
    const entries = getRenderedWorkEntries(listFrom("bookmark-real-multi.html", "bookmark-real-tagged.html"), onBookmarks);

    // The <li> ids are bookmark_2799293576 / bookmark_2769712421, and a status
    // link points at /works/<id>/bookmarks (text "43"/"*") — none of those.
    expect(entries.map((entry) => entry.workId)).toEqual(["73617951", "10643571"]);
    expect(entries.map((entry) => entry.position)).toEqual([1, 2]);
  });

  test("excludes our own injected deleted blurbs", () => {
    document.body.innerHTML = `
      <ol class="bookmark index group">
        ${fixture("bookmark-real-multi.html")}
        <li class="bookmark blurb group ao3-lost-found ao3-lost-found--deleted"><div class="header module"><h4 class="heading"><a href="/works/999000">Injected</a></h4></div></li>
      </ol>`;
    const entries = getRenderedWorkEntries(document, onBookmarks);

    expect(entries.map((entry) => entry.workId)).toEqual(["73617951"]);
  });

  test("offsets positions by page number", () => {
    const entries = getRenderedWorkEntries(
      listFrom("bookmark-real-multi.html", "bookmark-real-tagged.html"),
      { search: "?page=3", pathname: "/users/marcie_writes_garbage/bookmarks" }
    );
    // pageSize = rendered count (2): page 3 → 5, 6.
    expect(entries.map((entry) => entry.position)).toEqual([5, 6]);
  });
});

describe("workIdFromBlurb", () => {
  test("prefers the work-<id> class", () => {
    document.body.innerHTML = `<li class="bookmark blurb group work-12345 user-1"></li>`;
    expect(workIdFromBlurb(document.querySelector("li"))).toBe("12345");
  });

  test("falls back to the heading work link when no work-<id> class", () => {
    document.body.innerHTML = `<li class="bookmark blurb"><div class="header module"><h4 class="heading"><a href="/works/777">T</a></h4></div></li>`;
    expect(workIdFromBlurb(document.querySelector("li"))).toBe("777");
  });

  test("returns empty string for a series/external blurb", () => {
    document.body.innerHTML = `<li class="bookmark blurb"><div class="header module"><h4 class="heading"><a href="/series/42">S</a></h4></div></li>`;
    expect(workIdFromBlurb(document.querySelector("li"))).toBe("");
  });
});
