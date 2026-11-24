/**
 * @jest-environment jsdom
 */
// Loads the real content script (bookmarks-injector.js) against a small AO3-like
// page, with the extension messaging API mocked.

require("../modules/constants");
require("../modules/bookmark-parser");
const injection = require("../modules/injection-manager");

const C = globalThis.AO3LostAndFoundConstants;

function pageMarkup({ owner, me = "marcie", list = "bookmark" }) {
  return `
    <header id="header"><ul id="greeting"><li><a href="/users/${me}">Hi, ${me}!</a></li></ul></header>
    <div id="dashboard">
      <ul class="navigation actions">
        <li><span class="current">Bookmarks (21)</span></li>
        <li><a href="/users/${owner}/gifts">Gifts (0)</a></li>
      </ul>
    </div>
    <div id="main">
      <h2 class="heading">1 - 20 of 21 Bookmarks by ${owner}</h2>
      ${list ? `<ol class="${list} index group"><li class="${list} blurb group work-1"><h4 class="heading"><a href="/works/1">One</a></h4></li></ol>` : ""}
      <ol class="pagination actions native-pager"><li><a href="?page=2">2</a></li></ol>
    </div>`;
}

async function loadInjector({ path, owner, me, deletedTotal = 45, list }) {
  history.replaceState(null, "", path);
  document.body.innerHTML = pageMarkup({ owner, me, list });
  const sendMessage = jest.fn(async (message) => {
    switch (message.type) {
      case C.MSG.GET_STATS: return { deleted: deletedTotal };
      case C.MSG.GET_SETTINGS: return {};
      case C.MSG.GET_LOST_WORKS_FILTER: {
        const works = Array.from({ length: Math.min(20, deletedTotal) }, (_, i) => ({ workId: String(900 + i), title: `Gone ${i}` }));
        return { works, total: deletedTotal, pageNumber: message.pageNumber, pageSize: 20 };
      }
      default: return {};
    }
  });
  globalThis.chrome = { runtime: { sendMessage } };
  jest.isolateModules(() => require("../bookmarks-injector"));
  await globalThis.ao3LostAndFoundInjector.ready;
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { sendMessage, injector: globalThis.ao3LostAndFoundInjector };
}

const sentTypes = (sendMessage) => sendMessage.mock.calls.map(([message]) => message.type);

describe("only on the logged-in user's own pages", () => {
  test("another user's bookmarks get no Deleted entry and start no import", async () => {
    const { sendMessage } = await loadInjector({ path: "/users/someone/bookmarks", owner: "someone" });

    expect(document.querySelector("[data-ao3-lost-found-dashboard]")).toBeNull();
    expect(sentTypes(sendMessage)).not.toContain(C.MSG.ENSURE_IMPORT);
    expect(sentTypes(sendMessage)).not.toContain(C.MSG.SNAPSHOT_BOOKMARKS);
  });

  test("another user's page never renders the Deleted view, even with the filter in the URL", async () => {
    const { sendMessage } = await loadInjector({ path: "/users/someone/bookmarks?ao3_lost_found=deleted", owner: "someone" });

    expect(sentTypes(sendMessage)).not.toContain(C.MSG.GET_LOST_WORKS_FILTER);
    expect(document.querySelector(".ao3-lost-found")).toBeNull();
  });

  test("your own bookmarks still get the Deleted entry (name match ignores case)", async () => {
    await loadInjector({ path: "/users/Marcie/bookmarks", owner: "Marcie", me: "marcie" });

    expect(document.querySelector("[data-ao3-lost-found-dashboard]")).not.toBeNull();
  });
});

describe("Deleted view pagination", () => {
  test("more than 20 deleted works get our own pager in place of AO3's", async () => {
    await loadInjector({ path: "/users/marcie/bookmarks?ao3_lost_found=deleted", owner: "marcie", deletedTotal: 45 });

    expect(document.querySelector(".native-pager")).toBeNull();
    const pager = document.querySelector(".ao3-lost-found-pager");
    expect(pager).not.toBeNull();
    const hrefs = [...pager.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/users/marcie/bookmarks?ao3_lost_found=deleted&page=2");
    expect(hrefs).toContain("/users/marcie/bookmarks?ao3_lost_found=deleted&page=3");
  });

  test("buildPager: none for a single page; previous/current/next on a middle page", () => {
    const locationRef = { pathname: "/users/marcie/bookmarks", search: "?ao3_lost_found=deleted&page=2" };
    expect(injection.buildPager(document, { total: 20, pageNumber: 1, locationRef })).toBeNull();

    const pager = injection.buildPager(document, { total: 45, pageNumber: 2, locationRef });
    expect(pager.querySelector("span.current").textContent).toBe("2");
    expect(pager.querySelector("a[rel='prev']").getAttribute("href")).toBe("/users/marcie/bookmarks?ao3_lost_found=deleted");
    expect(pager.querySelector("a[rel='next']").getAttribute("href")).toBe("/users/marcie/bookmarks?ao3_lost_found=deleted&page=3");
  });

  test("buildPager: long runs collapse into a window with gaps", () => {
    const locationRef = { pathname: "/users/marcie/bookmarks", search: "" };
    const pager = injection.buildPager(document, { total: 400, pageNumber: 10, locationRef });
    const labels = [...pager.querySelectorAll("li")].map((li) => li.textContent);
    expect(labels).toEqual(["← Previous", "1", "…", "8", "9", "10", "11", "12", "…", "20", "Next →"]);
  });
});

describe("Back button", () => {
  test("going back to the normal list reloads instead of leaving it empty", async () => {
    const { injector } = await loadInjector({ path: "/users/marcie/bookmarks?ao3_lost_found=deleted", owner: "marcie" });
    history.replaceState(null, "", "/users/marcie/bookmarks");
    const reload = jest.fn();

    await injector.handlePopState({ reload });

    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("going back into the Deleted view re-renders it without reloading", async () => {
    const { injector, sendMessage } = await loadInjector({ path: "/users/marcie/bookmarks", owner: "marcie" });
    history.replaceState(null, "", "/users/marcie/bookmarks?ao3_lost_found=deleted");
    const reload = jest.fn();

    await injector.handlePopState({ reload });

    expect(reload).not.toHaveBeenCalled();
    expect(sentTypes(sendMessage)).toContain(C.MSG.GET_LOST_WORKS_FILTER);
  });
});

describe("clicking the Deleted sidebar entry", () => {
  // Click the injected Deleted link; report whether our script took the click
  // over. The test then cancels the click itself so jsdom doesn't try to
  // navigate.
  function clickDeleted(init = {}) {
    const link = document.querySelector("a[data-ao3-lost-found-count='deleted']");
    let takenOver = null;
    const probe = (event) => { takenOver = event.defaultPrevented; event.preventDefault(); };
    window.addEventListener("click", probe);
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }));
    window.removeEventListener("click", probe);
    return takenOver;
  }

  test("on your profile it navigates normally instead of changing the URL in place", async () => {
    await loadInjector({ path: "/users/marcie", owner: "marcie", list: null });

    expect(clickDeleted()).toBe(false);
    expect(location.pathname).toBe("/users/marcie");
  });

  test("on your works page it navigates normally rather than replacing the works list", async () => {
    await loadInjector({ path: "/users/marcie/works", owner: "marcie", list: "work" });

    expect(clickDeleted()).toBe(false);
    expect(document.querySelector(".ao3-lost-found")).toBeNull();
  });

  test("on your bookmarks page it switches to the Deleted view in place", async () => {
    await loadInjector({ path: "/users/marcie/bookmarks", owner: "marcie" });

    expect(clickDeleted()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(location.search).toBe("?ao3_lost_found=deleted");
    expect(document.querySelector(".ao3-lost-found")).not.toBeNull();
  });

  test("Ctrl/Cmd-click and middle-click keep the browser's own behaviour", async () => {
    await loadInjector({ path: "/users/marcie/bookmarks", owner: "marcie" });

    expect(clickDeleted({ ctrlKey: true })).toBe(false);
    expect(clickDeleted({ metaKey: true })).toBe(false);
    expect(clickDeleted({ button: 1 })).toBe(false);
    expect(location.search).toBe("");
  });
});
