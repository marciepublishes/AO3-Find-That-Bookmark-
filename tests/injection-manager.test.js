const {
  buildBookmarkTagUrl,
  buildLostFoundFilterUrl,
  formatFilteredHeading,
  formatDashboardLabel,
  getDashboardLinkStatus,
  getLostFoundFilter,
  reconstructBlurb,
  updateDashboardCounts,
  waybackUrl
} = require("../modules/injection-manager");

function fakeDocument() {
  return {
    createElement(tagName) {
      return {
        tagName: tagName.toUpperCase(),
        className: "",
        dataset: {},
        innerHTML: "",
        querySelector: jest.fn()
      };
    }
  };
}

const deletedWork = {
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
  bookmarkNotes: "Private note",
  bookmarkTags: ["comfort reread"],
  dateBookmarked: "10 Jan 2025",
  workLastUpdated: "2024-03-01",
  originalPosition: 7,
  status: "deleted",
  deletedAt: Date.parse("2026-05-20T12:00:00Z"),
  pinnedToTop: true
};

describe("InjectionManager", () => {
  test("reconstructBlurb includes title, author, fandom, tags, and the correct Wayback link", () => {
    const blurb = reconstructBlurb(deletedWork, fakeDocument());

    expect(blurb.className).toContain("ao3-lost-found--deleted");
    expect(blurb.dataset.workId).toBe("123456");
    expect(blurb.innerHTML).toContain("The Cartographer&#039;s Archive");
    expect(blurb.innerHTML).toContain("ExampleAuthor");
    expect(blurb.innerHTML).toContain("Example Fandom");
    expect(blurb.innerHTML).toContain("Found Family");
    expect(blurb.innerHTML).toContain("Deleted Work");
    expect(blurb.innerHTML).toContain("Deleted");
    expect(blurb.innerHTML).toContain("Search Wayback Machine");
    expect(blurb.innerHTML).toContain("Return to original position");
    expect(blurb.innerHTML).toContain("https://web.archive.org/web/*/archiveofourown.org/works/123456");
  });

  test("reconstructBlurb renders orphaned styling and tag text", () => {
    const blurb = reconstructBlurb({
      ...deletedWork,
      status: "orphaned",
      orphanedAt: Date.parse("2026-05-21T12:00:00Z")
    }, fakeDocument());

    expect(blurb.className).toContain("ao3-lost-found--orphaned");
    expect(blurb.innerHTML).toContain("Recently Orphaned");
    expect(blurb.innerHTML).toContain("Orphaned Work");
  });

  test("waybackUrl builds the required archive search URL", () => {
    expect(waybackUrl("987654")).toBe("https://web.archive.org/web/*/archiveofourown.org/works/987654");
  });

  test("buildBookmarkTagUrl filters the current user's bookmark page by status tag", () => {
    expect(buildBookmarkTagUrl("Deleted Work", {
      pathname: "/users/marcie_writes_garbage/bookmarks"
    })).toBe("/users/marcie_writes_garbage/bookmarks?ao3_lost_found=deleted");
  });

  test("Lost and Found sidebar URLs never use AO3 native bookmark search", () => {
    const location = { pathname: "/users/marcie_writes_garbage/bookmarks" };
    const deletedUrl = buildBookmarkTagUrl("Deleted Work", location);
    const orphanedUrl = buildBookmarkTagUrl("Orphaned Work", location);

    expect(deletedUrl).toBe("/users/marcie_writes_garbage/bookmarks?ao3_lost_found=deleted");
    expect(orphanedUrl).toBe("/users/marcie_writes_garbage/bookmarks?ao3_lost_found=orphaned");
    expect(deletedUrl).not.toContain("bookmark_search");
    expect(orphanedUrl).not.toContain("bookmark_search");
    expect(deletedUrl).not.toContain("/tags/");
    expect(orphanedUrl).not.toContain("/tags/");
  });

  test("buildLostFoundFilterUrl preserves the current user and extension-owned filter", () => {
    expect(buildLostFoundFilterUrl("deleted", {
      pathname: "/users/marcie_writes_garbage/readings"
    })).toBe("/users/marcie_writes_garbage/bookmarks?ao3_lost_found=deleted");
    expect(buildLostFoundFilterUrl("orphaned", {
      pathname: "/users/marcie_writes_garbage/profile"
    })).toBe("/users/marcie_writes_garbage/bookmarks?ao3_lost_found=orphaned");
  });

  test("getDashboardLinkStatus parses bare and counted sidebar labels only", () => {
    expect(getDashboardLinkStatus("Deleted")).toBe("deleted");
    expect(getDashboardLinkStatus("Deleted (0)")).toBe("deleted");
    expect(getDashboardLinkStatus("Orphaned (3)")).toBe("orphaned");
    expect(getDashboardLinkStatus("Deleted Work")).toBe("deleted");
    expect(getDashboardLinkStatus("Orphaned Work (3)")).toBe("orphaned");
    expect(getDashboardLinkStatus("Bookmarks (21)")).toBe(null);
  });

  test("formatDashboardLabel mirrors AO3 sidebar counts", () => {
    expect(formatDashboardLabel("Deleted Work", 3)).toBe("Deleted Work (3)");
    expect(formatDashboardLabel("Orphaned Work")).toBe("Orphaned Work (0)");
  });

  test("updateDashboardCounts rewrites older links without data markers", () => {
    const deletedLink = { textContent: "Deleted", dataset: {} };
    const orphanedLink = { textContent: "Orphaned", dataset: {} };
    const dashboard = {
      querySelector: () => null,
      querySelectorAll: () => [deletedLink, orphanedLink]
    };

    updateDashboardCounts(dashboard, { deleted: 2, orphaned: 0 });

    expect(deletedLink.textContent).toBe("Deleted (2)");
    expect(orphanedLink.textContent).toBe("Orphaned (0)");
  });

  test("getLostFoundFilter reads extension-owned filter params", () => {
    expect(getLostFoundFilter({ search: "?ao3_lost_found=deleted" })).toBe("deleted");
    expect(getLostFoundFilter({ search: "?ao3_lost_found=orphaned" })).toBe("orphaned");
    expect(getLostFoundFilter({ search: "?bookmark_search=Deleted%20Work" })).toBe(null);
  });

  test("formatFilteredHeading describes local lost work results", () => {
    expect(formatFilteredHeading({
      status: "deleted",
      total: 7,
      pageNumber: 1,
      pageSize: 20,
      username: "marcie_writes_garbage"
    })).toBe("1 - 7 of 7 found deleted works in marcie_writes_garbage's bookmarks");
    expect(formatFilteredHeading({
      status: "orphaned",
      total: 0,
      username: "marcie_writes_garbage"
    })).toBe("0 found orphaned works in marcie_writes_garbage's bookmarks");
  });
});
