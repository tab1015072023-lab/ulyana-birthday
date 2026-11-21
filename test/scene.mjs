import assert from "node:assert/strict";
import fs from "node:fs";

const root = new URL("..", import.meta.url);
const html = fs.readFileSync(new URL("index.html", root), "utf8");

assert.match(html, /<html lang="ru">/);
assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
assert.match(html, /<meta name="robots" content="noindex">/);
assert.equal(/https?:\/\//.test(html), false, "page must not request external resources");
assert.equal(/<script[^>]+src=/.test(html), false);
assert.equal(/<link[^>]+href=/.test(html), false);
assert.equal(/url\(\s*['"]?\/\//.test(html), false);
assert.equal(/\bfetch\s*\(/.test(html), false);
assert.equal(fs.readFileSync(new URL("CNAME", root), "utf8").trim(), "ulyanamarchenko.ru");
assert.equal(fs.readFileSync(new URL(".nojekyll", root), "utf8"), "");

assert.match(html, /Коснись экрана 🎈/);
assert.match(html, /Нажми на дверь/);
assert.match(html, /Ульяна, с днём рождения! 🎉/);
assert.equal(html.includes("Гал"), false);
assert.equal(/марченко/i.test(html), false);

assert.match(html, /rotateY\(-108deg\)/);
assert.match(html, /prefers-reduced-motion:\s*reduce/);
assert.match(html, /var RING_COUNT = 3;/);
assert.match(html, /var RING_GAP = 1\.5;/);
assert.match(html, /var SILENCE = 1\.0;/);
assert.match(html, /playDingDong\(startAt \+ r \* RING_GAP\)/);
assert.match(html, /freq\("A5"\)/);
assert.match(html, /freq\("E5"\)/);

const rings = html.match(/class="tail-ring"/g) || [];
assert.ok(rings.length >= 5, "cat tail needs clear darker rings");
assert.match(html, /class="dancer dancer-cat cat"/);
assert.match(html, /#f7f1e6/);
assert.match(html, /#6a3418/);

const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const melodyBlock = script.match(/var MELODY = \[([\s\S]*?)\];/);
assert.ok(melodyBlock, "melody table");
const melody = [...melodyBlock[1].matchAll(/\["([A-G]#?\d)",\s*(\d+)\]/g)].map((m) => [m[1], Number(m[2])]);

const expected = [
  ["G5", 1], ["G5", 1], ["A5", 2], ["G5", 2], ["C6", 2], ["B5", 4],
  ["G5", 1], ["G5", 1], ["A5", 2], ["G5", 2], ["D6", 2], ["C6", 4],
  ["G5", 1], ["G5", 1], ["G6", 2], ["E6", 2], ["C6", 2], ["B5", 2], ["A5", 4],
  ["F6", 1], ["F6", 1], ["E6", 2], ["C6", 2], ["D6", 2], ["C6", 4]
];
assert.deepEqual(melody, expected);

const SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function midi(note) {
  const m = /^([A-G])(\d)$/.exec(note);
  return (Number(m[2]) + 1) * 12 + SEMI[m[1]];
}
function delta(a, b) {
  return midi(b[0]) - midi(a[0]);
}

const p1 = melody.slice(0, 6);
const p2 = melody.slice(6, 12);
const p3 = melody.slice(12, 19);
const p4 = melody.slice(19, 25);

for (const phrase of [p1, p2, p3, p4]) {
  assert.equal(phrase[0][0], phrase[1][0], "pickup notes match");
  assert.equal(phrase[0][1], 1);
  assert.equal(phrase[1][1], 1);
}

assert.equal(delta(p1[4], p1[5]), -1, "phrase 1 resolves down a semitone");
assert.equal(delta(p2[4], p2[5]), -2, "phrase 2 resolves down a whole tone");
assert.equal(delta(p1[4], p2[4]), 2, "second 'to' is a step higher");
assert.equal(delta(p3[1], p3[2]), 12, "phrase 3 leaps an octave");
assert.equal(delta(p3[2], p3[3]), -3);
assert.equal(delta(p3[3], p3[4]), -4);
assert.equal(delta(p3[4], p3[5]), -1);
assert.equal(delta(p3[5], p3[6]), -2);
assert.equal(p4[0][0][0], "F");
assert.equal(delta(p4[0], p4[1]), 0);
assert.equal(delta(p4[1], p4[2]), -1);
assert.equal(delta(p4[2], p4[3]), -4);
assert.equal(delta(p4[3], p4[4]), 2);
assert.equal(delta(p4[4], p4[5]), -2);
assert.equal(p4[5][0][0], "C", "song ends on the tonic");

const semiMap = script.match(/var SEMI = \{([\s\S]*?)\};/)[1];
assert.match(semiMap, /A4:\s*0/);
assert.match(semiMap, /G5:\s*10/);
assert.match(semiMap, /C6:\s*15/);
assert.match(semiMap, /B5:\s*14/);

console.log("scene ok");
