const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

// The background runs as a classic service worker: importScripts loads every
// module into ONE shared global scope, so a top-level `const`/`let`/`class`
// with the same name in two files is a hard SyntaxError that crashes the whole
// worker. Jest normally loads each module in its own scope and would miss this,
// so these tests deliberately combine the sources to reproduce worker scope.

const WORKER_SCRIPTS = [
  "modules/constants.js",
  "modules/db.js",
  "modules/import-manager.js",
  "modules/check-manager.js",
  "background.js"
];

describe("service worker shared scope", () => {
  test("combined scripts have no duplicate top-level declarations", () => {
    const combined = WORKER_SCRIPTS.map(read).join("\n;\n");
    // Compiling (not running) is enough: duplicate const/let/class across the
    // combined source throws "Identifier '...' has already been declared".
    expect(() => new vm.Script(combined)).not.toThrow();
  });

  test("manager modules load and export side by side in one scope", () => {
    const context = {};
    context.globalThis = context;
    vm.createContext(context);

    const combined = [
      "modules/constants.js",
      "modules/db.js",
      "modules/import-manager.js",
      "modules/check-manager.js"
    ].map(read).join("\n;\n");

    expect(() => vm.runInContext(combined, context)).not.toThrow();
    expect(context.AO3LostAndFoundConstants).toBeDefined();
    // typeof (not instanceof): classes from the vm realm aren't instances of
    // this realm's Function.
    expect(typeof context.AO3LostAndFoundDB.initDatabase).toBe("function");
    expect(typeof context.AO3LostAndFoundImport.ImportManager).toBe("function");
    expect(typeof context.AO3LostAndFoundCheck.CheckManager).toBe("function");
  });
});
