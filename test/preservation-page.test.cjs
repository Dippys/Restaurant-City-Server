const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('preservation page gives visitors a safe, actionable recovery path', () => {
  const page = fs.readFileSync(path.join(root, 'public', 'preserve.html'), 'utf8');
  assert.match(page, /Help us preserve/);
  assert.match(page, /Leave it untouched/);
  assert.match(page, /Protect your privacy/);
  assert.match(page, /static\.playfish\.com\/game\/cooking\/swf\/0\.9\.143a\//);
  assert.match(page, /https:\/\/discord\.gg\/Ppuwb826eC/);
  assert.match(page, /original Reddit preservation post/);
});

test('homepage and sitemap expose the preservation page', () => {
  const home = fs.readFileSync(path.join(root, 'public', 'home.html'), 'utf8');
  const sitemap = fs.readFileSync(path.join(root, 'public', 'sitemap.xml'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'src', 'http-server.ts'), 'utf8');
  assert.match(home, /href="\/preserve">Help preserve/);
  assert.match(sitemap, /https:\/\/rc-reborn\.uk\/preserve/);
  assert.match(server, /pathname === '\/preserve'/);
});
