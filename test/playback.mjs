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
      ".ico": "image/x-icon",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp"
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
      icons: [...document.querySelectorAll(".voice")].map((b) => getComputedStyle(b.querySelector(".mark.pause")).display === "none" ? "play" : "pause"),
      greetingHidden: style.display === "none",
      melody: document.getElementById("app").dataset.melody,
      bell: document.getElementById("app").dataset.bell,
      overlap: document.getElementById("app").dataset.overlap,
      closed: document.getElementById("app").classList.contains("is-closed"),
      sources: [...document.querySelectorAll("audio")].map((a) => a.src),
      support: {
        m4a: document.createElement("audio").canPlayType("audio/mp4"),
        mp3: document.createElement("audio").canPlayType("audio/mpeg")
      }
    };
  })()`);

  assert.deepEqual(before.starts.filter((s) => s.startsWith("media:")), [], "voices stay silent until a voice button");
  assert.equal(before.melody, "idle");
  assert.equal(before.disabled, false, "open button is available immediately");
  assert.equal(before.openText, "Открыть дверь");
  assert.deepEqual(before.names, ["Мама", "Тая", "Папа"]);
  assert.deepEqual(before.icons, ["play", "play", "play"]);
  assert.equal(before.greetingHidden, true);
  assert.equal(before.melody, "idle");
  assert.equal(before.closed, true);
  assert.deepEqual(before.sources.map((src) => src.match(/\/(mama|taya|papa)\./)[1]), ["mama", "taya", "papa"]);
  for (const src of before.sources) {
    if (before.support.m4a) assert.match(src, /\.m4a$/);
    else assert.match(src, /\.mp3$/);
  }
  assert.equal(await waitFor(`document.getElementById("app").dataset.bell === "playing"`, 2500), true, "doorbell did not start when autoplay is allowed");
  assert.equal(await evaluate(`document.getElementById("app").dataset.melody`), "idle");
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
      starts: window.__audioStarts.slice(),
      bell: app.dataset.bell,
      melody: app.dataset.melody,
      overlap: app.dataset.overlap
    };
  })()`);
  assert.equal(opened.open, true, "first tap opens the door with no waiting step");
  assert.notEqual(opened.bell, "playing", "doorbell kept ringing after the door opened");
  assert.equal(opened.overlap, "0", "doorbell overlapped the melody");
  assert.ok(Date.now() - t0 < 1500, "open took too long: " + (Date.now() - t0));
  assert.equal(opened.greeting, "С днём рождения, Ульяна!");
  assert.deepEqual(opened.names, ["Мама", "Тая", "Папа"]);
  assert.equal(opened.hint, "Нажми, чтобы послушать");
  assert.deepEqual(opened.starts.filter((s) => s.startsWith("media:")), []);
  assert.ok(opened.starts.includes("audiocontext"));

  assert.equal(
    await waitFor(`document.getElementById("app").dataset.melody === "playing"`, 2000),
    true,
    "melody did not start"
  );
  await new Promise((r) => setTimeout(r, 1200));
  const family = await evaluate(`(() => {
    const app = document.getElementById("app");
    const img = document.querySelector("img.family");
    const box = img.getBoundingClientRect();
    return {
      bell: app.dataset.bell,
      melody: app.dataset.melody,
      overlap: app.dataset.overlap,
      src: img.currentSrc || img.src,
      opacity: getComputedStyle(img).opacity,
      width: box.width,
      height: box.height
    };
  })()`);
  assert.notEqual(family.bell, "playing");
  assert.equal(family.melody, "playing");
  assert.equal(family.overlap, "0");
  assert.match(family.src, /family\.(webp|jpe?g)$/);
  assert.ok(Number(family.opacity) > 0.9, "family did not appear in the doorway");
  assert.ok(family.width > 80 && family.height > 120);
  await shoot("opened_mobile.png");

  await click('.voice[data-file="mama"]');
  assert.equal(await waitFor(`(() => {
    const a = document.getElementById("mama");
    const app = document.getElementById("app");
    return !a.paused && app.dataset.melody === "stopped" && app.dataset.activeVoice === "mama";
  })()`), true, "mama did not start: " + JSON.stringify(await voiceState()));
  assert.equal(await waitFor(`window.__ctx && window.__ctx.state === "suspended"`), true, "melody context was not suspended");
  await new Promise((r) => setTimeout(r, 350));
  const mama = await voiceState();
  assert.equal(mama.melody, "stopped");
  assert.notEqual(mama.bell, "playing");
  assert.equal(mama.overlap, "0");
  assert.equal(mama.context, "suspended");
  assert.equal(mama.icons[0], "pause");
  assert.equal(mama.icons[1], "play");
  assert.equal(mama.icons[2], "play");
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
  assert.equal(still.context, "suspended");
  assert.ok(still.starts.filter((s) => s === "audiocontext").length === 1);

  await click('.voice[data-file="mama"]');
  assert.equal(await waitFor(`document.getElementById("mama").paused === true && document.getElementById("app").dataset.melody === "playing"`), true, "pause did not bring the melody back");
  const paused = await voiceState();
  assert.equal(paused.icons[0], "play");
  assert.equal(paused.paused[0], true);
  assert.ok(paused.times[0] > 0, "pause keeps the place");
  assert.equal(paused.melody, "playing");
  assert.equal(paused.context, "running");
  assert.equal(paused.overlap, "0");
  const pausedAt = paused.times[0];

  await click('.voice[data-file="mama"]');
  assert.equal(await waitFor(`!document.getElementById("mama").paused && document.getElementById("app").dataset.activeVoice === "mama"`), true, "resume did not play");
  await new Promise((r) => setTimeout(r, 200));
  const resumed = await voiceState();
  assert.equal(resumed.icons[0], "pause");
  assert.equal(resumed.paused[0], false);
  assert.ok(resumed.times[0] + 0.05 >= pausedAt, "resume restarted instead of continuing");
  assert.equal(resumed.melody, "stopped");
  assert.equal(resumed.context, "suspended");

  await click('.voice[data-file="taya"]');
  assert.equal(await waitFor(`!document.getElementById("taya").paused && document.getElementById("app").dataset.activeVoice === "taya"`), true, "taya did not start");
  const taya = await voiceState();
  assert.equal(taya.paused[0], true);
  assert.equal(taya.times[0], 0, "previous voice is stopped");
  assert.equal(taya.paused[1], false);
  assert.equal(taya.icons[0], "play");
  assert.equal(taya.icons[1], "pause");
  assert.equal(taya.icons[2], "play");
  assert.match(taya.sources[1], /\/taya\.(m4a|mp3)$/);
  assert.equal(taya.melody, "stopped");
  assert.notEqual(taya.bell, "playing");
  assert.equal(taya.overlap, "0");

  await click('.voice[data-file="papa"]');
  assert.equal(await waitFor(`!document.getElementById("papa").paused && document.getElementById("app").dataset.activeVoice === "papa"`), true, "papa did not start");
  const papa = await voiceState();
  assert.equal(papa.paused[1], true);
  assert.equal(papa.times[1], 0);
  assert.equal(papa.paused[2], false);
  assert.deepEqual(papa.icons, ["play", "play", "pause"]);
  assert.match(papa.sources[2], /\/papa\.(m4a|mp3)$/);
  assert.equal(papa.paused[0], true);
  assert.equal(papa.melody, "stopped");
  assert.notEqual(papa.bell, "playing");
  assert.equal(papa.overlap, "0");
  const media = papa.starts.filter((s) => s.startsWith("media:"));
  assert.deepEqual(media, ["media:mama", "media:mama", "media:taya", "media:papa"]);

  await evaluate(`document.getElementById("papa").dispatchEvent(new Event("ended"))`);
  assert.equal(await waitFor(`document.getElementById("app").dataset.melody === "playing"`), true, "melody did not return when the voice ended");
  const ended = await voiceState();
  assert.equal(ended.icons[2], "play");
  assert.equal(ended.active, "");
  assert.equal(ended.melody, "playing");
  assert.equal(ended.paused[2], true);
  assert.equal(ended.overlap, "0");

  await setViewport(1280, 800, false);
  await new Promise((r) => setTimeout(r, 200));
  await shoot("opened_desktop.png");

  await assertBellGesture(hook);
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

async function assertBellGesture(baseHook) {
  const gateHook = baseHook.replace(
    "var orig = HTMLAudioElement.prototype.play;",
    `var resumeN = 0;
    var origResume = AC.prototype.resume;
    var origSuspend = AC.prototype.suspend;
    AC.prototype.resume = function () {
      resumeN += 1;
      window.__resumeN = resumeN;
      if (resumeN === 1) {
        if (this.state === "running") return origSuspend.call(this);
        return Promise.resolve();
      }
      return origResume.apply(this, arguments);
    };
    var orig = HTMLAudioElement.prototype.play;`
  );
  const created = await send("Target.createTarget", { url: "about:blank" });
  const attached = await send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
  const sid = attached.sessionId;
  async function ev(expression) {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    }, sid);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result ? result.result.value : undefined;
  }
  async function clk(selector) {
    const box = await ev(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
    })()`);
    assert.ok(box && box.w > 0, "missing " + selector);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await send("Input.dispatchMouseEvent", {
        type, x: box.x, y: box.y, button: "left", clickCount: 1
      }, sid);
    }
  }
  async function until(expression, timeout = 2500) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await ev(`Boolean(${expression})`)) return true;
      await new Promise((r) => setTimeout(r, 40));
    }
    return false;
  }
  async function load() {
    const loaded = waitEvent("Page.loadEventFired", sid);
    await send("Page.navigate", { url: origin }, sid);
    await loaded;
    await new Promise((r) => setTimeout(r, 300));
  }
  await send("Page.enable", {}, sid);
  await send("Runtime.enable", {}, sid);
  await send("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 1, mobile: true
  }, sid);
  await send("Page.addScriptToEvaluateOnNewDocument", { source: gateHook }, sid);

  await load();
  assert.equal(await ev(`document.getElementById("app").dataset.bell`), "idle", "blocked autoplay still rang");
  await clk("#open-door");
  assert.equal(await until(`document.getElementById("app").dataset.melody === "playing"`), true, "open button did not start the melody");
  let state = await ev(`(() => {
    const app = document.getElementById("app");
    return { bell: app.dataset.bell, melody: app.dataset.melody, overlap: app.dataset.overlap };
  })()`);
  assert.notEqual(state.bell, "playing", "the open button started the doorbell");
  assert.equal(state.melody, "playing");
  assert.equal(state.overlap, "0");

  await load();
  assert.equal(await ev(`document.getElementById("app").dataset.bell`), "idle");
  await clk("#closed-title");
  assert.equal(await until(`document.getElementById("app").dataset.bell === "playing"`), true, "a tap outside the button did not ring");
  assert.equal(await ev(`document.getElementById("app").dataset.melody`), "idle");
  await clk("#open-door");
  assert.equal(await until(`document.getElementById("app").dataset.melody === "playing"`), true, "door did not open after the bell");
  state = await ev(`(() => {
    const app = document.getElementById("app");
    return { bell: app.dataset.bell, melody: app.dataset.melody, overlap: app.dataset.overlap };
  })()`);
  assert.notEqual(state.bell, "playing", "bell kept ringing over the melody");
  assert.equal(state.melody, "playing");
  assert.equal(state.overlap, "0");
  await send("Target.closeTarget", { targetId: created.targetId });
}

async function voiceState() {
  return evaluate(`(() => {
    const audios = ["mama", "taya", "papa"].map((id) => document.getElementById(id));
    const app = document.getElementById("app");
      return {
        melody: app.dataset.melody,
        active: app.dataset.activeVoice,
        icons: [...document.querySelectorAll(".voice")].map((b) => getComputedStyle(b.querySelector(".mark.pause")).display === "none" ? "play" : "pause"),
        paused: audios.map((a) => a.paused),
        times: audios.map((a) => a.currentTime),
        sources: audios.map((a) => a.currentSrc || a.src),
        starts: window.__audioStarts.slice(),
        context: window.__ctx ? window.__ctx.state : "",
        bell: app.dataset.bell,
        overlap: app.dataset.overlap
      };
  })()`);
}
