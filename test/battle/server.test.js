import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import WebSocket from "ws";
import { createApp } from "../../server/app.js";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fixture(t, options = {}) {
  const app = createApp({ dbPath: ":memory:", ...options });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + app.server.address().port;
  t.after(() => app.close());
  async function player() {
    const initial = await fetch(base + "/game/api/profile"),
      cookie = initial.headers.get("set-cookie").split(";")[0];
    const request = async (path, method = "GET", data) => {
      const res = await fetch(base + "/game/api/" + path, {
        method,
        headers: { cookie, Origin: base, "Content-Type": "application/json" },
        body: data ? JSON.stringify(data) : undefined,
      });
      return { status: res.status, ...(await res.json()) };
    };
    async function socket() {
      const ws = new WebSocket(base.replace("http", "ws") + "/game/ws", {
          headers: { cookie, Origin: base },
        }),
        messages = [];
      ws.on("message", (raw) => messages.push(JSON.parse(raw)));
      await once(ws, "open");
      return {
        ws,
        messages,
        send: (b) => ws.send(JSON.stringify(b)),
        async wait(type, predicate = () => true) {
          for (let n = 0; n < 200; n++) {
            const found = messages.find((b) => b.type === type && predicate(b));
            if (found) return found;
            await sleep(10);
          }
          throw Error("Timed out waiting for " + type);
        },
      };
    }
    return { cookie, request, socket, initial: await initial.json() };
  }
  return { ...app, base, player };
}
test("profile validation, same-origin enforcement and persistent server records", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), "tanks-test-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const f = await fixture(t, { dbPath: join(folder, "game.sqlite") }),
    a = await f.player();
  assert.match(a.cookie, /^tanks=/);
  assert.equal(a.initial.profile.level, 1);
  assert.equal(
    (await a.request("profile", "PATCH", { name: "  Танкист  " })).profile.name,
    "Танкист",
  );
  assert.equal(
    (await a.request("profile", "PATCH", { name: "A".repeat(17) })).status,
    400,
  );
  assert.equal(
    (await a.request("profile", "PATCH", { name: "ok", score: 999 })).status,
    400,
  );
  assert.equal(
    (await a.request("profile", "PATCH", { name: "\u0000" })).status,
    400,
  );
  const foreign = await fetch(f.base + "/game/api/rooms", {
    method: "POST",
    headers: {
      cookie: a.cookie,
      Origin: "https://evil.example",
      "Content-Type": "application/json",
    },
    body: '{"mode":"solo"}',
  });
  assert.equal(foreign.status, 403);
  const second = createApp({ dbPath: join(folder, "game.sqlite") });
  t.after(() => second.close());
  assert.equal(
    second.db.prepare("SELECT name FROM profiles").get().name,
    "Танкист",
  );
});
test("room with bot, input tampering, disconnect, takeover, expiry, and creator exit", async (t) => {
  let now = Date.now();
  const f = await fixture(t, { clock: () => now }),
    a = await f.player(),
    b = await f.player(),
    c = await f.player();
  const sa = await a.socket(),
    sb = await b.socket();
  const created = await a.request("rooms", "POST", { mode: "coop" });
  assert.equal(created.status, 201);
  sa.send({ type: "start" });
  await sa.wait("snapshot");
  const r = f.rooms.get(created.room.code),
    g = r.game;
  assert.equal(g.level, 1);
  assert.equal(r.slots[1].bot, true);
  assert.equal((await b.request("join", "POST", { code: r.code })).status, 200);
  assert.equal(r.slots[1].bot, false);
  await sb.wait("snapshot");
  const oldX = g.players[0].x,
    oldScore = g.score;
  sa.send({ type: "input", seq: 1, d: 1, fire: false, score: 99999 });
  await sa.wait("error");
  f.step();
  assert.equal(g.score, oldScore);
  assert.equal(g.players[0].x, oldX);
  sa.send({ type: "input", seq: 2, d: 3, fire: false });
  await sleep(20);
  f.step();
  assert(g.players[0].x < oldX);
  const x = g.players[0].x;
  sa.send({ type: "input", seq: 1, d: 1, fire: false });
  await sleep(20);
  assert(g.players[0].x <= x);
  g.players[0].lives = 2;
  g.players[0].lv = 2;
  const ticks = g.tick;
  sa.ws.terminate();
  await sleep(30);
  f.step();
  assert.equal(r.slots[0].bot, true);
  assert(g.tick > ticks);
  assert.equal(r.host, r.slots[1].id);
  const back = await a.socket();
  await back.wait("snapshot");
  assert.equal(r.slots[0].bot, false);
  assert.equal(g.players[0].lives, 2);
  assert.equal(g.players[0].lv, 2);
  back.ws.terminate();
  await sleep(20);
  now += 120001;
  sb.send({ type: "ping", time: now });
  await sleep(20);
  f.step();
  assert.equal((await c.request("join", "POST", { code: r.code })).status, 200);
  assert.equal(r.slots[0].bot, false);
  assert.equal((await a.request("join", "POST", { code: r.code })).status, 409);
  sb.send({ type: "leave" });
  await sb.wait("left");
  assert.equal(r.slots[1].bot, true);
  assert.equal(r.game, g);
});
test("ready gates, replays, anonymous access, payload limits and one controlling tab", async (t) => {
  const f = await fixture(t),
    a = await f.player(),
    b = await f.player();
  const sa = await a.socket();
  const r = (await a.request("rooms", "POST", { mode: "duel" })).room;
  const sb = await b.socket();
  await b.request("join", "POST", { code: r.code });
  sa.send({ type: "start" });
  await sa.wait("error");
  assert.equal(f.rooms.get(r.code).game, null);
  sb.send({ type: "ready", ready: true });
  await sb.wait("room", (b) => b.room.slots[1].ready);
  sa.send({ type: "start" });
  await sa.wait("snapshot");
  const room = f.rooms.get(r.code);
  assert(room.game);
  assert.equal(room.hadBot, false);
  const replacement = await a.socket();
  await replacement.wait("snapshot");
  await sa.wait("replaced");
  assert.equal(room.slots[0].bot, false);
  room.game.bases[1].alive = false;
  f.step();
  assert.equal((await a.request("profile")).profile.wins, 1);
  f.step();
  assert.equal((await a.request("profile")).profile.wins, 1);
  replacement.send({ type: "next" });
  await sleep(30);
  assert.equal(room.game.state, "done");
  sb.send({ type: "next" });
  await sleep(30);
  assert.equal(room.game.state, "play");
  replacement.ws.send("x".repeat(2048));
  await once(replacement.ws, "close");
  await sleep(20);
  assert.equal(room.slots[0].bot, true);
  assert.equal(room.hadBot, true);
  const alien = new WebSocket(f.base.replace("http", "ws") + "/game/ws", {
    headers: { Origin: f.base },
  });
  const rejected = await new Promise((r) =>
    alien.once("unexpected-response", (_, res) => {
      res.resume();
      r(res.statusCode);
    }),
  );
  assert.equal(rejected, 403);
});
test("abandoned room expires and solo progression comes only from simulation", async (t) => {
  let now = Date.now();
  const f = await fixture(t, { clock: () => now }),
    a = await f.player(),
    sa = await a.socket();
  const r = (await a.request("rooms", "POST", { mode: "solo" })).room;
  await sa.wait("snapshot");
  const room = f.rooms.get(r.code);
  room.game.todo = 0;
  room.game.enemies = [];
  room.game.score = 1234;
  f.step();
  const p = (await a.request("profile")).profile;
  assert.equal(p.level, 2);
  assert.equal(p.solo, 1234);
  sa.ws.terminate();
  await sleep(20);
  now += 120001;
  f.step();
  assert.equal(f.rooms.has(r.code), false);
  assert.equal((await a.request("profile")).room, null);
});

test("50/150/300ms RTT and jitter do not pause another player", async (t) => {
  const { default: http } = await import("node:http");
  const { WebSocketServer } = await import("ws");
  const f = await fixture(t),
    a = await f.player(),
    b = await f.player(),
    sa = await a.socket();
  const code = (await a.request("rooms", "POST", { mode: "coop" })).room.code;
  sa.send({ type: "start" });
  await sa.wait("snapshot");
  await b.request("join", "POST", { code });
  const proxy = http.createServer(),
    wss = new WebSocketServer({ server: proxy }),
    timers = new Set();
  let half = 25;
  wss.on("connection", (client) => {
    const upstream = new WebSocket(f.base.replace("http", "ws") + "/game/ws", {
      headers: { cookie: b.cookie, Origin: f.base },
    });
    const defer = (target, data) => {
      const timer = setTimeout(
        () => {
          timers.delete(timer);
          if (target.readyState === 1) target.send(data.toString());
        },
        Math.max(0, half + (Math.random() - 0.5) * 30),
      );
      timers.add(timer);
    };
    client.on("message", (data) => defer(upstream, data));
    upstream.on("message", (data) => defer(client, data));
    client.on("close", () => upstream.terminate());
    upstream.on("error", () => client.terminate());
  });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const delayed = new WebSocket("ws://127.0.0.1:" + proxy.address().port);
  delayed.on("error", () => {});
  await once(delayed, "open");
  let seq = 0,
    count = 0;
  delayed.on("message", (raw) => {
    if (JSON.parse(raw).type === "snapshot") count++;
  });
  const timer = setInterval(() => {
    if (delayed.readyState === 1)
      delayed.send(
        JSON.stringify({ type: "input", seq: seq++, d: -1, fire: true }),
      );
    sa.send({ type: "input", seq: seq++, d: -1, fire: false });
  }, 1000 / 30);
  t.after(async () => {
    clearInterval(timer);
    for (const timer of timers) clearTimeout(timer);
    delayed.terminate();
    for (const ws of wss.clients) ws.terminate();
    await new Promise((r) => proxy.close(r));
  });
  for (const rtt of [50, 150, 300]) {
    half = rtt / 2;
    const room = f.rooms.get(code),
      tick = room.game.tick;
    await sleep(750);
    assert(room.game.tick > tick + 25);
    assert.equal(room.slots[1].bot, false);
  }
  assert(count > 20);
});

test("a locked results database does not stall rooms or discard a completed level", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const folder = await mkdtemp(join(tmpdir(), "tanks-lock-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  let now = Date.now();
  const path = join(folder, "game.sqlite"),
    f = await fixture(t, { dbPath: path, clock: () => now }),
    a = await f.player(),
    b = await f.player();
  const sa = await a.socket(),
    sb = await b.socket();
  const first = (await a.request("rooms", "POST", { mode: "solo" })).room.code,
    second = (await b.request("rooms", "POST", { mode: "solo" })).room.code;
  await sa.wait("snapshot");
  await sb.wait("snapshot");
  const r = f.rooms.get(first),
    other = f.rooms.get(second);
  const lock = new DatabaseSync(path);
  t.after(() => lock.close());
  lock.exec("BEGIN IMMEDIATE");
  t.mock.method(console, "error", () => {});
  r.game.todo = 0;
  r.game.enemies = [];
  r.game.score = 1500;
  const tick = other.game.tick,
    started = performance.now();
  f.step();
  assert(performance.now() - started < 100);
  assert(other.game.tick > tick);
  sa.send({ type: "next" });
  await sa.wait("error", (b) => b.message.includes("сохранения"));
  assert.equal(r.game.level, 1);
  lock.exec("ROLLBACK");
  now += 1001;
  f.step();
  assert.equal((await a.request("profile")).profile.solo, 1500);
  sa.send({ type: "next" });
  await sa.wait("snapshot", (b) => b.world.level === 2);
});

test("batched input advances one fixed step per tick and rejects stale rooms or injected state", async (t) => {
  let now = Date.now();
  const f = await fixture(t, { clock: () => now }),
    a = await f.player(),
    sa = await a.socket();
  const code = (await a.request("rooms", "POST", { mode: "solo" })).room.code;
  await sa.wait("snapshot");
  const room = f.rooms.get(code),
    slot = room.slots[0];
  const commands = Array.from({ length: 8 }, (_, i) => ({
    seq: i + 1,
    d: 0,
    fire: false,
  }));
  sa.send({ type: "inputs", code, revision: room.revision, commands });
  for (let i = 0; i < 50 && !slot.queue.length; i++) await sleep(1);
  assert(slot.queue.length > 0);
  const next = slot.queue[0].seq,
    queued = slot.queue.length,
    y = room.game.players[0].y;
  f.step();
  assert.equal(slot.ack, next);
  assert.equal(slot.queue.length, queued - 1);
  assert.equal(room.game.players[0].y, y - 1.5);
  const seq = slot.seq;
  sa.send({
    type: "inputs",
    code: "OTHER",
    revision: room.revision,
    commands: [{ seq: seq + 1, d: 1, fire: true }],
  });
  await sleep(5);
  assert.equal(slot.seq, seq);
  sa.send({
    type: "inputs",
    code,
    revision: room.revision,
    commands: [{ seq: seq + 1, d: 1, fire: true, score: 99999 }],
  });
  await sa.wait("error");
  assert.equal(room.game.score, 0);
  sa.send({ type: "inputs", code, revision: room.revision, commands });
  await sleep(5);
  assert.equal(slot.seq, seq);
  now += 251;
  const before = room.game.players[0].y;
  f.step();
  assert.equal(slot.queue.length, 0);
  assert.equal(room.game.players[0].y, before);
});
