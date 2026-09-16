// Reverse a UTF-8 -> Windows-1252 double-encoding ("Â·" -> "·", "â€”" -> "—") PER SEQUENCE,
// so text that is already correct UTF-8 is left alone. Usage: node fix-mojibake.mjs [--dry] files...
import { readFileSync, writeFileSync } from 'node:fs';

// Windows-1252 bytes 0x80-0x9F decode to these symbols; everything else in the byte range is latin1.
const CP1252 = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86,
  '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8A, '‹': 0x8B, 'Œ': 0x8C,
  'Ž': 0x8E, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95,
  '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9A, '›': 0x9B,
  'œ': 0x9C, 'ž': 0x9E, 'Ÿ': 0x9F,
};
const toByte = (ch) => {
  const c = ch.charCodeAt(0);
  if (c < 0x100) return c;
  return CP1252[ch] ?? -1;
};
const contClass = '[\\u0080-\\u00BF\\u20AC\\u201A\\u0192\\u201E\\u2026\\u2020\\u2021\\u02C6\\u2030\\u0160\\u2039\\u0152\\u017D\\u2018\\u2019\\u201C\\u201D\\u2022\\u2013\\u2014\\u02DC\\u2122\\u0161\\u203A\\u0153\\u017E\\u0178]';
const re = new RegExp(`[\\u00C2-\\u00F4]${contClass}{1,3}`, 'g');

const dry = process.argv.includes('--dry');
const files = process.argv.slice(2).filter((a) => a !== '--dry');
let total = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  let n = 0;
  const out = src.replace(re, (m) => {
    // Try the longest valid UTF-8 sequence starting at the lead byte.
    const bytes = [...m].map(toByte);
    if (bytes.some((b) => b < 0)) return m;
    const lead = bytes[0];
    const need = lead >= 0xF0 ? 4 : lead >= 0xE0 ? 3 : 2;
    if (bytes.length < need) return m;
    const seq = Buffer.from(bytes.slice(0, need));
    const dec = seq.toString('utf8');
    if (dec.includes('�') || Buffer.from(dec, 'utf8').length !== need) return m;
    n += 1;
    return dec + [...m].slice(need).join('');
  });
  if (n) {
    total += n;
    console.log(`${dry ? '[dry] ' : ''}${f}: ${n} sequence(s)`);
    if (!dry) writeFileSync(f, out, 'utf8');
  }
}
console.log(`${dry ? '[dry] ' : ''}fixed sequences: ${total}`);
