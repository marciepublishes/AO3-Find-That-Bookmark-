/**
 * @jest-environment jsdom
 */
const fs = require("fs");
const path = require("path");

const {
  enableBookmarksReturnLink,
  getRenderedWorkEntries,
  injectDashboardSection,
  workIdFromBlurb,
  reconstructBlurb
} = require("../modules/injection-manager");

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

describe("reconstructBlurb required-tags do not reuse AO3's icon layout", () => {
  // Regression: rendering the rating/warnings/categories as bare text inside
  // ul.required-tags let AO3's fixed-size icon-slot CSS apply, so long labels
  // like "Creator Chose Not To Use Archive Warnings" overflowed and overlapped.
  const work = {
    workId: "555",
    title: "Choose Not To Fic",
    authors: ["someone"],
    rating: "Explicit",
    warnings: ["Creator Chose Not To Use Archive Warnings"],
    categories: ["M/M"],
    deletedAt: Date.now()
  };
  const blurb = reconstructBlurb(work, document);

  test("does not place required tags inside AO3's ul.required-tags", () => {
    expect(blurb.querySelector("ul.required-tags")).toBeNull();
    expect(blurb.querySelector("ul.ao3-lost-found__required")).not.toBeNull();
  });

  test("renders the long 'choose not to' warning as readable text, not an icon slot", () => {
    const warning = blurb.querySelector(".ao3-lost-found__req--warning");
    expect(warning).not.toBeNull();
    expect(warning.textContent).toBe("Creator Chose Not To Use Archive Warnings");
  });

  test("keeps rating and category alongside the warning", () => {
    const labels = [...blurb.querySelectorAll(".ao3-lost-found__req")].map((el) => el.textContent);
    expect(labels).toEqual(["Explicit", "Creator Chose Not To Use Archive Warnings", "M/M"]);
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

describe("Deleted view dashboard navigation", () => {
  function dashboardMarkup() {
    return `
      <div id="dashboard">
        <ul class="navigation actions">
          <li><span class="current">Bookmarks (21)</span></li>
          <li><a href="/users/marcie_writes_garbage/gifts">Gifts (0)</a></li>
        </ul>
      </div>`;
  }

  test("marks Deleted as AO3's native current item in the filtered view", () => {
    document.body.innerHTML = dashboardMarkup();
    injectDashboardSection(document, {
      pathname: "/users/marcie_writes_garbage/bookmarks",
      search: "?ao3_lost_found=deleted"
    }, { deleted: 4 });

    const current = document.querySelector("[data-ao3-lost-found-count='deleted']");
    expect(current.tagName).toBe("SPAN");
    expect(current.classList.contains("current")).toBe(true);
    expect(current.textContent).toBe("Deleted (4)");
  });

  test("keeps Deleted clickable on the normal bookmarks page", () => {
    document.body.innerHTML = dashboardMarkup();
    injectDashboardSection(document, {
      pathname: "/users/marcie_writes_garbage/bookmarks",
      search: ""
    }, { deleted: 4 });

    const link = document.querySelector("a[data-ao3-lost-found-count='deleted']");
    expect(link).not.toBeNull();
    expect(link.classList.contains("current")).toBe(false);
    expect(link.getAttribute("href")).toBe("/users/marcie_writes_garbage/bookmarks?ao3_lost_found=deleted");
  });

  test("turns AO3's current Bookmarks span into a link back to regular bookmarks", () => {
    document.body.innerHTML = `
      <div id="dashboard">
        <ul class="navigation actions">
          <li><span class="current">Bookmarks (21)</span></li>
        </ul>
      </div>`;

    const changed = enableBookmarksReturnLink(document, {
      pathname: "/users/marcie_writes_garbage/bookmarks",
      search: "?ao3_lost_found=deleted"
    });

    const link = document.querySelector("#dashboard a[data-ao3-lost-found-return='bookmarks']");
    expect(changed).toBe(true);
    expect(link).not.toBeNull();
    expect(link.textContent).toBe("Bookmarks (21)");
    expect(link.getAttribute("href")).toBe("/users/marcie_writes_garbage/bookmarks");
    expect(document.querySelector("#dashboard span.current")).toBeNull();
  });

  test("leaves the native current marker alone on a normal bookmarks page", () => {
    document.body.innerHTML = `<div id="dashboard"><span class="current">Bookmarks (21)</span></div>`;

    expect(enableBookmarksReturnLink(document, {
      pathname: "/users/marcie_writes_garbage/bookmarks",
      search: ""
    })).toBe(false);
    expect(document.querySelector("#dashboard span.current")).not.toBeNull();
  });
});
