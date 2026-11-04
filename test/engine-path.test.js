const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function engineFileFrom(relativePath, pattern) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  const match = source.match(pattern);
  assert.ok(match, `no engine path found in ${relativePath}`);
  return match[1];
}

test('every launcher points at an engine file that exists in the repo', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const engines = {
    'server.js': engineFileFrom('server.js', /path\.join\(__dirname, '([^']+\.js)'\)/),
    'desktop_app.py': engineFileFrom('desktop_app.py', /SCRAPER = ROOT \/ "([^"]+\.js)"/),
    'scripts/build-exe.ps1': engineFileFrom('scripts/build-exe.ps1', /Join-Path \$root "(scraper[^"]*\.js)"/i),
    'package.json': pkg.main,
  };

  for (const [file, engine] of Object.entries(engines)) {
    assert.ok(fs.existsSync(path.join(root, engine)), `${engine} (from ${file}) is missing from the repo`);
  }
});
