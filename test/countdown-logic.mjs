import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const root = new URL("..", import.meta.url);
const html = fs.readFileSync(new URL("index.html", root), "utf8");
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(scriptMatch, "page should contain one inline script");
const script = scriptMatch[1];

assert.match(html, /<meta name="robots" content="noindex">/);
assert.equal(/https?:\/\//.test(html), false, "page must not request external resources");
assert.equal(/<script[^>]+src=/.test(html), false);
assert.equal(/<link[^>]+href=/.test(html), false);
assert.equal(fs.readFileSync(new URL("CNAME", root), "utf8").trim(), "ulyanamarchenko.ru");
assert.equal(fs.readFileSync(new URL(".nojekyll", root), "utf8"), "");
assert.equal(html.includes("Галя, с днём") || html.includes("Гали, с днём рождения!"), false);

assert.ok(html.indexOf('id="countdown-galya"') < html.indexOf('id="countdown"'));
assert.match(html, /До дня рождения Гали осталось:/);
assert.match(html, /До дня рождения Ульяны осталось:/);
assert.match(html, /Ульяна, с днём рождения!/);
assert.match(html, /id="days"/);
assert.match(html, /id="hours"/);
assert.match(html, /id="minutes"/);
assert.match(html, /id="seconds"/);
assert.match(html, /Date\.parse\("2026-11-21T00:00:00\+03:00"\)/);
assert.match(html, /Date\.parse\("2026-11-22T00:00:00\+03:00"\)/);

const GALYA_MS = Date.parse("2026-11-21T00:00:00+03:00");
const ULYANA_MS = Date.parse("2026-11-22T00:00:00+03:00");
assert.equal(GALYA_MS, Date.UTC(2026, 10, 20, 21, 0, 0));
assert.equal(ULYANA_MS, Date.UTC(2026, 10, 21, 21, 0, 0));
assert.equal(ULYANA_MS - GALYA_MS, 86400000);

function extractFunction(source, name) {
  const marker = "function " + name + "(";
  const start = source.indexOf(marker);
  assert.ok(start >= 0, "missing function " + name);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("unclosed function " + name);
}

const plural = vm.runInNewContext(extractFunction(script, "plural") + "\nplural");
const remainingParts = vm.runInNewContext(extractFunction(script, "remainingParts") + "\nremainingParts");

const dayLabels = {
  0: "дней",
  1: "день",
  2: "дня",
  3: "дня",
  4: "дня",
  5: "дней",
  11: "дней",
  12: "дней",
  14: "дней",
  21: "день",
  22: "дня",
  25: "дней",
  101: "день",
  104: "дня",
  111: "дней",
  112: "дней",
  122: "дня"
};
const forms = {
  days: ["день", "дня", "дней"],
  hours: ["час", "часа", "часов"],
  minutes: ["минута", "минуты", "минут"],
  seconds: ["секунда", "секунды", "секунд"]
};
for (const [raw, day] of Object.entries(dayLabels)) {
  const n = Number(raw);
  const slot = forms.days.indexOf(day);
  assert.equal(plural(n, ...forms.days), day, "days " + n);
  for (const key of ["hours", "minutes", "seconds"]) {
    assert.equal(plural(n, ...forms[key]), forms[key][slot], key + " " + n);
  }
}

function plain(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

assert.equal(remainingParts(GALYA_MS, GALYA_MS), null);
assert.equal(remainingParts(GALYA_MS + 1, GALYA_MS), null);
assert.deepEqual(plain(remainingParts(GALYA_MS - 1, GALYA_MS)), {
  days: 0, hours: 0, minutes: 0, seconds: 0
});
assert.deepEqual(plain(remainingParts(GALYA_MS - 86400000, GALYA_MS)), {
  days: 1, hours: 0, minutes: 0, seconds: 0
});
assert.deepEqual(plain(remainingParts(Date.parse("2026-11-20T15:30:45+03:00"), GALYA_MS)), {
  days: 0, hours: 8, minutes: 29, seconds: 15
});

function decode(text) {
  return text
    .replace(/&nbsp;/g, "\u00A0")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function parseAttrs(raw) {
  const attrs = {};
  const re = /([:@\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
  let match;
  while ((match = re.exec(raw))) {
    attrs[match[1]] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
}

function el(tag, attrs) {
  return {
    tagName: tag,
    id: attrs.id || "",
    className: attrs.class || "",
    hidden: Object.prototype.hasOwnProperty.call(attrs, "hidden"),
    children: [],
    textContent: ""
  };
}

function classList(node) {
  return new Set((node.className || "").split(/\s+/).filter(Boolean));
}

function matches(node, selector) {
  if (selector.startsWith(".")) return classList(node).has(selector.slice(1));
  if (selector.startsWith("#")) return node.id === selector.slice(1);
  return node.tagName === selector.toLowerCase();
}

function walk(node, visit) {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

function querySelectorAll(node, selector) {
  const out = [];
  for (const child of node.children) {
    walk(child, (current) => {
      if (matches(current, selector)) out.push(current);
    });
  }
  return out;
}

function attachQuery(node) {
  node.querySelectorAll = (selector) => querySelectorAll(node, selector);
  node.querySelector = (selector) => querySelectorAll(node, selector)[0] || null;
}

function parseBody(source) {
  const body = source
    .match(/<body>([\s\S]*)<\/body>/)[1]
    .replace(/<script[\s\S]*?<\/script>/, "");
  const root = el("body", {});
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9]+)>|<([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g;
  let match;
  while ((match = re.exec(body))) {
    if (match[0].startsWith("<!--")) continue;
    if (match[1]) {
      const tag = match[1].toLowerCase();
      while (stack.length > 1 && stack.at(-1).tagName !== tag) stack.pop();
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (match[2]) {
      const node = el(match[2].toLowerCase(), parseAttrs(match[3] || ""));
      attachQuery(node);
      stack.at(-1).children.push(node);
      const selfClosing = /\/\s*$/.test(match[3] || "") || match[0].endsWith("/>");
      if (!selfClosing) stack.push(node);
      continue;
    }
    const text = decode(match[4]);
    if (text.trim()) stack.at(-1).textContent += text.trim();
  }
  attachQuery(root);
  return root;
}

function makeDocument(source) {
  const body = parseBody(source);
  return {
    body,
    getElementById(id) {
      let found = null;
      walk(body, (node) => {
        if (node.id === id) found = node;
      });
      return found;
    }
  };
}

function load(nowMs) {
  const clock = { ms: nowMs };
  const timers = [];
  const document = makeDocument(html);
  const sandbox = {
    document,
    console,
    window: {
      setTimeout(fn, delay) {
        timers.push({ fn, delay });
        return timers.length;
      }
    }
  };
  vm.createContext(sandbox);
  function FakeDate(...args) {
    if (args.length === 0) return new Date(clock.ms);
    return new Date(...args);
  }
  FakeDate.now = () => clock.ms;
  FakeDate.parse = Date.parse;
  FakeDate.UTC = Date.UTC;
  FakeDate.prototype = Date.prototype;
  sandbox.Date = FakeDate;
  vm.runInContext(script, sandbox);
  return { document, clock, timers };
}

function readBlock(document, id) {
  const root = document.getElementById(id);
  assert.ok(root, "missing #" + id);
  const nums = root.querySelectorAll(".num").map((node) => node.textContent);
  const labels = root.querySelectorAll(".label").map((node) => node.textContent);
  const lead = root.querySelector(".lead");
  return {
    hidden: root.hidden === true,
    lead: lead ? lead.textContent : "",
    nums,
    labels,
    greetingInside: root.querySelectorAll(".greeting").length
  };
}

function assertView(nowMs, expected) {
  const state = load(nowMs);
  const galya = readBlock(state.document, "countdown-galya");
  const ulyana = readBlock(state.document, "countdown");
  const greeting = state.document.getElementById("greeting");
  assert.equal(galya.greetingInside, 0, "Galya block must not contain a greeting");
  assert.equal(galya.lead, "До дня рождения Гали осталось:");
  assert.equal(ulyana.lead, "До дня рождения Ульяны осталось:");
  assert.equal(greeting.textContent.includes("Ульяна, с днём рождения!"), true);
  assert.equal(greeting.textContent.includes("🎉"), true);

  assert.equal(galya.hidden, expected.galya === null, "galya visibility at " + new Date(nowMs).toISOString());
  assert.equal(ulyana.hidden, expected.ulyana === null, "ulyana visibility");
  assert.equal(greeting.hidden, !expected.greeting, "greeting visibility");

  if (expected.galya) {
    assert.deepEqual(galya.nums, expected.galya.nums);
    assert.deepEqual(galya.labels, expected.galya.labels);
  }
  if (expected.ulyana) {
    assert.deepEqual(ulyana.nums, expected.ulyana.nums);
    assert.deepEqual(ulyana.labels, expected.ulyana.labels);
  }
  if (!expected.galya && !expected.ulyana) {
    assert.equal(state.timers.length, 0, "timers stop after both targets pass");
  } else {
    assert.equal(state.timers.length, 1);
    const delay = state.timers[0].delay;
    assert.ok(delay >= 1 && delay <= 1000, "delay " + delay);
  }
  return state;
}

const box = (days, hours, minutes, seconds, labels) => ({
  nums: [days, hours, minutes, seconds],
  labels
});

// Before 21.11 00:00 MSK: both countdowns, no greeting.
assertView(Date.parse("2026-11-20T15:30:45+03:00"), {
  galya: box("00", "08", "29", "15", ["дней", "часов", "минут", "секунд"]),
  ulyana: box("01", "08", "29", "15", ["день", "часов", "минут", "секунд"]),
  greeting: false
});
assertView(Date.parse("2026-11-18T21:57:58+03:00"), {
  galya: box("02", "02", "02", "02", ["дня", "часа", "минуты", "секунды"]),
  ulyana: box("03", "02", "02", "02", ["дня", "часа", "минуты", "секунды"]),
  greeting: false
});
assertView(Date.parse("2026-11-10T00:00:00+03:00"), {
  galya: box("11", "00", "00", "00", ["дней", "часов", "минут", "секунд"]),
  ulyana: box("12", "00", "00", "00", ["дней", "часов", "минут", "секунд"]),
  greeting: false
});
assertView(Date.parse("2026-10-31T00:00:00+03:00"), {
  galya: box("21", "00", "00", "00", ["день", "часов", "минут", "секунд"]),
  ulyana: box("22", "00", "00", "00", ["дня", "часов", "минут", "секунд"]),
  greeting: false
});
assertView(Date.parse("2026-11-20T22:00:00+03:00"), {
  galya: box("00", "02", "00", "00", ["дней", "часа", "минут", "секунд"]),
  ulyana: box("01", "02", "00", "00", ["день", "часа", "минут", "секунд"]),
  greeting: false
});
assertView(Date.parse("2026-11-20T23:00:00+03:00"), {
  galya: box("00", "01", "00", "00", ["дней", "час", "минут", "секунд"]),
  ulyana: box("01", "01", "00", "00", ["день", "час", "минут", "секунд"]),
  greeting: false
});
// Absolute instant, not local midnight: 12:00 UTC is 15:00 MSK on 20.11.
assertView(Date.UTC(2026, 10, 20, 12, 0, 0), {
  galya: box("00", "09", "00", "00", ["дней", "часов", "минут", "секунд"]),
  ulyana: box("01", "09", "00", "00", ["день", "часов", "минут", "секунд"]),
  greeting: false
});
// Last millisecond before Galya's midnight still shows both, Galya at 00:00:00.
assertView(GALYA_MS - 1, {
  galya: box("00", "00", "00", "00", ["дней", "часов", "минут", "секунд"]),
  ulyana: box("01", "00", "00", "00", ["день", "часов", "минут", "секунд"]),
  greeting: false
});

// From 21.11 00:00 MSK inclusive until 22.11 00:00: Galya is gone, Ulyana still counts.
assertView(GALYA_MS, {
  galya: null,
  ulyana: box("01", "00", "00", "00", ["день", "часов", "минут", "секунд"]),
  greeting: false
});
assertView(Date.parse("2026-11-21T09:30:00+03:00"), {
  galya: null,
  ulyana: box("00", "14", "30", "00", ["дней", "часов", "минут", "секунд"]),
  greeting: false
});
assertView(Date.parse("2026-11-21T12:00:00+03:00"), {
  galya: null,
  ulyana: box("00", "12", "00", "00", ["дней", "часов", "минут", "секунд"]),
  greeting: false
});
assertView(ULYANA_MS - 1, {
  galya: null,
  ulyana: box("00", "00", "00", "00", ["дней", "часов", "минут", "секунд"]),
  greeting: false
});

// 22.11 00:00 MSK and after: Galya stays gone, Ulyana's greeting is shown.
assertView(ULYANA_MS, { galya: null, ulyana: null, greeting: true });
assertView(Date.parse("2026-11-22T09:00:00+03:00"), { galya: null, ulyana: null, greeting: true });
assertView(Date.parse("2026-11-23T18:45:00+03:00"), { galya: null, ulyana: null, greeting: true });

// Crossing Galya's midnight while the page is open hides her block on the next tick.
const crossing = load(GALYA_MS - 500);
assert.equal(crossing.document.getElementById("countdown-galya").hidden, false);
crossing.clock.ms = GALYA_MS + 10;
crossing.timers.shift().fn();
assert.equal(crossing.document.getElementById("countdown-galya").hidden, true);
assert.equal(crossing.document.getElementById("countdown").hidden, false);
assert.equal(crossing.document.getElementById("greeting").hidden, true);
assert.deepEqual(
  crossing.document.getElementById("countdown").querySelectorAll(".num").map((node) => node.textContent),
  ["00", "23", "59", "59"]
);

console.log("countdown logic ok");
