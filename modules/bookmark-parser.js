/**
 * Shared bookmark parser for AO3 Find That Bookmark.
 *
 * Turns an AO3 bookmark "blurb" into the canonical work record produced by
 * createWorkRecord(). Every parse path funnels through createWorkRecord, so the
 * database shape and the merge logic in import-manager's writeChunk() never have
 * to care which path produced a record.
 *
 * ── Two parse paths, on purpose ───────────────────────────────────────────────
 * There are two contexts that need to read a bookmark, and they differ in
 * whether a DOM is available:
 *
 *   1. parseBookmarkHtml / parseBookmarkPage (regex). Used by the background
 *      import walk, which fetch()es listing pages itself. Chrome MV3 service
 *      workers have no `DOMParser`, so the worker's only option is regex over
 *      the HTML string.
 *
 *   2. parseBlurbElement (DOM). Used by the content-script snapshot path, which
 *      already has the live page in a real DOM. DOM reads are more accurate
 *      (AO3's own classes carry tag type, completion, etc.) and safer
 *      (textContent can't inject markup and decodes entities for free), and
 *      they shrug off DOM injected by *other* AO3 extensions because they key
 *      off AO3's structural classes rather than text.
 *
 * Both paths target the same real AO3 markup, in particular:
 *   • required tags are symbol spans: <span class="rating-… rating" title="…">,
 *     <span class="warning-… warnings">, <span class="category-… category">.
 *     Categories appear ONLY here and are comma-joined ("Gen, M/M").
 *   • the free-tag list <ul class="tags commas"> carries warnings, relationships,
 *     characters and freeforms as <li class="warnings|relationships|characters|
 *     freeforms">, each the cleaner per-item source for those fields.
 *   • there are TWO <p class="datetime">: the work date in .header.module and the
 *     bookmark date in .user.module — the bookmark date is the later one.
 *   • summaries may contain NESTED <blockquote>, so a naive non-greedy match
 *     truncates them.
 *
 * ── Future: giving the worker a real DOM (the "third prong") ──────────────────
 * To retire the regex path on the import walk too, the worker would need a DOM.
 * The portable approach differs by browser:
 *   • Chrome (MV3 service worker): use chrome.offscreen to DOMParser the fetched
 *     HTML in a hidden offscreen document and pass records back. Deferred to its
 *     own change because it adds an offscreen-document lifecycle to manage.
 *   • Firefox (MV3): the background is an event page with a real DOM, so it can
 *     `new DOMParser().parseFromString(html, "text/html")` directly — no
 *     offscreen document needed. A future DOM-in-worker parser should branch on
 *     this rather than assuming the Chrome offscreen path everywhere.
 *
 * Loaded as a plain script (no bundler) via an IIFE so none of its internal
 * bindings leak into the shared global scope — that keeps it collision-free both
 * in the worker (alongside import/check managers) and in the content script
 * (alongside injection-manager).
 */
(function () {
  const Constants = globalThis.AO3LostAndFoundConstants
    || (typeof require === "function" ? require("./constants") : {});
  const { STATUS } = Constants;

  // ── DOM path (content script) ───────────────────────────────────────────────
  // Reads a live <li> bookmark blurb. Selectors are anchored on AO3's own
  // classes/structure so DOM injected by other extensions (badges, hide menus)
  // is invisible to us.
  function parseBlurbElement(li, { originalPosition = 1 } = {}) {
    if (!li || typeof li.querySelector !== "function") return null;

    const text = (el) => cleanText(el ? el.textContent : "");
    const texts = (selector, root = li) =>
      [...root.querySelectorAll(selector)].map((el) => text(el)).filter(Boolean);

    // The title link is a direct child of h4.heading; injected work links (e.g.
    // an extension's "Ch. 14/14" link) are nested in spans and use absolute
    // URLs, so the direct-child + leading-"/works/" selector skips them.
    const workLink = li.querySelector("h4.heading > a[href^='/works/']")
      || li.querySelector("h4.heading a[href^='/works/']");
    const workId = workLink && (workLink.getAttribute("href").match(/\/works\/(\d+)/) || [])[1];
    if (!workId) return null; // series / external bookmarks: skip cleanly

    const headerModule = li.querySelector(".header.module");
    const userModule = li.querySelector(".user.module");

    // Categories live only in the required-tags symbol, comma-joined.
    const categorySpan = li.querySelector("ul.required-tags span.category");
    const categories = categorySpan ? splitList(text(categorySpan)) : [];

    // Warnings: prefer the split per-item copy in the tag list; fall back to the
    // comma-joined required-tags symbol.
    let warnings = texts("ul.tags.commas li.warnings a.tag");
    if (warnings.length === 0) {
      const warningSpan = li.querySelector("ul.required-tags span.warnings");
      warnings = warningSpan ? splitList(text(warningSpan)) : [];
    }

    const ratingSpan = li.querySelector("ul.required-tags span.rating");

    return createWorkRecord({
      workId,
      title: text(workLink),
      authors: texts("h4.heading a[rel='author']"),
      fandoms: texts("h5.fandoms a.tag"),
      rating: ratingSpan ? text(ratingSpan) : "",
      warnings,
      categories,
      relationships: texts("ul.tags.commas li.relationships a.tag"),
      characters: texts("ul.tags.commas li.characters a.tag"),
      freeTags: texts("ul.tags.commas li.freeforms a.tag"),
      wordCount: parseNumber(text(li.querySelector("dl.stats dd.words"))),
      chapters: stripSpaces(text(li.querySelector("dl.stats dd.chapters"))),
      summary: text(li.querySelector("blockquote.userstuff.summary")),
      bookmarkNotes: userModule ? text(userModule.querySelector("blockquote.userstuff.notes")) : "",
      bookmarkTags: userModule ? texts("ul.meta a.tag", userModule) : [],
      // The bookmark date lives in the user module; the header datetime is the
      // work's own date.
      dateBookmarked: userModule ? text(userModule.querySelector("p.datetime")) : "",
      workLastUpdated: headerModule ? text(headerModule.querySelector("p.datetime")) : "",
      originalPosition
    });
  }

  // ── Regex path (service worker import walk) ──────────────────────────────────
  function parseBookmarkPage(html, { pageNumber = 1, originalPositionOffset = 0 } = {}) {
    const blurbs = extractBookmarkBlurbHtml(html);
    return {
      works: blurbs.map((blurbHtml, index) => parseBookmarkBlurb(blurbHtml, {
        originalPosition: originalPositionOffset + index + 1
      })).filter(Boolean),
      estimatedTotalPages: getEstimatedTotalPagesFromHtml(html, pageNumber)
    };
  }

  function parseBookmarkBlurb(input, { originalPosition = 1 } = {}) {
    return parseBookmarkHtml(String(input || ""), originalPosition);
  }

  function parseBookmarkHtml(html, originalPosition) {
    // Match the work *title* link: a bare /works/<id> (optionally with ?query or
    // #hash), NOT /works/<id>/bookmarks (the status count link), /works/<id>/
    // chapters/… , or an absolute-URL work link injected by another extension.
    const workMatch = html.match(/<a\b[^>]*href=["']\/works\/(\d+)(?:[?#][^"']*)?["'][^>]*>([\s\S]*?)<\/a>/i);
    // No such link: a bookmark of a series or an external work, with no workId
    // to track. Skip it cleanly (parity with the DOM path).
    if (!workMatch) return null;

    const requiredTagsSection = sectionHtml(html, /<ul\b[^>]*class=["'][^"']*required-tags[^"']*["'][^>]*>([\s\S]*?)<\/ul>/i);
    const freeTagsSection = sectionHtml(html, /<ul\b[^>]*class=["'][^"']*tags commas[^"']*["'][^>]*>([\s\S]*?)<\/ul>/i);
    const bookmarkMetaSection = sectionHtml(html, /<ul\b[^>]*class=["'][^"']*meta[^"']*["'][^>]*>([\s\S]*?)<\/ul>/i);

    const { relationships, characters, freeTags } = classifyFreeTags(freeTagsSection);
    const datetimes = datetimeTexts(html);

    return createWorkRecord({
      workId: workMatch[1],
      title: cleanText(stripTags(workMatch[2])),
      authors: relAuthorTexts(html),
      fandoms: tagTexts(sectionHtml(html, /<h5\b[^>]*class=["'][^"']*fandoms[^"']*["'][^>]*>([\s\S]*?)<\/h5>/i)),
      rating: extractRating(requiredTagsSection),
      warnings: extractWarnings(requiredTagsSection, freeTagsSection),
      categories: extractCategories(requiredTagsSection),
      relationships,
      characters,
      freeTags,
      wordCount: parseNumber(statValueFromHtml(html, "Words")),
      chapters: stripSpaces(statValueFromHtml(html, "Chapters")),
      summary: blockquoteText(html, "summary", /<dl\b[^>]*class=["'][^"']*stats/i),
      bookmarkNotes: blockquoteText(html, "notes", /<ul\b[^>]*class=["'][^"']*actions/i),
      bookmarkTags: tagTexts(bookmarkMetaSection),
      // Two datetimes on a bookmark blurb: header (work date) then user module
      // (bookmark date). The bookmark date is the later one.
      dateBookmarked: datetimes.length ? datetimes[datetimes.length - 1] : "",
      workLastUpdated: statValueFromHtml(html, "Updated") || (datetimes.length > 1 ? datetimes[0] : ""),
      originalPosition
    });
  }

  // Rating/warnings/categories from the required-tags symbol spans (real AO3),
  // falling back to <a class="… tag"> for simplified/legacy markup.
  function extractRating(requiredTagsSection) {
    return symbolTitle(requiredTagsSection, "rating")
      || anchorTextsByClass(requiredTagsSection, "rating")[0]
      || "";
  }

  function extractCategories(requiredTagsSection) {
    const symbol = symbolTitle(requiredTagsSection, "category");
    return symbol ? splitList(symbol) : anchorTextsByClass(requiredTagsSection, "category");
  }

  function extractWarnings(requiredTagsSection, freeTagsSection) {
    // The free-tag list splits warnings into one <li class="warnings"> each.
    const fromList = liTagTextsByClass(freeTagsSection, "warnings");
    if (fromList.length) return fromList;
    const symbol = symbolTitle(requiredTagsSection, "warnings");
    if (symbol) return splitList(symbol);
    return anchorTextsByClass(requiredTagsSection, "warning");
  }

  // AO3 wraps each free tag in <li class="relationships|characters|freeforms">.
  // Prefer those semantic classes; fall back to the text heuristic only when a
  // blurb carries no type classes at all (older or simplified markup).
  function classifyFreeTags(freeTagsSection) {
    const relationships = liTagTextsByClass(freeTagsSection, "relationships");
    const characters = liTagTextsByClass(freeTagsSection, "characters");
    const freeforms = liTagTextsByClass(freeTagsSection, "freeforms");

    if (relationships.length || characters.length || freeforms.length) {
      return { relationships, characters, freeTags: freeforms };
    }

    return heuristicClassify(tagTexts(freeTagsSection));
  }

  // Legacy fallback: guess a tag's type from its text. Imperfect (a character
  // with a space, or an "A & B" relationship, are misfiled), which is exactly
  // why the <li>-class path above is preferred when available.
  function heuristicClassify(allFreeTags) {
    return {
      relationships: allFreeTags.filter((tag) => tag.includes("/")),
      characters: allFreeTags.filter((tag) => !tag.includes("/") && !tag.includes(" ")),
      freeTags: allFreeTags.filter((tag) => tag.includes(" ") || (!tag.includes("/") && tag.includes("-")))
    };
  }

  function createWorkRecord(fields) {
    const importedAt = Date.now();
    return {
      workId: fields.workId,
      title: fields.title || "",
      authors: fields.authors || [],
      fandoms: fields.fandoms || [],
      rating: fields.rating || "",
      warnings: fields.warnings || [],
      categories: fields.categories || [],
      relationships: fields.relationships || [],
      characters: fields.characters || [],
      freeTags: fields.freeTags || [],
      wordCount: fields.wordCount || 0,
      chapters: fields.chapters || "",
      summary: fields.summary || "",
      bookmarkNotes: fields.bookmarkNotes || "",
      bookmarkTags: fields.bookmarkTags || [],
      dateBookmarked: fields.dateBookmarked || "",
      workLastUpdated: fields.workLastUpdated || "",
      originalPosition: fields.originalPosition,
      status: STATUS.ACTIVE,
      checkFailCount: 0,
      lastChecked: null,
      deletedAt: null,
      importedAt,
      pinnedToTop: false,
      notified: false
    };
  }

  // ── Regex helpers ─────────────────────────────────────────────────────────
  function getEstimatedTotalPagesFromHtml(html, fallbackPage) {
    const numbers = [...html.matchAll(/(?:pagination|page)[\s\S]{0,200}?>(\d+)</gi)]
      .map((match) => parseInt(match[1], 10))
      .filter(Number.isFinite);
    return numbers.length ? Math.max(...numbers) : fallbackPage;
  }

  function statValueFromHtml(html, label) {
    const pattern = new RegExp(`<dt[^>]*>\\s*${escapeRegExp(label)}:?\\s*<\\/dt>\\s*<dd[^>]*>([\\s\\S]*?)<\\/dd>`, "i");
    return cleanText(stripTags(html.match(pattern)?.[1] || ""));
  }

  function extractBookmarkBlurbHtml(html) {
    return [...html.matchAll(/<li\b[^>]*(?:bookmark|work)[^>]*\bblurb\b[^>]*>[\s\S]*?<\/li>/gi)]
      .map((match) => match[0]);
  }

  function relAuthorTexts(html) {
    return [...html.matchAll(/<a\b[^>]*rel=["']author["'][^>]*>([\s\S]*?)<\/a>/gi)]
      .map((match) => cleanText(stripTags(match[1])))
      .filter(Boolean);
  }

  function tagTexts(html) {
    return [...String(html || "").matchAll(/<a\b[^>]*class=["'][^"']*tag[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)]
      .map((match) => cleanText(stripTags(match[1])))
      .filter(Boolean);
  }

  // All <a class="…CLASS…"> texts inside a section (e.g. legacy rating/warning/
  // category anchors inside ul.required-tags).
  function anchorTextsByClass(html, className) {
    const re = new RegExp(`<a\\b[^>]*class=["'][^"']*\\b${escapeRegExp(className)}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/a>`, "gi");
    return [...String(html || "").matchAll(re)]
      .map((match) => cleanText(stripTags(match[1])))
      .filter(Boolean);
  }

  // All tag texts inside every <li class="…LICLASS…"> of a section (e.g. the
  // warnings/relationships/characters/freeforms <li>s of ul.tags.commas).
  function liTagTextsByClass(html, liClass) {
    const re = new RegExp(`<li\\b[^>]*class=["'][^"']*\\b${escapeRegExp(liClass)}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/li>`, "gi");
    return [...String(html || "").matchAll(re)].flatMap((match) => tagTexts(match[1]));
  }

  // The title attribute of a required-tags symbol span (real AO3), e.g. the
  // "Mature" / "Graphic Depictions Of Violence" / "Gen, M/M" value.
  function symbolTitle(html, typeClass) {
    const re = new RegExp(`<span\\b[^>]*class=["'][^"']*\\b${escapeRegExp(typeClass)}\\b[^"']*["'][^>]*\\btitle=["']([^"']*)["']`, "i");
    const match = String(html || "").match(re);
    return match ? cleanText(match[1]) : "";
  }

  // Text of a <blockquote class="…className…">, robust to NESTED blockquotes
  // (takes the last close before the stop marker) so summaries aren't truncated.
  function blockquoteText(html, className, stopRe) {
    const openRe = new RegExp(`<blockquote\\b[^>]*class=["'][^"']*\\b${escapeRegExp(className)}\\b[^"']*["'][^>]*>`, "i");
    const open = String(html || "").match(openRe);
    if (!open) return "";

    let region = html.slice(open.index + open[0].length);
    if (stopRe) {
      const stop = region.search(stopRe);
      if (stop !== -1) region = region.slice(0, stop);
    }
    const lastClose = region.lastIndexOf("</blockquote>");
    if (lastClose !== -1) region = region.slice(0, lastClose);
    return cleanText(stripTags(region));
  }

  function datetimeTexts(html) {
    return [...String(html || "").matchAll(/<p\b[^>]*class=["'][^"']*datetime[^"']*["'][^>]*>([\s\S]*?)<\/p>/gi)]
      .map((match) => cleanText(stripTags(match[1])))
      .filter(Boolean);
  }

  function sectionHtml(html, pattern) {
    return String(html || "").match(pattern)?.[1] || "";
  }

  // ── Text helpers (shared by both paths) ──────────────────────────────────
  function splitList(value) {
    return String(value || "").split(/,\s*/).map((part) => part.trim()).filter(Boolean);
  }

  function parseNumber(value) {
    return Number(String(value || "").replace(/[^\d]/g, "")) || 0;
  }

  function stripSpaces(value) {
    return String(value || "").replace(/\s+/g, "");
  }

  function cleanText(value) {
    return decodeHtml(String(value || "").replace(/\s+/g, " ").trim());
  }

  function stripTags(value) {
    return String(value || "").replace(/<[^>]*>/g, " ");
  }

  function decodeHtml(value) {
    const entities = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      "#039": "'",
      apos: "'"
    };
    return String(value).replace(/&([^;]+);/g, (match, entity) => entities[entity] || match);
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  const api = {
    createWorkRecord,
    classifyFreeTags,
    heuristicClassify,
    parseBlurbElement,
    parseBookmarkBlurb,
    parseBookmarkHtml,
    parseBookmarkPage
  };

  globalThis.AO3LostAndFoundParser = api;

  if (typeof module !== "undefined") {
    module.exports = api;
  }
})();
