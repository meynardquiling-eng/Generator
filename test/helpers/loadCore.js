// Loads the browser/Apps-Script-style core files into one vm context, the same way the
// build script concatenates them into the dashboard page.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CORE_FILES = require('../../scripts/coreFiles.json');

function loadCore() {
  const context = vm.createContext({ setTimeout, clearTimeout, console, Promise, Date, JSON, Math });
  for (const rel of CORE_FILES) {
    const file = path.join(__dirname, '..', '..', rel);
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: rel });
  }
  return context;
}

module.exports = { loadCore };
