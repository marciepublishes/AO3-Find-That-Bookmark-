/**
 * Dexie database boundary for AO3 Lost and Found.
 *
 * Contract:
 * - initDatabase(DexieCtor): returns the configured Dexie database instance.
 * - The caller must pass the Dexie constructor. In production, only background.js
 *   may call this function after loading lib/dexie.min.js.
 * - Content scripts and popup code must never import or instantiate this module.
 *
 * Migration strategy:
 * Dexie's versioned schema chain is the only supported way to evolve storage.
 * Future changes must append db.version(N).stores(...).upgrade(...) entries
 * instead of editing or removing previous versions. Upgrade callbacks should be
 * idempotent and preserve unknown fields so existing user data survives browser
 * updates. Destructive migrations must export a backup first and require an
 * explicit schema version bump in the backup/restore validator.
 */
function initDatabase(DexieCtor) {
  if (!DexieCtor) {
    throw new Error("Dexie constructor is required to initialize LostWorksDB.");
  }

  const db = new DexieCtor("LostWorksDB");

  db.version(1).stores({
    works: "&workId, status, lastChecked, deletedAt, dateBookmarked, pinnedToTop, checkFailCount",
    meta: "&key"
  });

  return db;
}

globalThis.AO3LostAndFoundDB = {
  initDatabase
};

if (typeof module !== "undefined") {
  module.exports = globalThis.AO3LostAndFoundDB;
}
