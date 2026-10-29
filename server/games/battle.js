import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { WebSocketServer, WebSocket } from "ws";
import { Game } from "../../public/games/battle/engine.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const token = () => randomBytes(32).toString("base64url");
const hash = (s) => createHash("sha256").update(s).digest("hex");
const idle = () => ({ d: -1, fire: false });
const fail = (status, message) => Object.assign(new Error(message), { status });
const exact = (obj, keys) =>
  obj &&
  typeof obj === "object" &&
  !Array.isArray(obj) &&
  Object.keys(obj).every((k) => keys.includes(k));
export function createBattleService({
  dbPath = process.env.DB_PATH || resolve(root, "data/game.sqlite"),
  origin = process.env.PUBLIC_ORIGIN || "",
  clock = Date.now,
} = {}) {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=0;
    CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT 'Игрок', level INTEGER NOT NULL DEFAULT 1, solo INTEGER NOT NULL DEFAULT 0, coop INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0, botWins INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS results (id TEXT PRIMARY KEY, profile TEXT NOT NULL, mode TEXT NOT NULL, level INTEGER NOT NULL, score INTEGER NOT NULL, outcome TEXT NOT NULL, bot INTEGER NOT NULL, created INTEGER NOT NULL);`);
  const rooms = new Map(),
    sockets = new Map(),
    membership = new Map(),
    limits = new Map();
  let stepDurations = [],
    closing = false;
  const profile = (id) =>
    db
      .prepare(
        "SELECT name,level,solo,coop,wins,botWins FROM profiles WHERE id=?",
      )
      .get(id);
  function limited(key, max, window = 60000) {
    const now = clock();
    let limit = limits.get(key);
    if (!limit || limit.until <= now) {
      limit = { until: now + window, count: 0 };
      limits.set(key, limit);
    }
    if (++limit.count > max)
      throw fail(429, "Слишком много запросов. Попробуйте чуть позже.");
  }
  function allowed(req) {
    if (!req.headers.origin) return false;
    const forwarded = req.headers["x-forwarded-proto"];
    const expected =
      origin ||
      `${forwarded === "https" ? "https" : "http"}://${req.headers.host}`;
    return req.headers.origin === expected;
  }
  function session(req, res) {
    const value = (req.headers.cookie || "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("tanks="))
      ?.slice(6);
    if (value && /^[\w-]{43}$/.test(value) && profile(hash(value)))
      return hash(value);
    if (!res) throw fail(401, "Сначала откройте игру.");
    limited(`profile:${req.socket.remoteAddress}`, 30);
    const secret = token(),
      id = hash(secret);
    db.prepare("INSERT INTO profiles(id) VALUES(?)").run(id);
    const secure =
      origin.startsWith("https:") ||
      req.headers["x-forwarded-proto"] === "https";
    res.setHeader(
      "Set-Cookie",
      `tanks=${secret}; HttpOnly; SameSite=Strict; Path=/game; Max-Age=31536000${secure ? "; Secure" : ""}`,
    );
    return id;
  }
  function roomFor(id) {
    return rooms.get(membership.get(id));
  }
  function roomView(room, id) {
    return {
      code: room.code,
      mode: room.mode,
      slot: room.slots.findIndex((s) => s.id === id),
      host: room.host === id,
      started: !!room.game,
      slots: room.slots.map((s, i) => ({
        name: s.id ? profile(s.id)?.name || "Игрок" : "Бот",
        bot: s.bot,
        ready: s.ready,
        reserved: !!s.id && s.until > clock(),
        slot: i,
      })),
    };
  }
  function send(ws, value) {
    if (ws?.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 131072) {
      if (++ws.slow > 10) ws.terminate();
      return;
    }
    ws.slow = 0;
    ws.send(JSON.stringify(value));
  }
  function broadcast(room) {
    for (const s of room.slots)
      if (s.id)
        send(sockets.get(s.id), { type: "room", room: roomView(room, s.id) });
  }
  function emptySlot() {
    return {
      id: null,
      bot: true,
      ready: true,
      until: 0,
      last: 0,
      input: idle(),
      seq: -1,
    };
  }
  function release(id, reason = "left") {
    const room = roomFor(id);
    if (!room) return;
    const slot = room.slots.find((s) => s.id === id);
    if (!slot) return;
    if (room.game && room.mode === "duel") room.hadBot = true;
    slot.bot = true;
    slot.input = idle();
    slot.queue = [];
    slot.ready = false;
    slot.until = clock() + 120000;
    if (!room.game) {
      slot.id = null;
      membership.delete(id);
    }
    if (room.host === id)
      room.host = room.slots.find((s) => s.id && !s.bot)?.id || null;
    if (!room.slots.some((s) => s.id && !s.bot)) {
      room.emptySince ||= clock();
      if (!room.game && !room.slots.some((s) => s.id)) rooms.delete(room.code);
    }
    broadcast(room);
    if (reason === "left") send(sockets.get(id), { type: "left" });
  }
  function attach(room, id, index) {
    const other = roomFor(id);
    if (other && other !== room) {
      release(id);
      const old = other.slots.find((s) => s.id === id);
      if (old) {
        old.id = null;
        old.until = 0;
      }
      membership.delete(id);
    }
    const s = room.slots[index],
      previous = s.id,
      replacingBot = s.bot;
    if (previous && previous !== id) membership.delete(previous);
    Object.assign(s, {
      id,
      bot: false,
      ready: false,
      until: 0,
      last: clock(),
      input: idle(),
      seq: -1,
      ack: -1,
      pendingAck: -1,
      inputAt: 0,
      queue: [],
      batched: false,
    });
    membership.set(id, room.code);
    room.emptySince = 0;
    room.host ||= id;
    if (room.game && room.mode === "duel" && replacingBot) room.hadBot = true;
    broadcast(room);
  }
  function createRoom(id, mode) {
    if (!["solo", "coop", "duel"].includes(mode))
      throw fail(400, "Неизвестный режим.");
    if (rooms.size >= 200)
      throw fail(503, "Все комнаты заняты. Попробуйте позже.");
    let code;
    do {
      code = randomBytes(5).toString("hex").slice(0, 8).toUpperCase();
    } while (rooms.has(code));
    const room = {
      code,
      mode,
      host: id,
      slots: Array.from({ length: mode === "solo" ? 1 : 2 }, emptySlot),
      game: null,
      emptySince: 0,
      created: clock(),
      hadBot: false,
      participants: new Set(),
      saved: new Set(),
      revision: 0,
    };
    rooms.set(code, room);
    attach(room, id, 0);
    if (mode === "solo") start(room, id);
    return room;
  }
  function start(room, id) {
    if (room.host !== id || room.game)
      throw fail(409, "Матч уже начался или ожидает создателя.");
    if (room.slots.some((s) => s.id && s.id !== id && !s.bot && !s.ready))
      throw fail(409, "Дождитесь готовности второго игрока.");
    room.game = new Game(
      room.mode,
      room.mode === "solo" ? profile(id).level : 1,
    );
    room.hadBot = room.slots.some((s) => s.bot);
    room.slots.filter((s) => s.id).forEach((s) => room.participants.add(s.id));
    room.slots.forEach((s) => (s.ready = false));
    room.revision++;
    broadcast(room);
  }
  async function body(req) {
    let body = "";
    for await (const part of req) {
      body += part;
      if (body.length > 1024) throw fail(413, "Запрос слишком большой.");
    }
    try {
      return JSON.parse(body);
    } catch {
      throw fail(400, "Некорректный запрос.");
    }
  }
  async function handleHttp(req, res) {
    const json = (status, data) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(JSON.stringify(data));
    };
    try {
      const url = new URL(req.url, "http://local");
      url.pathname = url.pathname.replace(
        /^\/game\/battle\/api(?=\/)/,
        "/game/api",
      );
      if (url.pathname === "/game/api/health")
        return json(200, { ok: true, rooms: rooms.size });
      if (url.pathname.startsWith("/game/api/")) {
        const ip = req.socket.remoteAddress;
        limited(`http:${ip}`, 240);
        if (!["GET", "PATCH", "POST"].includes(req.method))
          throw fail(405, "Метод не поддерживается.");
        if (req.method !== "GET" && !allowed(req))
          throw fail(403, "Запрос с другого сайта запрещён.");
        // Bound profile creation separately from ordinary authenticated reads.

        const id = session(req, res);
        if (url.pathname === "/game/api/profile" && req.method === "GET")
          return json(200, {
            profile: profile(id),
            room: roomFor(id) ? roomView(roomFor(id), id) : null,
          });
        if (url.pathname === "/game/api/profile" && req.method === "PATCH") {
          const b = await body(req);
          if (!exact(b, ["name"]) || typeof b.name !== "string")
            throw fail(400, "Укажите имя игрока.");
          const name = b.name.trim();
          if (
            [...name].length < 1 ||
            [...name].length > 16 ||
            /[\p{C}]/u.test(name)
          )
            throw fail(
              400,
              "Имя должно содержать от 1 до 16 видимых символов.",
            );
          db.prepare("UPDATE profiles SET name=? WHERE id=?").run(name, id);
          const room = roomFor(id);
          if (room) broadcast(room);
          return json(200, { profile: profile(id) });
        }
        if (url.pathname === "/game/api/rooms" && req.method === "POST") {
          limited(`create:${id}`, 10);
          limited(`create-ip:${ip}`, 30);
          const b = await body(req);
          if (!exact(b, ["mode"])) throw fail(400, "Некорректная комната.");
          return json(201, { room: roomView(createRoom(id, b.mode), id) });
        }
        if (url.pathname === "/game/api/join" && req.method === "POST") {
          limited(`join:${id}`, 20);
          limited(`join-ip:${ip}`, 40);
          const b = await body(req);
          if (
            !exact(b, ["code"]) ||
            typeof b.code !== "string" ||
            !/^[A-F0-9]{8}$/i.test(b.code)
          )
            throw fail(400, "Код комнаты — 8 символов.");
          const room = rooms.get(b.code.toUpperCase());
          if (!room || room.mode === "solo")
            throw fail(404, "Комната закрыта или не существует.");
          const now = clock(),
            own = room.slots.findIndex(
              (s) => s.id === id && (!s.bot || s.until > now),
            );
          const index =
            own >= 0
              ? own
              : room.slots.findIndex((s) => s.bot && (!s.id || s.until <= now));
          if (index < 0)
            throw fail(
              409,
              "Комната заполнена. Место может быть зарезервировано.",
            );
          attach(room, id, index);
          room.participants.add(id);
          return json(200, { room: roomView(room, id) });
        }
        throw fail(404, "Маршрут не найден.");
      }
      throw fail(404, "Маршрут не найден.");
    } catch (e) {
      if (!res.headersSent)
        json(e.status || 500, {
          error: e.status ? e.message : "Сервис временно недоступен.",
        });
      else res.end();
      if (!e.status) console.error(e);
    }
  }
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024,
    perMessageDeflate: false,
  });
  function handleUpgrade(req, socket, head) {
    try {
      if (
        !["/game/ws", "/game/battle/ws"].includes(
          new URL(req.url, "http://local").pathname,
        ) ||
        !allowed(req)
      )
        throw fail(403, "Forbidden");
      limited(`ws:${req.socket.remoteAddress}`, 40);
      const id = session(req);
      wss.handleUpgrade(req, socket, head, (ws) =>
        wss.emit("connection", ws, id),
      );
    } catch {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
  }
  wss.on("connection", (ws, id) => {
    const old = sockets.get(id);
    sockets.set(id, ws);
    if (old) {
      send(old, { type: "replaced" });
      old.close(4001, "Another connection");
    }
    ws.last = clock();
    ws.window = clock();
    ws.count = 0;
    ws.slow = 0;
    const room = roomFor(id),
      slot = room?.slots.findIndex((s) => s.id === id);
    if (
      room &&
      slot >= 0 &&
      (!room.slots[slot].bot || room.slots[slot].until > clock())
    )
      attach(room, id, slot);
    else if (room) {
      membership.delete(id);
      send(ws, { type: "left" });
    }
    ws.on("message", (raw) => {
      try {
        if (sockets.get(id) !== ws) return;
        const now = clock();
        if (now - ws.window >= 1000) {
          ws.window = now;
          ws.count = 0;
        }
        if (++ws.count > 90) {
          ws.close(1008, "Rate limit");
          return;
        }
        let b;
        try {
          b = JSON.parse(raw.toString());
        } catch {
          throw fail(400, "Некорректное сообщение.");
        }
        const room = roomFor(id),
          s = room?.slots.find((s) => s.id === id);
        if (b?.type === "ping" && exact(b, ["type", "time"])) {
          ws.last = now;
          if (s && !s.bot) s.last = now;
          send(ws, { type: "pong", time: b.time });
          return;
        }
        if (!room || !s) throw fail(409, "Сначала войдите в комнату.");
        if (b?.type === "inputs") {
          if (
            !exact(b, ["type", "code", "revision", "commands"]) ||
            typeof b.code !== "string" ||
            !Number.isSafeInteger(b.revision) ||
            !Array.isArray(b.commands) ||
            b.commands.length < 1 ||
            b.commands.length > 8 ||
            b.commands.some(
              (c) =>
                !exact(c, ["seq", "d", "fire"]) ||
                !Number.isSafeInteger(c.seq) ||
                c.seq < 0 ||
                !Number.isInteger(c.d) ||
                c.d < -1 ||
                c.d > 3 ||
                typeof c.fire !== "boolean",
            )
          )
            throw fail(400, "Недопустимое управление.");
          if (
            s.bot ||
            b.code !== room.code ||
            b.revision !== room.revision ||
            !room.game ||
            room.game.state !== "play"
          )
            return;
          s.batched = true;
          s.inputAt = s.last = now;
          for (const command of b.commands) {
            if (command.seq <= s.seq) continue;
            s.seq = command.seq;
            s.queue.push(command);
          }
          // Discard stale intent rather than accumulating delayed movement.
          while (s.queue.length > 12) s.ack = s.queue.shift().seq;
        } else if (b?.type === "input") {
          if (
            !exact(b, ["type", "seq", "d", "fire"]) ||
            !Number.isSafeInteger(b.seq) ||
            b.seq < 0 ||
            !Number.isInteger(b.d) ||
            b.d < -1 ||
            b.d > 3 ||
            typeof b.fire !== "boolean"
          )
            throw fail(400, "Недопустимое управление.");
          if (b.seq <= s.seq || s.bot) return;
          s.batched = false;
          s.queue = [];
          s.seq = b.seq;
          s.input = { d: b.d, fire: b.fire };
          s.inputAt = now;
          s.last = now;
          // Input sequence is acknowledged only after the server consumes the state.
          s.pendingAck = b.seq;
        } else {
          if (
            !exact(b, ["type", "ready"]) ||
            (b.type !== "ready" && Object.hasOwn(b, "ready"))
          )
            throw fail(400, "Недопустимая команда.");
          limited(`action:${id}`, 12, 1000);
          s.last = now;
          if (b.type === "leave") {
            release(id);
            return;
          }
          if (s.bot) throw fail(409, "Подключитесь к комнате заново.");
          if (
            b.type === "ready" &&
            !room.game &&
            typeof b.ready === "boolean"
          ) {
            s.ready = b.ready;
            broadcast(room);
          } else if (b.type === "start") start(room, id);
          else if (
            b.type === "next" &&
            room.game &&
            room.game.state !== "play"
          ) {
            if (!room.saved.has(`${room.revision}:${room.game.state}`))
              throw fail(409, "Дождитесь сохранения результата и повторите.");
            if (
              room.mode === "duel" &&
              room.slots.some((t) => !t.bot && t !== s && !t.ready)
            ) {
              s.ready = true;
              broadcast(room);
              return;
            }
            room.game.next();
            room.revision++;
            room.saved.clear();
            room.hadBot = room.slots.some((t) => t.bot);
            room.participants = new Set(
              room.slots.filter((t) => t.id).map((t) => t.id),
            );
            room.slots.forEach((t) => {
              t.ready = false;
              t.input = idle();
              t.ack = -1;
              t.pendingAck = -1;
              t.queue = [];
            });
            broadcast(room);
          } else if (b.type === "pause" && room.mode === "solo" && room.game)
            room.game.paused = !room.game.paused;
          else throw fail(409, "Действие сейчас недоступно.");
        }
      } catch (e) {
        send(ws, {
          type: "error",
          message: e.status ? e.message : "Ошибка сервера.",
        });
        if (!e.status) console.error(e);
      }
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      if (!closing && sockets.get(id) === ws) {
        sockets.delete(id);
        release(id, "disconnect");
      }
    });
  });
  function saveResult(room) {
    const g = room.game,
      key = `${room.revision}:${g.state}`;
    if (room.saved.has(key)) return;
    // Transaction only at a level boundary, never a write per simulation tick.
    db.exec("BEGIN");
    try {
      for (const id of room.participants) {
        const slot = room.slots.findIndex((s) => s.id === id),
          win = g.mode === "duel" && g.winner === slot;
        const outcome =
          g.mode === "duel"
            ? g.winner === null
              ? "draw"
              : win
                ? "win"
                : "lose"
            : g.state;
        db.prepare("INSERT INTO results VALUES(?,?,?,?,?,?,?,?)").run(
          token(),
          id,
          g.mode,
          g.level,
          g.score,
          outcome,
          room.hadBot ? 1 : 0,
          clock(),
        );
        if (g.mode === "solo")
          db.prepare(
            "UPDATE profiles SET solo=MAX(solo,?),level=MAX(level,?) WHERE id=?",
          ).run(
            g.score,
            g.state === "win" ? Math.min(g.level + 1, 99) : g.level,
            id,
          );
        if (g.mode === "coop")
          db.prepare("UPDATE profiles SET coop=MAX(coop,?) WHERE id=?").run(
            g.score,
            id,
          );
        if (win)
          db.prepare(
            `UPDATE profiles SET ${room.hadBot ? "botWins" : "wins"}=${room.hadBot ? "botWins" : "wins"}+1 WHERE id=?`,
          ).run(id);
      }
      db.exec("COMMIT");
      room.saved.add(key);
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  function step() {
    const begun = performance.now(),
      now = clock();
    for (const [code, room] of rooms) {
      for (const s of room.slots)
        if (s.id && !s.bot && now - s.last > 2000) {
          release(s.id, "timeout");
          if (room.mode === "duel") room.hadBot = true;
        }
      if (!room.slots.some((s) => s.id && !s.bot)) {
        room.emptySince ||= now;
        if (now - room.emptySince >= 120000) {
          for (const s of room.slots)
            if (s.id) {
              if (membership.get(s.id) === code) {
                membership.delete(s.id);
                send(sockets.get(s.id), { type: "left" });
              }
            }
          rooms.delete(code);
        }
        continue;
      }
      const g = room.game;
      if (!g) continue;
      for (const s of room.slots) if (s.id) room.participants.add(s.id);
      g.step(
        room.slots.map((s, i) => {
          if (s.bot) return g.botInput(g.players[i]);
          if (s.batched) {
            if (now - (s.inputAt || 0) > 250) {
              s.queue = [];
              s.ack = s.seq;
              return idle();
            }
            const command = s.queue.shift();
            if (command) s.ack = command.seq;
            return command || idle();
          }
          s.ack = s.pendingAck ?? -1;
          return now - (s.inputAt || 0) > 250 ? idle() : s.input;
        }),
      );
      if (g.state !== "play" && now >= (room.saveRetryAt || 0)) {
        try {
          saveResult(room);
        } catch (e) {
          room.saveRetryAt = now + 1000;
          console.error("Save failed", e);
          for (const s of room.slots)
            send(sockets.get(s.id), {
              type: "error",
              message: "Результат пока не сохранён. Сервер повторит попытку.",
            });
        }
      }
    }
    stepDurations.push(performance.now() - begun);
    if (stepDurations.length > 3600) stepDurations.shift();
  }
  let previous = performance.now(),
    acc = 0,
    snapshotAcc = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    acc += Math.min(now - previous, 100);
    previous = now;
    while (acc >= 1000 / 60) {
      step();
      acc -= 1000 / 60;
    }
    snapshotAcc += now - (lastBroadcast || now);
    lastBroadcast = now;
    if (snapshotAcc >= 50) {
      snapshotAcc %= 50;
      for (const room of rooms.values())
        if (room.game && !room.emptySince)
          for (const s of room.slots)
            if (s.id && !s.bot)
              send(sockets.get(s.id), {
                type: "snapshot",
                code: room.code,
                revision: room.revision,
                ack: s.ack ?? -1,
                time: clock(),
                world: room.game.snapshot(),
              });
    }
  }, 4);
  let lastBroadcast = performance.now();
  const cleanup = setInterval(() => {
    const now = clock();
    for (const [key, v] of limits) if (v.until < now) limits.delete(key);
    for (const [id, ws] of sockets)
      if (now - ws.last > 10000) {
        ws.terminate();
        sockets.delete(id);
        release(id, "timeout");
      }
  }, 1000);
  return {
    ownsHttp: (path) =>
      path.startsWith("/game/battle/api/") || path.startsWith("/game/api/"),
    ownsUpgrade: (path) => ["/game/battle/ws", "/game/ws"].includes(path),
    handleHttp,
    handleUpgrade,
    rooms,
    db,
    step,
    metrics: () => stepDurations.slice(),
    async close() {
      closing = true;
      clearInterval(timer);
      clearInterval(cleanup);
      for (const ws of wss.clients) ws.terminate();
      db.close();
    },
  };
}
