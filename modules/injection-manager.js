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

function reconstructBlurb(work, documentRef = globalThis.document) {
  const item = documentRef.createElement("li");
  const status = work.status === STATUS.ORPHANED ? STATUS.ORPHANED : STATUS.DELETED;
  const detectedAt = status === STATUS.ORPHANED ? work.orphanedAt : work.deletedAt;
  const statusLabel = status === STATUS.ORPHANED ? "Recently Orphaned" : "Deleted";
  const tagLabel = status === STATUS.ORPHANED ? "Orphaned Work" : "Deleted Work";

  item.className = `bookmark blurb group ao3-lost-found ao3-lost-found--${status}`;
  item.dataset.workId = work.workId;
  item.dataset.originalPosition = String(work.originalPosition ?? "");
  item.innerHTML = `
    <div class="header module">
      <h4 class="heading">
        <a href="https://archiveofourown.org/works/${encodeURIComponent(work.workId)}">${escapeHtml(work.title || "Untitled work")}</a>
        by ${authorLinks(work.authors)}
      </h4>
      <h5 class="fandoms heading">${tagLinks(work.fandoms)}</h5>
      <ul class="required-tags">
        ${work.rating ? `<li><a class="rating tag">${escapeHtml(work.rating)}</a></li>` : ""}
        ${(work.warnings || []).map((tag) => `<li><a class="warning tag">${escapeHtml(tag)}</a></li>`).join("")}
        ${(work.categories || []).map((tag) => `<li><a class="category tag">${escapeHtml(tag)}</a></li>`).join("")}
      </ul>
    </div>
    <p class="ao3-lost-found__status">
      <span class="ao3-lost-found__badge">${statusLabel}</span>
      <span>Detected: ${escapeHtml(formatDate(detectedAt))}</span>
    </p>
    <h6 class="landmark heading">Tags</h6>
    <ul class="tags commas">
      ${(work.relationships || []).map((tag) => `<li><a class="tag">${escapeHtml(tag)}</a></li>`).join("")}
      ${(work.characters || []).map((tag) => `<li><a class="tag">${escapeHtml(tag)}</a></li>`).join("")}
      ${(work.freeTags || []).map((tag) => `<li><a class="tag">${escapeHtml(tag)}</a></li>`).join("")}
      <li><a class="tag">${tagLabel}</a></li>
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
      <button class="ao3-lost-found__return" type="button">Return to original position</button>
    </p>
  `;

  return item;
}

function injectStyles(documentRef = globalThis.document, settings = {}) {
  const existing = documentRef.getElementById("ao3-lost-found-styles");
  if (existing) existing.remove();

  const deletedColor = sanitizeColor(settings.deletedColor, "#e089a0");
  const orphanedColor = sanitizeColor(settings.orphanedColor, "#9d89e0");

  const style = documentRef.createElement("style");
  style.id = "ao3-lost-found-styles";
  style.textContent = `
    .ao3-lost-found {
      border: 2px solid ${deletedColor};
      box-shadow: 0 0 12px ${deletedColor};
      background: #cce089;
      color: #1c1a17;
      padding: 0.75em;
      position: relative;
    }
    .ao3-lost-found--orphaned {
      border-color: ${orphanedColor};
      box-shadow: 0 0 12px ${orphanedColor};
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
      color: #1c1a17;
      background: ${deletedColor};
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .ao3-lost-found--orphaned .ao3-lost-found__badge {
      color: #1c1a17;
      background: ${orphanedColor};
    }
    .ao3-lost-found__return {
      border: 1px solid currentColor;
      border-radius: 4px;
      padding: 0.2em 0.55em;
      background: transparent;
      color: inherit;
      cursor: pointer;
      font: inherit;
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
  const orphanedItem = createDashboardItem(documentRef, STATUS.ORPHANED, "Orphaned", counts.orphaned, locationRef);

  // Drop them directly beneath the "Gifts" entry (which lives in the listing
  // list, not the first nav list). Fall back to the first nav list otherwise.
  const giftsItem = findNavItemByHref(dashboard, "/gifts");
  const targetList = giftsItem?.parentNode || dashboard.querySelector("ul.navigation.actions");
  if (!targetList) {
    return false;
  }

  if (giftsItem) {
    targetList.insertBefore(deletedItem, giftsItem.nextSibling);
    targetList.insertBefore(orphanedItem, deletedItem.nextSibling);
  } else {
    targetList.append(deletedItem, orphanedItem);
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

  const link = documentRef.createElement("a");
  link.href = buildLostFoundFilterUrl(status, locationRef);
  link.dataset.ao3LostFoundCount = status;
  link.textContent = formatDashboardLabel(label, count);

  item.append(link);
  return item;
}

function updateDashboardCounts(dashboard, counts = {}) {
  const links = [...dashboard.querySelectorAll("a")];
  const deletedLink = dashboard.querySelector("[data-ao3-lost-found-count='deleted']")
    || links.find((link) => getDashboardLinkStatus(link.textContent) === STATUS.DELETED);
  const orphanedLink = dashboard.querySelector("[data-ao3-lost-found-count='orphaned']")
    || links.find((link) => getDashboardLinkStatus(link.textContent) === STATUS.ORPHANED);

  if (deletedLink) {
    deletedLink.dataset.ao3LostFoundCount = STATUS.DELETED;
    deletedLink.textContent = formatDashboardLabel("Deleted", counts.deleted);
  }
  if (orphanedLink) {
    orphanedLink.dataset.ao3LostFoundCount = STATUS.ORPHANED;
    orphanedLink.textContent = formatDashboardLabel("Orphaned", counts.orphaned);
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
  const normalizedStatus = status === STATUS.ORPHANED ? STATUS.ORPHANED : STATUS.DELETED;
  const match = String(locationRef.pathname || "").match(/^\/users\/([^/]+)/);
  const username = match?.[1] || getUsernameFromPath(locationRef);

  return `/users/${username}/bookmarks?ao3_lost_found=${normalizedStatus}`;
}

function getDashboardLinkStatus(text) {
  const label = String(text || "").trim();
  if (/^deleted(?:\s+work)?(?:\s*\(\d+\))?$/i.test(label)) return STATUS.DELETED;
  if (/^orphaned(?:\s+work)?(?:\s*\(\d+\))?$/i.test(label)) return STATUS.ORPHANED;
  return null;
}

function getLostFoundFilter(locationRef = globalThis.location) {
  const params = new URLSearchParams(locationRef.search || "");
  const status = params.get("ao3_lost_found");
  return status === STATUS.DELETED || status === STATUS.ORPHANED ? status : null;
}

function updateFilteredHeading(documentRef, { status, total, pageNumber, pageSize, username }) {
  const heading = documentRef.querySelector("#main h2.heading, .bookmarks-index h2.heading, h2.heading");
  if (!heading) return false;

  heading.textContent = formatFilteredHeading({ status, total, pageNumber, pageSize, username });
  return true;
}

function formatFilteredHeading({ status, total, pageNumber = 1, pageSize = 20, username = "" }) {
  const label = status === STATUS.ORPHANED ? "found orphaned works" : "found deleted works";
  const count = Number(total) || 0;
  const userText = username ? ` in ${username}'s bookmarks` : "";

  if (count === 0) {
    return `0 ${label}${userText}`;
  }

  const start = ((Number(pageNumber) || 1) - 1) * (Number(pageSize) || 20) + 1;
  const end = Math.min(count, start + (Number(pageSize) || 20) - 1);
  return `${start} - ${end} of ${count} ${label}${userText}`;
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
  formatFilteredHeading,
  formatDashboardLabel,
  getBookmarksList,
  getDashboardLinkStatus,
  getLostFoundFilter,
  getPageNumber,
  getPageSize,
  getUsernameFromPath,
  injectDashboardSection,
  injectStyles,
  placeBlurb,
  reconstructBlurb,
  updateDashboardCounts,
  updateFilteredHeading,
  waybackUrl
};

if (typeof module !== "undefined") {
  module.exports = globalThis.AO3LostAndFoundInjection;
}
