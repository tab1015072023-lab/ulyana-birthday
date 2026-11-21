import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const chrome = process.env.CHROME || "/usr/bin/google-chrome-stable";
const shotDir = process.env.SHOT_DIR || "";

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const rel = decodeURIComponent(url.pathname);
  const file = path.join(root, rel === "/" ? "index.html" : rel.replace(/^\/+/, ""));
  if (!file.startsWith(root)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end();
      return;
    }
    const ext = path.extname(file);
    const types = {
      ".html": "text/html; charset=utf-8",
      ".m4a": "audio/mp4",
      ".mp3": "audio/mpeg",
      ".ogg": "audio/ogg",
      ".ico": "image/x-icon"
    };
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(data);
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}/`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "card-chrome-"));
const proc = spawn(chrome, [
  "--headless=new",
  "--remote-debugging-port=0",
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--autoplay-policy=no-user-gesture-required",
  "--allow-file-access-from-files",
  `--user-data-dir=${profile}`,
  "about:blank"
], { stdio: ["ignore", "pipe", "pipe"] });

let wsUrl = "";
let stderr = "";
proc.stderr.on("data", (buf) => {
  stderr += buf.toString();
  const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
  if (match) wsUrl = match[1];
});
const ready = await Promise.race([
  (async () => {
    while (!wsUrl) await new Promise((r) => setTimeout(r, 30));
    return wsUrl;
  })(),
  once(proc, "exit").then(() => { throw new Error("chrome exited\n" + stderr); })
]);

const browser = new WebSocket(ready);
await new Promise((resolve, reject) => {
  browser.addEventListener("open", resolve, { once: true });
  browser.addEventListener("error", reject, { once: true });
});

let nextId = 1;
const pending = new Map();
const listeners = [];
browser.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result || {});
  } else {
    for (const fn of listeners) fn(msg);
  }
});

function send(method, params = {}, sessionId) {
  const id = nextId++;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    browser.send(JSON.stringify(payload));
  });
}

function waitEvent(name, sessionId, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      listeners.splice(listeners.indexOf(on), 1);
      reject(new Error("timeout waiting for " + name));
    }, timeout);
    const on = (msg) => {
      if (msg.method === name && (!sessionId || msg.sessionId === sessionId)) {
        clearTimeout(timer);
        listeners.splice(listeners.indexOf(on), 1);
        resolve(msg.params || {});
      }
    };
    listeners.push(on);
  });
}

const created = await send("Target.createTarget", { url: "about:blank" });
const attached = await send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
const sessionId = attached.sessionId;

async function cmd(method, params) {
  return send(method, params, sessionId);
}

async function evaluate(expression) {
  const result = await cmd("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (result.exceptionDetails) {
    throw new Error(JSON.stringify(result.exceptionDetails));
  }
  return result.result ? result.result.value : undefined;
}

async function setViewport(width, height, mobile) {
  await cmd("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: mobile ? 2 : 1,
    mobile,
    screenWidth: width,
    screenHeight: height
  });
}

async function click(selector) {
  const box = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
  })()`);
  assert.ok(box && box.w > 0 && box.h > 0, "missing " + selector);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cmd("Input.dispatchMouseEvent", {
      type,
      x: box.x,
      y: box.y,
      button: "left",
      clickCount: 1
    });
  }
}

async function shoot(name) {
  if (!shotDir) return;
  const shot = await cmd("Page.captureScreenshot", { format: "png" });
  fs.mkdirSync(shotDir, { recursive: true });
  fs.writeFileSync(path.join(shotDir, name), Buffer.from(shot.data, "base64"));
}

const hook = `
  window.__audioStarts = [];
  (function () {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    var Wrapped = function AudioContext(options) {
      window.__audioStarts.push("audiocontext");
      var real = new AC(options);
      window.__ctx = real;
      return real;
    };
    Wrapped.prototype = AC.prototype;
    window.AudioContext = Wrapped;
    if (window.webkitAudioContext) window.webkitAudioContext = Wrapped;
    var orig = HTMLAudioElement.prototype.play;
    HTMLAudioElement.prototype.play = function () {
      window.__audioStarts.push("media:" + (this.dataset.file || ""));
      return orig.apply(this, arguments);
    };
  })();
`;

try {
  await cmd("Page.enable");
  await cmd("Runtime.enable");
  await setViewport(390, 844, true);
  await cmd("Page.addScriptToEvaluateOnNewDocument", { source: hook });
  const loaded = waitEvent("Page.loadEventFired", sessionId);
  await cmd("Page.navigate", { url: origin });
  await loaded;

  const before = await evaluate(`(() => {
    const openBtn = document.getElementById("open-door");
    const panel = document.getElementById("open-panel");
    const style = getComputedStyle(panel);
    return {
      starts: window.__audioStarts.slice(),
      disabled: openBtn.disabled,
      openText: openBtn.textContent.trim(),
      names: [...document.querySelectorAll(".voice .name")].map((n) => n.textContent),
      icons: [...document.querySelectorAll(".voice .icon")].map((n) => n.textContent),
      greetingHidden: style.display === "none",
      melody: document.getElementById("app").dataset.melody,
      closed: document.getElementById("app").classList.contains("is-closed"),
      sources: [...document.querySelectorAll("audio")].map((a) => a.src),
      support: {
        m4a: document.createElement("audio").canPlayType("audio/mp4"),
        mp3: document.createElement("audio").canPlayType("audio/mpeg")
      }
    };
  })()`);

  assert.deepEqual(before.starts, [], "no sound before the first tap");
  assert.equal(before.disabled, false, "open button is available immediately");
  assert.equal(before.openText, "Открыть дверь");
  assert.deepEqual(before.names, ["Мама", "Тая", "Папа"]);
  assert.deepEqual(before.icons, ["▶️", "▶️", "▶️"]);
  assert.equal(before.greetingHidden, true);
  assert.equal(before.melody, "idle");
  assert.equal(before.closed, true);
  assert.deepEqual(before.sources.map((src) => src.match(/\/(mama|taya|papa)\./)[1]), ["mama", "taya", "papa"]);
  for (const src of before.sources) {
    if (before.support.m4a) assert.match(src, /\.m4a$/);
    else assert.match(src, /\.mp3$/);
  }
  await shoot("closed_door_mobile.png");

  const t0 = Date.now();
  await click("#open-door");
  const opened = await evaluate(`(() => {
    const app = document.getElementById("app");
    const greeting = document.getElementById("greeting").textContent.replace(/\\s+/g, " ").trim();
    return {
      open: app.classList.contains("is-open"),
      greeting,
      names: [...document.querySelectorAll(".voice .name")].map((n) => n.textContent),
      hint: document.getElementById("listen-hint").textContent.trim(),
      starts: window.__audioStarts.slice()
    };
  })()`);
  assert.equal(opened.open, true, "first tap opens the door with no waiting step");
  assert.ok(Date.now() - t0 < 1500, "open took too long: " + (Date.now() - t0));
  assert.equal(opened.greeting, "С днём рождения, Ульяна!");
  assert.deepEqual(opened.names, ["Мама", "Тая", "Папа"]);
  assert.equal(opened.hint, "Нажми, чтобы послушать");
  assert.deepEqual(opened.starts, ["audiocontext"]);

  assert.equal(
    await waitFor(`document.getElementById("app").dataset.melody === "playing"`, 2000),
    true,
    "melody did not start"
  );
  await new Promise((r) => setTimeout(r, 1200));
  await shoot("opened_mobile.png");

  await click('.voice[data-file="mama"]');
  assert.equal(await waitFor(`(() => {
    const a = document.getElementById("mama");
    const app = document.getElementById("app");
    return !a.paused && app.dataset.melody === "stopped" && app.dataset.activeVoice === "mama";
  })()`), true, "mama did not start: " + JSON.stringify(await voiceState()));
  assert.equal(await waitFor(`window.__ctx && window.__ctx.state === "closed"`), true, "melody context was not closed");
  await new Promise((r) => setTimeout(r, 350));
  const mama = await voiceState();
  assert.equal(mama.melody, "stopped");
  assert.equal(mama.context, "closed");
  assert.equal(mama.icons[0], "⏸️");
  assert.equal(mama.icons[1], "▶️");
  assert.equal(mama.icons[2], "▶️");
  assert.equal(mama.paused[0], false);
  assert.equal(mama.paused[1], true);
  assert.equal(mama.paused[2], true);
  assert.ok(mama.times[0] > 0, "mama should be advancing");
  assert.equal(mama.times[1], 0);
  assert.equal(mama.times[2], 0);
  assert.match(mama.sources[0], /\/mama\.(m4a|mp3)$/);
  assert.ok(mama.starts.filter((s) => s.startsWith("media:")).every((s) => s === "media:mama"));
  await shoot("voice_playing_mobile.png");

  await new Promise((r) => setTimeout(r, 250));
  const still = await voiceState();
  assert.equal(still.melody, "stopped", "melody resumed by itself");
  assert.equal(still.context, "closed");
  assert.ok(still.starts.filter((s) => s === "audiocontext").length === 1);

  await click('.voice[data-file="mama"]');
  assert.equal(await waitFor(`document.getElementById("mama").paused === true`), true, "pause did not apply");
  const paused = await voiceState();
  assert.equal(paused.icons[0], "▶️");
  assert.equal(paused.paused[0], true);
  assert.ok(paused.times[0] > 0, "pause keeps the place");
  assert.equal(paused.melody, "stopped");
  const pausedAt = paused.times[0];

  await click('.voice[data-file="mama"]');
  assert.equal(await waitFor(`!document.getElementById("mama").paused && document.getElementById("app").dataset.activeVoice === "mama"`), true, "resume did not play");
  await new Promise((r) => setTimeout(r, 200));
  const resumed = await voiceState();
  assert.equal(resumed.icons[0], "⏸️");
  assert.equal(resumed.paused[0], false);
  assert.ok(resumed.times[0] + 0.05 >= pausedAt, "resume restarted instead of continuing");
  assert.equal(resumed.melody, "stopped");

  await click('.voice[data-file="taya"]');
  assert.equal(await waitFor(`!document.getElementById("taya").paused && document.getElementById("app").dataset.activeVoice === "taya"`), true, "taya did not start");
  const taya = await voiceState();
  assert.equal(taya.paused[0], true);
  assert.equal(taya.times[0], 0, "previous voice is stopped");
  assert.equal(taya.paused[1], false);
  assert.equal(taya.icons[0], "▶️");
  assert.equal(taya.icons[1], "⏸️");
  assert.equal(taya.icons[2], "▶️");
  assert.match(taya.sources[1], /\/taya\.(m4a|mp3)$/);
  assert.equal(taya.melody, "stopped");

  await click('.voice[data-file="papa"]');
  assert.equal(await waitFor(`!document.getElementById("papa").paused && document.getElementById("app").dataset.activeVoice === "papa"`), true, "papa did not start");
  const papa = await voiceState();
  assert.equal(papa.paused[1], true);
  assert.equal(papa.times[1], 0);
  assert.equal(papa.paused[2], false);
  assert.deepEqual(papa.icons, ["▶️", "▶️", "⏸️"]);
  assert.match(papa.sources[2], /\/papa\.(m4a|mp3)$/);
  assert.equal(papa.paused[0], true);
  assert.equal(papa.melody, "stopped");
  const media = papa.starts.filter((s) => s.startsWith("media:"));
  assert.deepEqual(media, ["media:mama", "media:mama", "media:taya", "media:papa"]);

  await evaluate(`document.getElementById("papa").dispatchEvent(new Event("ended"))`);
  const ended = await voiceState();
  assert.equal(ended.icons[2], "▶️");
  assert.equal(ended.active, "");
  assert.equal(ended.melody, "stopped");

  await setViewport(1280, 800, false);
  await new Promise((r) => setTimeout(r, 200));
  await shoot("opened_desktop.png");

  console.log("playback ok", JSON.stringify({ support: before.support, sources: before.sources }));
} catch (err) {
  try {
    console.error("state", JSON.stringify(await voiceState()));
  } catch (inner) {}
  throw err;
} finally {
  server.close();
  try { browser.close(); } catch (err) {}
  proc.kill("SIGKILL");
}

function waitFor(expression, timeout = 4000) {
  const start = Date.now();
  return (async () => {
    while (Date.now() - start < timeout) {
      const ok = await evaluate(`Boolean(${expression})`);
      if (ok) return true;
      await new Promise((r) => setTimeout(r, 40));
    }
    return false;
  })();
}

async function voiceState() {
  return evaluate(`(() => {
    const audios = ["mama", "taya", "papa"].map((id) => document.getElementById(id));
    const app = document.getElementById("app");
      return {
        melody: app.dataset.melody,
        active: app.dataset.activeVoice,
        icons: [...document.querySelectorAll(".voice .icon")].map((n) => n.textContent),
        paused: audios.map((a) => a.paused),
        times: audios.map((a) => a.currentTime),
        sources: audios.map((a) => a.currentSrc || a.src),
        starts: window.__audioStarts.slice(),
        context: window.__ctx ? window.__ctx.state : ""
      };
  })()`);
}
