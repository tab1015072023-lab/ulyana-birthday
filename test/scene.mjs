import assert from "node:assert/strict";
import fs from "node:fs";

const root = new URL("..", import.meta.url);
const html = fs.readFileSync(new URL("index.html", root), "utf8");

assert.match(html, /<html lang="ru">/);
assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
assert.match(html, /<meta name="robots" content="noindex">/);
assert.match(html, /<link rel="icon" href="favicon\.ico">/);
assert.match(html, /<title>Ульяна, это мы<\/title>/);
assert.equal(/https?:\/\//.test(html), false, "page must not request external resources");
assert.equal(/<script[^>]+src=/.test(html), false);
assert.equal(/<link(?![^>]*href="favicon\.ico")[^>]*href=/.test(html), false);
assert.equal(/url\(\s*['"]?\/\//.test(html), false);
assert.equal(/\bfetch\s*\(/.test(html), false);
assert.equal(fs.readFileSync(new URL("CNAME", root), "utf8").trim(), "ulyanamarchenko.ru");
assert.equal(fs.readFileSync(new URL(".nojekyll", root), "utf8"), "");
assert.ok(fs.statSync(new URL("favicon.ico", root)).size > 0);

assert.match(html, /Ульяна, 19/);
assert.match(html, /22 ноября/);
assert.match(html, /В дверь звонят/);
assert.match(html, /Открыть дверь/);
assert.match(html, /С днём рождения,/);
assert.match(html, /Ульяна!/);
assert.match(html, /Нажми, чтобы послушать/);
assert.equal(html.includes("Позвонить"), false);
assert.equal(html.includes("Коснись"), false);
assert.equal(html.includes("Гал"), false);
assert.equal(/марченко/i.test(html), false);
assert.equal(/🔊|🔇|confetti|balloon|dancer|playDingDong|RING_COUNT/.test(html), false);
assert.equal(/<audio[^>]*autoplay/.test(html), false);

const names = [...html.matchAll(/<span class="name">([^<]+)<\/span>/g)].map((m) => m[1]);
assert.deepEqual(names, ["Мама", "Тая", "Папа"]);

const voices = [...html.matchAll(/data-file="(mama|taya|papa)"[\s\S]*?<span class="name">([^<]+)<\/span>/g)];
assert.deepEqual(voices.map((m) => [m[2], m[1]]), [["Мама", "mama"], ["Тая", "taya"], ["Папа", "papa"]]);

for (const name of ["mama", "taya", "papa"]) {
  const block = html.match(new RegExp(`<audio id="${name}"[\\s\\S]*?<\\/audio>`));
  assert.ok(block, "audio " + name);
  const sources = [...block[0].matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(sources, [`audio/${name}.m4a`, `audio/${name}.mp3`]);
  assert.match(block[0], /type="audio\/mp4"/);
  assert.match(block[0], /type="audio\/mpeg"/);
  assert.equal(block[0].includes(".ogg"), false);
  const m4a = fs.readFileSync(new URL(`audio/${name}.m4a`, root));
  const mp3 = fs.readFileSync(new URL(`audio/${name}.mp3`, root));
  const ogg = fs.readFileSync(new URL(`audio/${name}.ogg`, root));
  assert.ok(m4a.includes(Buffer.from("ftyp")), "m4a container");
  assert.ok(m4a.includes(Buffer.from("mp4a")), "aac sample entry");
  assert.ok(mp3.subarray(0, 3).equals(Buffer.from("ID3")) || mp3[0] === 0xff, "mp3");
  assert.ok(ogg.length > 0, "ogg copy");
}

assert.match(html, /rotateY\(-108deg\)/);
assert.match(html, /prefers-reduced-motion:\s*reduce/);
assert.match(html, /id="open-door"/);
assert.equal(/id="open-door"[^>]*disabled/.test(html), false);

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

assert.equal(script.includes("LOOPS"), false);
assert.equal(script.includes("playDingDong"), false);
const beginMelody = script.match(/function beginMelody\(\) \{([\s\S]*?)\n      \}/);
assert.ok(beginMelody, "beginMelody");
assert.equal(/for\s*\(/.test(beginMelody[1]), false, "melody is not looped");
assert.equal((beginMelody[1].match(/scheduleSong\(/g) || []).length, 1, "melody plays once");
assert.equal((script.match(/\.resume\(\)/g) || []).length, 1, "context is resumed only to start the melody");

const onVoice = script.match(/function onVoice\(button\) \{([\s\S]*?)\n      \}/);
assert.ok(onVoice, "onVoice");
const body = onVoice[1];
assert.ok(body.indexOf("stopMelody()") !== -1 && body.indexOf("stopMelody()") < body.indexOf("audio.play()"));
assert.ok(body.indexOf("stopOthers(audio)") < body.indexOf("audio.play()"));
assert.match(body, /shouldPause/);
assert.match(body, /audio\.pause\(\)/);
assert.match(script, /function stopMelody\(\)/);
assert.match(script, /melodyCancelled = true/);
assert.match(script, /ctx\.close\(\)/);
assert.match(script, /canPlayType/);
assert.match(script, /ICON_PAUSE = "⏸️"/);
assert.match(script, /ICON_PLAY = "▶️"/);
assert.match(script, /addEventListener\("ended"/);

console.log("scene ok");
