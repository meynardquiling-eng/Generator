// Builds the single-file trainer dashboard (dist/trainer-dashboard.html) that is
// published as a claude.ai Artifact. The same core files run in the Node tests.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

const coreFiles = require('./coreFiles.json');
const core = coreFiles.map(f => `// ---- ${f}\n${read(f)}`).join('\n');
const app = ['src/artifact/adapters.js', 'src/artifact/app.js'].map(f => `// ---- ${f}\n${read(f)}`).join('\n');

let page = read('src/artifact/page.html');
for (const [marker, code] of [['/*__CORE__*/', core], ['/*__APP__*/', app]]) {
  if (code.includes('</script')) throw new Error('Inline code contains a closing script tag');
  page = page.replace(marker, () => code);
}

// Fail the build if the combined script does not parse.
new Function(core + '\n' + app);

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'trainer-dashboard.html'), page);
console.log('Wrote dist/trainer-dashboard.html (' + Math.round(page.length / 1024) + ' KB)');
