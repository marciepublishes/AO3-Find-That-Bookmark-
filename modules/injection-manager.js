/**
 * InjectionManager contract:
 * Input:
 * - Current-page work records returned by background message passing.
 * - A document-like object for DOM construction.
 * Output:
 * - Reconstructed AO3-style bookmark blurbs.
 * - Placement helpers for pinned and original-position injection.
 *
 * This module never imports db.js and never touches IndexedDB. All reads and
 * writes are performed by background.js through runtime messages.
 */
const Constants = globalThis.AO3LostAndFoundConstants
  || (typeof require === "function" ? require("./constants") : {});
const { STATUS } = Constants;

function reconstructBlurb(work, documentRef = globalThis.document, { showReturnButton = true } = {}) {
  const item = documentRef.createElement("li");
  const detectedAt = work.deletedAt;

  item.className = `bookmark blurb group ao3-lost-found ao3-lost-found--${STATUS.DELETED}`;
  item.dataset.workId = work.workId;
  item.dataset.originalPosition = String(work.originalPosition ?? "");
  item.innerHTML = `
    <div class="header module">
      <h4 class="heading">
        <a href="https://archiveofourown.org/works/${encodeURIComponent(work.workId)}">${escapeHtml(work.title || "Untitled work")}</a>
        by ${authorLinks(work.authors)}
      </h4>
      <h5 class="fandoms heading">${tagLinks(work.fandoms)}</h5>
      <ul class="ao3-lost-found__required">
        ${work.rating ? `<li class="ao3-lost-found__req ao3-lost-found__req--rating">${escapeHtml(work.rating)}</li>` : ""}
        ${(work.warnings || []).map((tag) => `<li class="ao3-lost-found__req ao3-lost-found__req--warning">${escapeHtml(tag)}</li>`).join("")}
        ${(work.categories || []).map((tag) => `<li class="ao3-lost-found__req ao3-lost-found__req--category">${escapeHtml(tag)}</li>`).join("")}
      </ul>
    </div>
    <p class="ao3-lost-found__status">
      <span class="ao3-lost-found__badge">Deleted</span>
      <span>Detected: ${escapeHtml(formatDate(detectedAt))}</span>
    </p>
    <h6 class="landmark heading">Tags</h6>
    <ul class="tags commas">
      ${(work.relationships || []).map((tag) => `<li><a class="tag">${escapeHtml(tag)}</a></li>`).join("")}
      ${(work.characters || []).map((tag) => `<li><a class="tag">${escapeHtml(tag)}</a></li>`).join("")}
      ${(work.freeTags || []).map((tag) => `<li><a class="tag">${escapeHtml(tag)}</a></li>`).join("")}
      <li><a class="tag">Deleted Work</a></li>
    </ul>
    <blockquote class="userstuff summary">${escapeHtml(work.summary || "")}</blockquote>
    <dl class="stats">
      <dt>Words:</dt><dd>${escapeHtml(formatNumber(work.wordCount || 0))}</dd>
      <dt>Chapters:</dt><dd>${escapeHtml(work.chapters || "")}</dd>
      ${work.workLastUpdated ? `<dt>Updated:</dt><dd>${escapeHtml(work.workLastUpdated)}</dd>` : ""}
    </dl>
    <div class="user module group">
      ${work.bookmarkNotes ? `<blockquote class="userstuff notes">${escapeHtml(work.bookmarkNotes)}</blockquote>` : ""}
      ${bookmarkTags(work.bookmarkTags)}
      ${work.dateBookmarked ? `<p class="datetime">${escapeHtml(work.dateBookmarked)}</p>` : ""}
    </div>
    <p class="ao3-lost-found__actions">
      <a class="ao3-lost-found__wayback" href="${waybackUrl(work.workId)}" target="_blank" rel="noreferrer">Search Wayback Machine</a>
      ${showReturnButton ? '<button class="ao3-lost-found__return" type="button">Return to original position</button>' : ""}
    </p>
  `;

  return item;
}

function injectStyles(documentRef = globalThis.document, settings = {}) {
  const existing = documentRef.getElementById("ao3-lost-found-styles");
  if (existing) existing.remove();

  const deletedColor = sanitizeColor(settings.deletedColor, "#41653E");

  const style = documentRef.createElement("style");
  style.id = "ao3-lost-found-styles";
  style.textContent = `
    .ao3-lost-found {
      border: 2px solid ${deletedColor};
      background: #A8BBA9;
      color: #1c1a17;
      padding: 0.75em;
      position: relative;
    }
    /* Our own required-tags row. AO3's ul.required-tags styles each <li> as a
       fixed-size sprite icon slot and hides the label text; reusing that class
       made long labels (e.g. "Creator Chose Not To Use Archive Warnings")
       overflow the slot and overlap the neighbouring icons. This is a plain,
       wrapping pill row that AO3's icon CSS can't touch. */
    .ao3-lost-found__required {
      display: flex;
      flex-wrap: wrap;
      gap: 0.35em;
      margin: 0.4em 0;
      padding: 0;
      list-style: none;
    }
    .ao3-lost-found__req {
      display: inline-block;
      padding: 0.1em 0.55em;
      border: 1px solid rgba(65, 101, 62, 0.4);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.4);
      color: #34412f;
      font-size: 0.85em;
      line-height: 1.4;
      white-space: normal;
    }
    .ao3-lost-found__status,
    .ao3-lost-found__actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.6em;
      align-items: center;
      margin: 0.5em 0;
    }
    .ao3-lost-found__badge {
      border-radius: 4px;
      padding: 0.2em 0.45em;
      color: #A8BBA9;
      background: ${deletedColor};
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .ao3-lost-found__wayback {
      color: #41653E;
      font-weight: 600;
    }
    .ao3-lost-found__return {
      border: none;
      border-radius: 4px;
      padding: 0.25em 0.7em;
      background: #41653E;
      color: #A8BBA9;
      cursor: pointer;
      font: inherit;
      font-weight: 600;
    }
    .ao3-lost-found__return:hover {
      opacity: 0.85;
    }
  `;
  documentRef.head.append(style);
}

function injectDashboardSection(documentRef = globalThis.document, locationRef = globalThis.location, counts = {}) {
  const dashboard = documentRef.querySelector("#dashboard");
  if (!dashboard) {
    return false;
  }

  // Clear any items we injected on a previous pass (the dashboard has several
  // ul.navigation.actions lists, so search the whole region).
  dashboard.querySelectorAll("li[data-ao3-lost-found-dashboard='true']").forEach((element) => element.remove());

  const deletedItem = createDashboardItem(documentRef, STATUS.DELETED, "Deleted", counts.deleted, locationRef);

  // Drop it directly beneath the "Gifts" entry (which lives in the listing
  // list, not the first nav list). Fall back to the first nav list otherwise.
  const giftsItem = findNavItemByHref(dashboard, "/gifts");
  const targetList = giftsItem?.parentNode || dashboard.querySelector("ul.navigation.actions");
  if (!targetList) {
    return false;
  }

  if (giftsItem) {
    targetList.insertBefore(deletedItem, giftsItem.nextSibling);
  } else {
    targetList.append(deletedItem);
  }
  return true;
}

function findNavItemByHref(root, hrefSuffix) {
  const pattern = new RegExp(`${escapeRegExp(hrefSuffix)}(?:[/?#]|$)`, "i");
  const link = [...root.querySelectorAll("a")]
    .find((anchor) => pattern.test(anchor.getAttribute("href") || ""));
  return link?.closest?.("li") || null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createDashboardItem(documentRef, status, label, count, locationRef) {
  const item = documentRef.createElement("li");
  item.dataset.ao3LostFoundDashboard = "true";

  const isCurrent = getLostFoundFilter(locationRef) === status;
  const control = documentRef.createElement(isCurrent ? "span" : "a");
  if (isCurrent) {
    control.className = "current";
  } else {
    control.href = buildLostFoundFilterUrl(status, locationRef);
  }
  control.dataset.ao3LostFoundCount = status;
  control.textContent = formatDashboardLabel(label, count);

  item.append(control);
  return item;
}

function updateDashboardCounts(dashboard, counts = {}) {
  const links = [...dashboard.querySelectorAll("a")];
  const deletedLink = dashboard.querySelector("[data-ao3-lost-found-count='deleted']")
    || links.find((link) => getDashboardLinkStatus(link.textContent) === STATUS.DELETED);

  if (deletedLink) {
    deletedLink.dataset.ao3LostFoundCount = STATUS.DELETED;
    deletedLink.textContent = formatDashboardLabel("Deleted", counts.deleted);
  }
}

function formatDashboardLabel(label, count) {
  return `${label} (${Number(count) || 0})`;
}

function buildBookmarkTagUrl(tagName, locationRef = globalThis.location) {
  const status = getDashboardLinkStatus(tagName) || STATUS.DELETED;
  return buildLostFoundFilterUrl(status, locationRef);
}

function buildLostFoundFilterUrl(status, locationRef = globalThis.location) {
  const match = String(locationRef.pathname || "").match(/^\/users\/([^/]+)/);
  const username = match?.[1] || getUsernameFromPath(locationRef);

  return `/users/${username}/bookmarks?ao3_lost_found=${STATUS.DELETED}`;
}

function getDashboardLinkStatus(text) {
  const label = String(text || "").trim();
  if (/^deleted(?:\s+work)?(?:\s*\(\d+\))?$/i.test(label)) return STATUS.DELETED;
  return null;
}

function getLostFoundFilter(locationRef = globalThis.location) {
  const params = new URLSearchParams(locationRef.search || "");
  return params.get("ao3_lost_found") === STATUS.DELETED ? STATUS.DELETED : null;
}

function shouldRenderLostFoundView(locationRef = globalThis.location) {
  return getLostFoundFilter(locationRef) === STATUS.DELETED;
}

function enableBookmarksReturnLink(documentRef = globalThis.document, locationRef = globalThis.location) {
  if (!shouldRenderLostFoundView(locationRef)) return false;

  const dashboard = documentRef.querySelector("#dashboard");
  if (!dashboard) return false;

  const current = [...dashboard.querySelectorAll("span.current")]
    .find((element) => /^bookmarks(?:\s*\(\d+\))?$/i.test(element.textContent.trim()));
  if (!current) return false;

  const link = documentRef.createElement("a");
  link.href = `/users/${encodeURIComponent(getUsernameFromPath(locationRef))}/bookmarks`;
  link.textContent = current.textContent;
  link.dataset.ao3LostFoundReturn = "bookmarks";
  current.replaceWith(link);
  return true;
}

function updateFilteredHeading(documentRef, { status, total, pageNumber, pageSize, username }) {
  const heading = documentRef.querySelector("#main h2.heading, .bookmarks-index h2.heading, h2.heading");
  if (!heading) return false;

  heading.textContent = formatFilteredHeading({ status, total, pageNumber, pageSize, username });
  return true;
}

function formatFilteredHeading({ total, pageNumber = 1, pageSize = 20, username = "" }) {
  const label = "found deleted works";
  const count = Number(total) || 0;
  const userText = username ? ` in ${username}'s bookmarks` : "";

  if (count === 0) {
    return `0 ${label}${userText}`;
  }

  const start = ((Number(pageNumber) || 1) - 1) * (Number(pageSize) || 20) + 1;
  const end = Math.min(count, start + (Number(pageSize) || 20) - 1);
  return `${start} - ${end} of ${count} ${label}${userText}`;
}

// The logged-in user, read from AO3's top header ("Hi, NAME!" menu), which is
// on every page. Bookmark authors live in #main, so any /users/ link in the
// header belongs to the logged-in account. "login"/"logout" are not names.
function getLoggedInUsername(documentRef = globalThis.document) {
  const links = [
    ...documentRef.querySelectorAll(
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

// True on the logged-in user's own /users/<name>/... pages only. The Deleted
// sidebar entry and view show *your* records, so they never appear on someone
// else's profile.
function isOwnUserPage(documentRef = globalThis.document, locationRef = globalThis.location) {
  const owner = getUsernameFromPath(locationRef);
  const me = getLoggedInUsername(documentRef);
  return Boolean(owner && me && owner.toLowerCase() === me.toLowerCase());
}

// AO3-style pager for the Deleted view (AO3's own pagination is removed there
// because it pages the real bookmarks, not ours). Null when one page is enough.
function buildPager(documentRef, { total, pageNumber = 1, pageSize = 20, locationRef = globalThis.location } = {}) {
  const size = Math.max(1, Number(pageSize) || 20);
  const pages = Math.ceil((Number(total) || 0) / size);
  if (pages <= 1) return null;

  const current = Math.min(Math.max(1, Number(pageNumber) || 1), pages);
  const base = buildLostFoundFilterUrl(STATUS.DELETED, locationRef);
  const href = (page) => (page === 1 ? base : `${base}&page=${page}`);

  const pager = documentRef.createElement("ol");
  pager.className = "pagination actions ao3-lost-found-pager";
  pager.setAttribute("role", "navigation");
  pager.setAttribute("aria-label", "Deleted works pages");

  const addItem = (className, build) => {
    const li = documentRef.createElement("li");
    if (className) li.className = className;
    li.append(build());
    pager.append(li);
  };
  const link = (page, text, rel) => () => {
    const a = documentRef.createElement("a");
    a.href = href(page);
    a.textContent = text;
    if (rel) a.rel = rel;
    return a;
  };
  const span = (text, className) => () => {
    const s = documentRef.createElement("span");
    s.className = className;
    s.textContent = text;
    return s;
  };

  addItem("previous", current > 1 ? link(current - 1, "← Previous", "prev") : span("← Previous", "disabled"));

  // Every page when there are few; otherwise first, last, and a window
  // around the current page, with gaps between.
  const shown = new Set([1, pages]);
  for (let page = current - 2; page <= current + 2; page += 1) {
    if (page >= 1 && page <= pages) shown.add(page);
  }
  if (pages <= 9) for (let page = 1; page <= pages; page += 1) shown.add(page);

  let previous = 0;
  [...shown].sort((a, b) => a - b).forEach((page) => {
    if (page - previous > 1) addItem("gap", span("…", "gap"));
    addItem("", page === current ? span(String(page), "current") : link(page, String(page)));
    previous = page;
  });

  addItem("next", current < pages ? link(current + 1, "Next →", "next") : span("Next →", "disabled"));
  return pager;
}

// Back/forward between the Deleted view and the normal list. The Deleted view
// replaces AO3's list in place, so going back to the normal URL needs a real
// reload to get AO3's own list back. Returns what it did, for tests.
async function handleFilterPopState({ locationRef = globalThis.location, renderFiltered, reload }) {
  const filterStatus = getLostFoundFilter(locationRef);
  if (filterStatus) {
    await renderFiltered(filterStatus);
    return "rendered";
  }
  reload();
  return "reloaded";
}

function getUsernameFromPath(locationRef = globalThis.location) {
  const match = String(locationRef.pathname || "").match(/^\/users\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

function placeBlurb(list, blurb, work, renderedPositions = []) {
  if (work.pinnedToTop) {
    list.prepend(blurb);
    return;
  }

  const originalPosition = Number(work.originalPosition) || 0;
  const beforeElement = renderedPositions.find((entry) => entry.position >= originalPosition)?.element || null;
  if (beforeElement) {
    list.insertBefore(blurb, beforeElement);
  } else {
    list.append(blurb);
  }
}

function getBookmarksList(documentRef = globalThis.document) {
  return documentRef.querySelector("ol.bookmark.index.group, ol.work.index.group, ol.index.group, ul.bookmark.index.group, ul.work.index.group");
}

function getPageNumber(locationRef = globalThis.location) {
  const params = new URLSearchParams(locationRef.search || "");
  return Number(params.get("page")) || 1;
}

function getPageSize(renderedCount) {
  return renderedCount > 0 ? renderedCount : 20;
}

// 1-based position in the whole bookmark list of the blurb at `index` on
// `pageNumber`. AO3 always pages bookmarks at 20, so a short last page must
// not shrink the page size (page 3 starts at 41, however many blurbs render).
function positionOnPage(pageNumber, index) {
  const perPage = Constants.BOOKMARKS_PER_PAGE || 20;
  return ((Number(pageNumber) || 1) - 1) * perPage + index + 1;
}

// The work id for a rendered blurb. AO3 puts it in a `work-<id>` class on the
// <li> (the element id is `bookmark_<bookmarkId>`, NOT the work id). Falls back
// to the title link inside the heading.
function workIdFromBlurb(element) {
  if (!element) return "";
  const fromClass = (String(element.className || "").match(/\bwork-(\d+)\b/) || [])[1];
  if (fromClass) return fromClass;
  // Scope to a direct heading link so the status "N Bookmarks" count link
  // (/works/<id>/bookmarks) and other extensions' injected links don't win.
  const link = element.querySelector?.("h4.heading > a[href^='/works/']")
    || element.querySelector?.("h4.heading a[href^='/works/']");
  const href = link?.getAttribute?.("href") || "";
  return (href.match(/\/works\/(\d+)/) || [])[1] || "";
}

// The still-rendered (alive) bookmark blurbs on the current page, with their
// work ids and 1-based positions, used to place injected deleted blurbs back at
// their original spots. Excludes our own injected blurbs.
function getRenderedWorkEntries(documentRef = globalThis.document, locationRef = globalThis.location) {
  const blurbs = [...documentRef.querySelectorAll("li.bookmark.blurb, li.work.blurb")]
    .filter((element) => !element.classList?.contains("ao3-lost-found"));
  const pageNumber = getPageNumber(locationRef);

  return blurbs
    .map((element, index) => ({
      element,
      workId: workIdFromBlurb(element),
      position: positionOnPage(pageNumber, index)
    }))
    .filter((entry) => entry.workId);
}

function waybackUrl(workId) {
  return `https://web.archive.org/web/*/archiveofourown.org/works/${encodeURIComponent(workId)}`;
}

function authorLinks(authors) {
  const names = Array.isArray(authors) && authors.length ? authors : ["Unknown author"];
  return names.map((author) => `<span class="ao3-lost-found__author">${escapeHtml(author)}</span>`).join(", ");
}

function tagLinks(tags) {
  return (tags || []).map((tag) => `<a class="tag">${escapeHtml(tag)}</a>`).join(", ");
}

function bookmarkTags(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return "";
  return `<ul class="meta group commas">${tags.map((tag) => `<li><a class="tag">${escapeHtml(tag)}</a></li>`).join("")}</ul>`;
}

function formatDate(value) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString();
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function sanitizeColor(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value) : fallback;
}

globalThis.AO3LostAndFoundInjection = {
  buildBookmarkTagUrl,
  buildLostFoundFilterUrl,
  enableBookmarksReturnLink,
  formatFilteredHeading,
  formatDashboardLabel,
  getBookmarksList,
  getDashboardLinkStatus,
  getLostFoundFilter,
  getPageNumber,
  getPageSize,
  getRenderedWorkEntries,
  getLoggedInUsername,
  getUsernameFromPath,
  buildPager,
  handleFilterPopState,
  isOwnUserPage,
  workIdFromBlurb,
  injectDashboardSection,
  injectStyles,
  placeBlurb,
  positionOnPage,
  reconstructBlurb,
  shouldRenderLostFoundView,
  updateDashboardCounts,
  updateFilteredHeading,
  waybackUrl
};

if (typeof module !== "undefined") {
  module.exports = globalThis.AO3LostAndFoundInjection;
}
