'use strict';

const { execFileSync } = require('child_process');

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding:'utf8' }).split('\0').filter(Boolean);
const forbidden = [
  /(^|\/)projects\//i, /(^|\/)work\//i, /(^|\/)private\//i, /(^|\/)research\//i,
  /(^|\/)manuscripts?\//i, /(^|\/)papers?\//i, /(^|\/)submissions?\//i,
  /(^|\/)attachments?\//i, /(^|\/)notes?\//i, /(^|\/)\.claude\//i,
  /(^|\/)\.codex\//i, /(^|\/)\.playwright-mcp\//i, /(^|\/)\.ratex-/i,
  /\.(pdf|tex|bib|docx|zip|7z|tar|gz|pyc)$/i,
];
const allowed = new Set();
const unsafe = tracked.filter((file) => !allowed.has(file) && forbidden.some((rule) => rule.test(file)));

if (unsafe.length) {
  console.error('Publication safety check failed. Private/research-like files are tracked:\n' + unsafe.map((x) => '  - ' + x).join('\n'));
  process.exit(1);
}
console.log('Publication safety check passed: no private research file patterns are tracked.');
