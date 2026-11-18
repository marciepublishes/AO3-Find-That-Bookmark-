(() => {
  const runtime = globalThis.browser || globalThis.chrome;
  const injection = globalThis.AO3LostAndFoundInjection;
  const C = globalThis.AO3LostAndFoundConstants;

  function getLoggedInUsername(documentRoot = document) {
    // The logged-in user's links live in the top header (#header) — the "Hi,
    // USERNAME!" dropdown and its menu — on every AO3 page, not just the
    // dashboard. Bookmark authors live in #main, so any /users/ link inside
    // #header belongs to the logged-in account. Older selectors are kept as
    // fallbacks. "logout"/"login" are excluded so we don't read /users/logout.
    const links = [
      ...documentRoot.querySelectorAll(
        "#header a[href^='/users/'], #greeting a[href^='/users/'], #user-navigation a[href^='/users/'], #user-menu a[href^='/users/']"
      )
    ];
    for (const link of links) {
      const match = link.getAttribute("href")?.match(/^\/users\/([^/?#]+)/);
      const name = match && decodeURIComponent(match[1]);
      if (name && name !== "logout" && name !== "login") {
        return name;
      }
    }
    return "";
  }

  function isOwnBookmarks() {
    const owner = injection.getUsernameFromPath(location);
    const me = getLoggedInUsername();
    return Boolean(owner && me && owner.toLowerCase() === me.toLowerCase());
  }

  function maybeStartAutoImport() {
    if (!runtime?.runtime?.sendMessage || !isOwnBookmarks()) return;

    // Fire-and-forget: the background decides whether an import is actually due.
    const me = getLoggedInUsername();
    runtime.runtime.sendMessage({ type: C.MSG.ENSURE_IMPORT, username: me }).catch(() => {});
  }

  // Capture the bookmark blurbs already on the page — no extra fetches. We parse
  // them here against the live DOM (more accurate and safer than shipping raw
  // HTML to the worker) and send structured records; the background merge-upserts
  // them, keeping records current as the user browses their own bookmarks.
  function snapshotVisibleBookmarks() {
    if (!runtime?.runtime?.sendMessage || !isOwnBookmarks()) return;

    const parser = globalThis.AO3LostAndFoundParser;
    if (!parser?.parseBlurbElement) return;

    const pageNumber = injection?.getPageNumber(location) || 1;
    const blurbEls = [...document.querySelectorAll("li.bookmark.blurb, li.work.blurb")]
      .filter((element) => !element.classList.contains("ao3-lost-found"));
    const pageSize = blurbEls.length || 20;

    const records = blurbEls
      .map((element, index) => parser.parseBlurbElement(element, {
        originalPosition: (pageNumber - 1) * pageSize + index + 1
      }))
      .filter(Boolean);
    if (records.length === 0) return;

    runtime.runtime
      .sendMessage({ type: C.MSG.SNAPSHOT_BOOKMARKS, records, username: getLoggedInUsername() })
      .catch(() => {});
  }

  function getRenderedWorkEntries(documentRoot = document) {
    return injection.getRenderedWorkEntries(documentRoot, location);
  }

  function getRenderedWorkIds(documentRoot = document) {
    return getRenderedWorkEntries(documentRoot).map((entry) => entry.workId);
  }

  async function requestMissingWorks(workIds, pageNumber, pageSize) {
    if (!runtime?.runtime?.sendMessage) {
      return [];
    }

    const response = await runtime.runtime.sendMessage({
      type: C.MSG.GET_DELETED_WORKS,
      workIds,
      pageNumber,
      pageSize
    });

    return response?.works || [];
  }

  async function requestFilteredWorks(status, pageNumber, pageSize) {
    if (!runtime?.runtime?.sendMessage) {
      return { works: [], total: 0, pageNumber, pageSize };
    }

    const response = await runtime.runtime.sendMessage({
      type: C.MSG.GET_LOST_WORKS_FILTER,
      status,
      pageNumber,
      pageSize
    });

    return response || { works: [], total: 0, pageNumber, pageSize };
  }

  async function setPinnedTop(workId, value) {
    const response = await runtime.runtime.sendMessage({
      type: C.MSG.SET_PINNED_TOP,
      workId,
      value
    });

    if (!response?.success) {
      throw new Error(response?.error || "Unable to update pinned state.");
    }
  }

  async function getSettings() {
    if (!runtime?.runtime?.sendMessage) return {};
    const response = await runtime.runtime.sendMessage({ type: C.MSG.GET_SETTINGS });
    return response || {};
  }

  async function getStats() {
    if (!runtime?.runtime?.sendMessage) return {};
    try {
      const response = await runtime.runtime.sendMessage({ type: C.MSG.GET_STATS });
      return response || {};
    } catch (error) {
      console.warn("AO3 Lost and Found could not load dashboard counts.", error);
      return {};
    }
  }

  function removeExistingInjectedBlurbs(documentRoot = document) {
    documentRoot.querySelectorAll(".ao3-lost-found").forEach((element) => element.remove());
  }

  function ensureDashboardSection(counts = {}) {
    if (injection.injectDashboardSection(document, location, counts)) return;
    if (document.querySelector("#dashboard")) return;

    const observer = new MutationObserver(() => {
      if (injection.injectDashboardSection(document, location, counts)) {
        observer.disconnect();
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function attachDashboardLinkInterceptor() {
    const dashboard = document.querySelector("#dashboard");
    if (!dashboard || dashboard.dataset.ao3LostFoundInterceptor === "true") return;

    dashboard.dataset.ao3LostFoundInterceptor = "true";
    dashboard.addEventListener("click", async (event) => {
      const link = event.target?.closest?.("a");
      if (!link) return;

      const status = injection.getDashboardLinkStatus(link.textContent);
      if (!status) return;

      event.preventDefault();
      await switchToLostFoundFilter(status);
    });
  }

  async function switchToLostFoundFilter(status) {
    const nextUrl = injection.buildLostFoundFilterUrl(status, location);
    history.pushState({ ao3LostFound: status }, "", nextUrl);

    // The URL changed without a page load, so rebuild our dashboard item now.
    // This turns Deleted from an <a> into AO3's native <span class="current">.
    const stats = await getStats();
    ensureDashboardSection({ deleted: stats.deleted });

    const list = injection.getBookmarksList(document);
    if (!list) return;

    const settings = await getSettings();
    removeExistingInjectedBlurbs(document);
    await renderFilteredLostWorks(list, status, settings);
  }

  function attachReturnHandler(blurb, work, list, renderedEntries) {
    const button = blurb.querySelector(".ao3-lost-found__return");
    button?.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await setPinnedTop(work.workId, false);
        const movedWork = { ...work, pinnedToTop: false };
        blurb.remove();
        injection.placeBlurb(list, blurb, movedWork, renderedEntries);
      } catch (error) {
        console.warn("AO3 Lost and Found could not move this work.", error);
      } finally {
        button.disabled = false;
      }
    });
  }

  async function renderFilteredLostWorks(list, status, settings) {
    const pageNumber = injection.getPageNumber(location);
    const pageSize = 20;
    const result = await requestFilteredWorks(status, pageNumber, pageSize);
    const works = result.works || [];

    list.innerHTML = "";
    works.forEach((work) => {
      const blurb = injection.reconstructBlurb(work, document, { showReturnButton: false });
      list.append(blurb);
    });

    if (works.length === 0) {
      const empty = document.createElement("li");
      empty.className = "ao3-lost-found-empty";
      empty.textContent = "No deleted works found yet.";
      list.append(empty);
    }

    injection.injectStyles(document, settings);
    injection.updateFilteredHeading(document, {
      status,
      total: result.total || 0,
      pageNumber: result.pageNumber || pageNumber,
      pageSize: result.pageSize || pageSize,
      username: injection.getUsernameFromPath(location)
    });
    injection.enableBookmarksReturnLink(document, location);

    document.querySelectorAll(".pagination").forEach((element) => element.remove());

    // Opening this deleted-works view IS the acknowledgement: clear the "new"
    // alert and the toolbar badge now that the user is actually looking at them.
    runtime?.runtime?.sendMessage?.({ type: C.MSG.ACKNOWLEDGE_LOST }).catch(() => {});
  }

  window.addEventListener("popstate", async () => {
    const filterStatus = injection.getLostFoundFilter(location);
    const list = injection.getBookmarksList(document);
    if (!list) return;

    if (filterStatus) {
      await renderFilteredLostWorks(list, filterStatus, await getSettings());
    }
  });

  async function init() {
    if (!injection) {
      console.warn("AO3 Lost and Found injection helpers are unavailable.");
      return;
    }

    ensureDashboardSection({ deleted: 0 });
    attachDashboardLinkInterceptor();
    getStats().then((stats) => {
      ensureDashboardSection({ deleted: stats.deleted });
      attachDashboardLinkInterceptor();
    });

    if (!/^\/users\/[^/]+\/bookmarks(?:\/|$)/.test(location.pathname)) {
      return;
    }

    maybeStartAutoImport();
    snapshotVisibleBookmarks();

    const list = injection.getBookmarksList(document);
    if (!list) return;

    const settings = await getSettings();
    injection.injectStyles(document, settings);
    removeExistingInjectedBlurbs(document);

    const filterStatus = injection.getLostFoundFilter(location);
    if (injection.shouldRenderLostFoundView(location)) {
      await renderFilteredLostWorks(list, filterStatus, settings);
      return;
    }

    // Normal AO3 bookmark pages stay visually untouched. Deleted records are
    // reconstructed only in the explicit Lost and Found filtered view.
  }

  init().catch((error) => {
    console.warn("AO3 Lost and Found injector failed to initialize.", error);
  });

  globalThis.ao3LostAndFoundInjector = {
    getLoggedInUsername,
    isOwnBookmarks,
    maybeStartAutoImport,
    snapshotVisibleBookmarks,
    getRenderedWorkEntries,
    getRenderedWorkIds,
    requestFilteredWorks,
    requestMissingWorks,
    renderFilteredLostWorks,
    switchToLostFoundFilter,
    ensureDashboardSection,
    attachDashboardLinkInterceptor,
    getSettings,
    getStats,
    setPinnedTop
  };
})();
