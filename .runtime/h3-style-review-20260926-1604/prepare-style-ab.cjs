const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = process.cwd();
const target = path.join(root, '.runtime/h3-style-probe-v2-20260926-1638');
fs.mkdirSync(target, { recursive: true });
const base = fs.readFileSync(path.join(__dirname, 'style-probe-en-US.txt'), 'utf8');
const formal = fs.readFileSync(path.join(__dirname, 'formal-prompt-v2/1790319537445/en-US.txt'), 'utf8');
const style = /detailed_description:\s*([\s\S]*?)\s*\[Shot 1\]/.exec(formal)?.[1].trim();
assert.ok(style && style.includes('realism level of the character sheets'));
const before = /(?<=detailed_description:\s*)The clip uses[\s\S]*?(?= The localized spoken-language)/.exec(base)?.[0];
assert.ok(before);
const candidate = base.replace(before, style);
assert.equal(candidate.replace(style, before), base);
fs.writeFileSync(path.join(target, 'style-probe-en-US.txt'), candidate);
fs.writeFileSync(path.join(target, 'style-ab.json'), JSON.stringify({
  comparison: 'Only the opening rendering-source text changes; all shots, references, sound, seed, duration and settings stay identical to probe 1.',
  firstProbe: path.join(__dirname, 'style-probe-manifest.json'),
  styleSource: path.join(__dirname, 'formal-prompt-v2/1790319537445/en-US.txt'),
  before, after: style,
}, null, 2));
const script = fs.readFileSync(path.join(__dirname, 'style-probe.cjs'), 'utf8')
  .replaceAll('Toonflow/H3_style_probe_20260926_1604', 'Toonflow/H3_style_probe_20260926_1638_inherit');
fs.writeFileSync(path.join(target, 'style-probe.cjs'), script);
fs.copyFileSync(path.join(__dirname, 'style-probe-uploads.json'), path.join(target, 'style-probe-uploads.json'));
fs.copyFileSync(path.join(__dirname, 'watch-probe.cjs'), path.join(target, 'watch-probe.cjs'));
console.log(JSON.stringify({ target, before, after: style }));
