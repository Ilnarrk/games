import { ClientSimulation } from "./netcode.js";
import { renderer } from "./render.js";
const $ = (id) => document.getElementById(id),
  draw = renderer($("c"));
let profile,
  room,
  ws,
  world,
  lastSnapshot = 0,
  revision = -1,
  screen = "menu",
  settingsReturn = "menu",
  connected = false,
  replaced = false,
  reconnectTimer;
const simulation = new ClientSimulation();
let pausedByMenu = false,
  lastHud = "",
  lastResult = "";
let stickPointer = null;
const keys = new Map(),
  touches = new Map();
let joystickDirection = -1,
  firePointers = new Set(),
  control = "arrows";
try {
  control =
    localStorage.getItem("tanks-controls") === "joystick"
      ? "joystick"
      : "arrows";
} catch {}
function notice(message) {
  $("notice").textContent = message;
  $("notice").hidden = !message;
}
function connection(text, online = false) {
  $("connection").textContent = text;
  $("led").classList.toggle("online", online);
}
async function api(path, method = "GET", body) {
  const res = await fetch("/game/battle/api/" + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw Error(data.error || "Не удалось выполнить запрос.");
  return data;
}
function controls() {
  $("arrows").hidden = control !== "arrows";
  $("joystick").hidden = control !== "joystick";
  document.querySelector(`input[name="controls"][value="${control}"]`).checked =
    true;
}
function clearInput() {
  stickPointer = null;
  keys.clear();
  touches.clear();
  joystickDirection = -1;
  firePointers.clear();
  $("stick").style.transform = "";
  document
    .querySelectorAll(".pressed")
    .forEach((b) => b.classList.remove("pressed"));
}
function input() {
  if (screen !== "battle" || !connected || document.hidden)
    return { d: -1, fire: false };
  const values = [...keys.values(), ...touches.values()];
  return {
    d:
      joystickDirection >= 0
        ? joystickDirection
        : (values.filter((v) => typeof v === "number").at(-1) ?? -1),
    fire: keys.has(" ") || firePointers.size > 0,
  };
}
function show(id) {
  if (screen !== id) clearInput();
  screen = id;
  document.querySelectorAll(".page").forEach((p) => (p.hidden = p.id !== id));
  $("pad").inert = id !== "battle";
  $("pad").classList.toggle("inactive", id !== "battle");
  $("pad").setAttribute("aria-disabled", String(id !== "battle"));
  document.body.classList.toggle("playing", id === "battle");
  notice("");
  const heading = $(id).querySelector("h1,h2");
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
}
function send(message) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
    return true;
  }
  notice("Нет связи с сервером. Подключение восстанавливается…");
  return false;
}
function updateProfile(p) {
  profile = p;
  $("player-label").textContent = p.name;
  $("record").textContent = "Рекорд " + p.solo;
  $("name").value = p.name;
}
function updateRoom(r) {
  room = r;
  if (r) simulation.setRoom(r.code, r.slot);
  else simulation.reset();
  $("resume").hidden = !r;
  if (!r) return;
  $("room-title").textContent = r.mode === "duel" ? "Дуэль" : "Вместе";
  $("room-code").textContent = r.code;
  $("slots").replaceChildren(
    ...r.slots.map((s) => {
      const el = document.createElement("div");
      el.className = "slot";
      const name = document.createElement("span"),
        state = document.createElement("small");
      name.textContent = `${s.slot + 1}. ${s.name}`;
      state.textContent = s.bot
        ? s.reserved
          ? "Бот · место занято"
          : "Бот"
        : s.ready
          ? "Готов"
          : "В комнате";
      el.append(name, state);
      return el;
    }),
  );
  const own = r.slots[r.slot];
  $("ready").hidden = r.host || r.started;
  $("ready").textContent = own?.ready ? "Отменить готовность" : "Готов к бою";
  $("start").hidden = !r.host || r.started;
  $("start").textContent = r.slots.some((s) => s.bot)
    ? "Начать с ботом"
    : "Начать бой";
  $("start").disabled =
    !connected || r.slots.some((s) => !s.bot && s.slot !== r.slot && !s.ready);
  $("ingame-invite").hidden = r.mode === "solo";
  if (!r.started && !["settings", "lobby"].includes(screen)) show("lobby");
}
function connect() {
  if (replaced) return;
  clearTimeout(reconnectTimer);
  ws = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/game/battle/ws`,
  );
  const socket = ws;
  ws.onopen = () => {
    if (ws !== socket) return;
    connected = true;
    simulation.reconnect();
    lastSnapshot = performance.now();
    connection("В сети", true);
    if (room) updateRoom(room);
  };
  ws.onmessage = (e) => {
    if (ws !== socket) return;
    const b = JSON.parse(e.data);
    if (b.type === "room") {
      updateRoom(b.room);
      return;
    }
    if (b.type === "left") {
      room = null;
      world = null;
      simulation.reset();
      $("resume").hidden = true;
      if (screen !== "settings") show("menu");
      return;
    }
    if (b.type === "error") {
      notice(b.message);
      return;
    }
    if (b.type === "replaced") {
      replaced = true;
      connected = false;
      connection("Другая вкладка");
      clearInput();
      show("menu");
      notice(
        "Игра открыта в другой вкладке. Закрой её и обнови эту страницу, чтобы вернуть управление.",
      );
      return;
    }
    if (b.type === "pong") {
      const rtt = Math.max(0, Date.now() - b.time);
      connection(rtt + " мс", true);
      return;
    }
    if (b.type !== "snapshot") return;
    const now = performance.now(),
      changed = revision !== b.revision;
    if (!simulation.accept(b, now)) return;
    world = simulation.world;
    revision = b.revision;
    lastSnapshot = now;
    if (world.state === "play") {
      if (changed || screen === "lobby" || screen === "menu") show("battle");
      $("arena-note").hidden = !world.paused;
      $("arena-note").textContent = "Пауза";
      const hud = `${world.level},${world.score},${world.todo + world.enemies.length},${world.players.map((p) => p.lives + ":" + p.lv).join()},${room?.slots.map((s) => s.bot).join()}`;
      if (hud !== lastHud) {
        lastHud = hud;
        $("level").textContent =
          world.mode === "duel" ? "Дуэль" : `Уровень ${world.level}/99`;
        $("score").textContent =
          world.mode === "duel" ? "Защити базу" : `Счёт ${world.score}`;
        $("lives").textContent = world.players
          .map(
            (p, i) =>
              `${i + 1}P ${p.lives}♥${p.lv ? " " + "★".repeat(p.lv) : ""}${room?.slots[i]?.bot ? " БОТ" : ""}`,
          )
          .join("  ");
        $("enemy-count").textContent =
          world.mode === "duel"
            ? ""
            : `Враги ${world.todo + world.enemies.length}`;
      }
    } else {
      const key = `${revision}:${world.state}`;
      if (lastResult !== key) {
        lastResult = key;
        show("result");
        $("result-title").textContent =
          world.mode === "duel"
            ? world.winner === null
              ? "Ничья"
              : world.winner === room?.slot
                ? "Победа!"
                : "База потеряна"
            : world.state === "win"
              ? world.level === 99
                ? "Все 99 пройдены!"
                : "Уровень пройден!"
              : "Игра окончена";
        $("result-score").textContent =
          world.mode === "duel"
            ? world.players.map((p) => p.lives + "♥").join(" : ")
            : String(world.score);
        $("result-detail").textContent =
          world.mode === "duel"
            ? "База и жизни решают исход боя."
            : `Уровень ${world.level} · ${world.mode === "coop" ? "Командный" : "Твой"} счёт`;
        $("next").textContent =
          world.mode === "duel"
            ? "Реванш"
            : world.state === "win" && world.level < 99
              ? "Следующий уровень"
              : "Играть снова";
        api("profile")
          .then((b) => updateProfile(b.profile))
          .catch(() =>
            notice("Не удалось обновить профиль. Попробуйте позже."),
          );
      }
    }
  };
  ws.onclose = () => {
    if (ws !== socket) return;
    connected = false;
    clearInput();
    if (!replaced) {
      connection("Восстанавливаем связь…");
      reconnectTimer = setTimeout(connect, 1000);
    }
  };
  ws.onerror = () => {};
}
function reconnect() {
  if (replaced) return;
  if (ws) {
    ws.onclose = null;
    ws.onmessage = null;
    ws.close();
  }
  connected = false;
  clearInput();
  connection("Восстанавливаем связь…");
  connect();
}
addEventListener("online", reconnect);
addEventListener("offline", () => {
  connected = false;
  clearInput();
  connection("Нет сети");
});
function settings(from) {
  settingsReturn = from;
  $("name").value = profile?.name || "Игрок";
  controls();
  show("settings");
}
function menuDuringBattle() {
  clearInput();
  pausedByMenu = world?.mode === "solo" && !world.paused;
  if (pausedByMenu) send({ type: "pause" });
  $("pause-note").textContent =
    world?.mode === "solo"
      ? "Игра на паузе."
      : "Бой продолжается. Вернись, чтобы защитить базу.";
  show("battle-options");
}
function backToBattle() {
  if (pausedByMenu) {
    send({ type: "pause" });
    pausedByMenu = false;
  }
  show("battle");
}
function requireConnection() {
  if (!connected)
    throw Error(
      replaced
        ? "Игра открыта в другой вкладке. Обновите страницу."
        : "Дождитесь подключения к серверу.",
    );
}
async function busy(button, action) {
  button.disabled = true;
  notice("");
  try {
    await action();
  } catch (e) {
    notice(e.message);
  } finally {
    button.disabled = false;
  }
}
document
  .querySelectorAll("[data-screen]")
  .forEach(
    (b) =>
      (b.onclick = () =>
        b.dataset.screen === "settings"
          ? settings("menu")
          : show(b.dataset.screen)),
  );
for (const mode of ["solo", "coop", "duel"])
  $(mode).onclick = () =>
    busy($(mode), async () => {
      requireConnection();
      const b = await api("rooms", "POST", { mode });
      lastResult = "";
      updateRoom(b.room);
      world = simulation.world;
      revision = simulation.revision;
      show(mode === "solo" ? "battle" : "lobby");
    });
$("join-form").onsubmit = (e) => {
  e.preventDefault();
  busy(e.submitter, async () => {
    requireConnection();
    const b = await api("join", "POST", {
      code: $("code").value.trim().toUpperCase(),
    });
    lastResult = "";
    updateRoom(b.room);
    world = simulation.world;
    revision = simulation.revision;
    show(b.room.started ? "battle" : "lobby");
  });
};
$("settings-form").onsubmit = (e) => {
  e.preventDefault();
  busy(e.submitter, async () => {
    const b = await api("profile", "PATCH", { name: $("name").value });
    updateProfile(b.profile);
    control = document.querySelector("input[name=controls]:checked").value;
    try {
      localStorage.setItem("tanks-controls", control);
    } catch {}
    controls();
    show(settingsReturn);
    notice("Настройки сохранены.");
  });
};
$("settings-back").onclick = () => show(settingsReturn);
$("resume").onclick = () => {
  if (room) show(room.started ? "battle" : "lobby");
};
$("ready").onclick = () =>
  send({ type: "ready", ready: !room.slots[room.slot].ready });
$("start").onclick = () => send({ type: "start" });
$("next").onclick = () => {
  if (send({ type: "next" })) {
    if (world?.mode === "duel") notice("Ожидаем готовности соперника…");
  }
};
document.querySelectorAll(".leave").forEach(
  (b) =>
    (b.onclick = () => {
      if (send({ type: "leave" })) {
        pausedByMenu = false;
        room = null;
        world = null;
        simulation.reset();
        $("resume").hidden = true;
        show("menu");
      }
    }),
);
$("battle-menu").onclick = menuDuringBattle;
$("back-to-battle").onclick = backToBattle;
$("ingame-settings").onclick = () => settings("battle-options");
async function shareRoom(codeOnly = false) {
  if (!room) return;
  const url = new URL("/game/battle", location.origin);
  url.searchParams.set("room", room.code);
  try {
    if (!codeOnly && navigator.share)
      await navigator.share({
        title: "Танчики 99",
        text: "Присоединяйся к моему бою",
        url: url.href,
      });
    else {
      await navigator.clipboard.writeText(codeOnly ? room.code : url.href);
      notice(codeOnly ? "Код скопирован." : "Ссылка скопирована.");
    }
  } catch (e) {
    if (e.name !== "AbortError")
      notice(`Код: ${room.code}. Ссылка: ${url.href}`);
  }
}
$("copy-code").onclick = () => shareRoom(true);
$("share").onclick = () => shareRoom();
$("ingame-invite").onclick = () => shareRoom();
const keyDirections = {
  arrowup: 0,
  w: 0,
  arrowright: 1,
  d: 1,
  arrowdown: 2,
  s: 2,
  arrowleft: 3,
  a: 3,
};
addEventListener("keydown", (e) => {
  if (/INPUT|TEXTAREA/.test(e.target.tagName)) return;
  const k = e.key.toLowerCase();
  if (screen === "battle" && (k in keyDirections || k === " ")) {
    e.preventDefault();
    if (!keys.has(k)) keys.set(k, keyDirections[k] ?? "fire");
  }
  if (k === "escape") {
    if (screen === "battle") menuDuringBattle();
    else if (screen === "battle-options") backToBattle();
  }
});
addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
function pointerButton(button, on, off) {
  button.onpointerdown = (e) => {
    e.preventDefault();
    button.setPointerCapture(e.pointerId);
    on(e);
    button.classList.add("pressed");
  };
  for (const ev of ["pointerup", "pointercancel", "lostpointercapture"])
    button.addEventListener(ev, (e) => {
      off(e);
      button.classList.remove("pressed");
    });
}
document.querySelectorAll("[data-direction]").forEach((b) =>
  pointerButton(
    b,
    (e) => touches.set(e.pointerId, Number(b.dataset.direction)),
    (e) => touches.delete(e.pointerId),
  ),
);
pointerButton(
  $("fire"),
  (e) => firePointers.add(e.pointerId),
  (e) => firePointers.delete(e.pointerId),
);

function updateStick(e) {
  if (e.pointerId !== stickPointer) return;
  const rect = $("joystick").getBoundingClientRect(),
    dx = e.clientX - rect.left - rect.width / 2,
    dy = e.clientY - rect.top - rect.height / 2,
    r = Math.hypot(dx, dy),
    scale = r > 42 ? 42 / r : 1;
  $("stick").style.transform = `translate(${dx * scale}px,${dy * scale}px)`;
  joystickDirection =
    r < 16
      ? -1
      : Math.abs(dx) > Math.abs(dy)
        ? dx > 0
          ? 1
          : 3
        : dy > 0
          ? 2
          : 0;
}
$("joystick").onpointerdown = (e) => {
  if (stickPointer !== null) return;
  e.preventDefault();
  stickPointer = e.pointerId;
  $("joystick").setPointerCapture(e.pointerId);
  updateStick(e);
};
$("joystick").onpointermove = updateStick;
for (const type of ["pointerup", "pointercancel", "lostpointercapture"])
  $("joystick").addEventListener(type, (e) => {
    if (e.pointerId === stickPointer) {
      stickPointer = null;
      joystickDirection = -1;
      $("stick").style.transform = "";
    }
  });
addEventListener("blur", clearInput);
document.addEventListener("visibilitychange", () => {
  clearInput();
  stickPointer = null;
  if (
    document.hidden &&
    room?.mode === "solo" &&
    world?.state === "play" &&
    !world.paused
  ) {
    send({ type: "pause" });
    pausedByMenu = true;
    $("pause-note").textContent = "Игра на паузе.";
    show("battle-options");
  }
});
setInterval(() => {
  if (!connected || !world || !room || world.state !== "play") return;
  if (ws.bufferedAmount > 8192) {
    reconnect();
    return;
  }
  const commands = simulation.flush();
  if (commands.length)
    send({
      type: "inputs",
      code: room.code,
      revision: simulation.revision,
      commands,
    });
}, 1000 / 30);
setInterval(() => {
  if (connected) send({ type: "ping", time: Date.now() });
  if (
    connected &&
    world &&
    screen === "battle" &&
    performance.now() - lastSnapshot > 2000
  )
    reconnect();
}, 500);
function frame(now) {
  requestAnimationFrame(frame);
  simulation.advance(now, input(), connected && !document.hidden);
  if (screen !== "battle" || !world || !room) return;
  draw(simulation.render(now));
  if (!connected || now - lastSnapshot > 1000) {
    $("arena-note").hidden = false;
    $("arena-note").textContent = "Восстанавливаем связь…";
  }
}

controls();
requestAnimationFrame(frame);
try {
  const b = await api("profile");
  updateProfile(b.profile);
  updateRoom(b.room);
  connect();
  const invited = new URL(location.href).searchParams.get("room");
  if (invited) {
    $("code").value = invited.toUpperCase();
    show("join");
  } else if (b.room) show(b.room.started ? "battle" : "lobby");
} catch {
  connection("Нет связи");
  notice(
    "Не удалось загрузить профиль. Проверьте соединение и обновите страницу.",
  );
}
