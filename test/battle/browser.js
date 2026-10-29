// Optional browser verification: PLAYWRIGHT_MODULE points to an installed Playwright ESM entry.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createApp } from "../../server/app.js";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const app = createApp({ dbPath: ":memory:" });
await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + app.server.address().port;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
  args: ["--no-sandbox"],
});
const errors = [];
const capture = (page) => {
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
};
const hardwareBounds = new Map();
async function stableHardware(page) {
  const state = await page.evaluate(() => {
    const r = document.querySelector(".console").getBoundingClientRect();
    return {
      key: innerWidth + "x" + innerHeight,
      rect: [r.x, r.y, r.width, r.height],
    };
  });
  const previous = hardwareBounds.get(state.key);
  if (previous)
    state.rect.forEach((v, i) =>
      assert(
        Math.abs(v - previous[i]) < 1,
        `Hardware changed on ${state.key}: ${state.rect} != ${previous}`,
      ),
    );
  else hardwareBounds.set(state.key, state.rect);
}
const visible = async (page, id) => {
  await page.locator("#" + id).waitFor({ state: "visible" });
  await stableHardware(page);
};
async function fits(page) {
  const bounds = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    scroll: document.documentElement.scrollWidth,
    arena: document.querySelector("#arena").getBoundingClientRect().toJSON(),
    bezel: document
      .querySelector(".screen-bezel")
      .getBoundingClientRect()
      .toJSON(),
    pad: document.querySelector("#pad").getBoundingClientRect().toJSON(),
  }));
  assert(bounds.scroll <= bounds.width, JSON.stringify(bounds));
  assert(bounds.arena.width > 120);
  assert(bounds.arena.top >= 0);
  assert(bounds.arena.bottom <= bounds.height);
  assert(bounds.pad.bottom <= bounds.height, JSON.stringify(bounds));
  assert(bounds.arena.bottom <= bounds.bezel.bottom, JSON.stringify(bounds));
  if (bounds.height > bounds.width)
    assert(bounds.arena.bottom <= bounds.pad.top, JSON.stringify(bounds));
}
try {
  await mkdir("output/playwright", { recursive: true });
  const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    }),
    other = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
  for (const ctx of [context, other])
    await ctx.addInitScript(() => {
      // Inject ordered application-level latency into actual WebSocket messages.
      window.__networkLag = 0;
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        set onmessage(handler) {
          super.onmessage =
            typeof handler === "function"
              ? (event) => {
                  if (!window.__networkLag) return handler(event);
                  const jitter = [0, 25, -20][
                    (this.__inCount = (this.__inCount || 0) + 1) % 3
                  ];
                  const at = (this.__inAt = Math.max(
                    (this.__inAt || 0) + 1,
                    performance.now() + window.__networkLag + jitter,
                  ));
                  setTimeout(
                    () => handler(event),
                    Math.max(0, at - performance.now()),
                  );
                }
              : null;
        }
        get onmessage() {
          return super.onmessage;
        }
        send(data) {
          if (!window.__networkLag) return super.send(data);
          const jitter = [0, 20, -15][
            (this.__outCount = (this.__outCount || 0) + 1) % 3
          ];
          const at = (this.__outAt = Math.max(
            (this.__outAt || 0) + 1,
            performance.now() + window.__networkLag + jitter,
          ));
          setTimeout(
            () => {
              if (this.readyState === 1) super.send(data);
            },
            Math.max(0, at - performance.now()),
          );
        }
      };
      window.__tankFrames = [[], []];
      const translate = CanvasRenderingContext2D.prototype.translate,
        fillRect = CanvasRenderingContext2D.prototype.fillRect;
      CanvasRenderingContext2D.prototype.translate = function (x, y) {
        this.__tankOrigin = { x: x - 16, y: y - 16 };
        return translate.call(this, x, y);
      };
      CanvasRenderingContext2D.prototype.fillRect = function (x, y, w, h) {
        if (w === 18 && h === 25 && this.__tankOrigin) {
          const slot =
            this.fillStyle === "#d9ce73"
              ? 0
              : this.fillStyle === "#58b8d0"
                ? 1
                : -1;
          if (slot >= 0) {
            const frames = window.__tankFrames[slot];
            frames.push({ ...this.__tankOrigin, at: performance.now() });
            if (frames.length > 3000) frames.shift();
          }
        }
        return fillRect.call(this, x, y, w, h);
      };
    });
  const a = await context.newPage(),
    b = await other.newPage();
  capture(a);
  capture(b);
  await a.goto(base + "/game");
  await a.getByRole("link", { name: /Танчики 99/ }).click();
  await a.waitForFunction(() =>
    document.querySelector("#connection").textContent.includes("мс"),
  );
  await stableHardware(a);
  await a.screenshot({ path: "output/playwright/menu.png", fullPage: true });
  await a.getByRole("button", { name: "Настройки", exact: true }).click();
  await visible(a, "settings");
  await a.locator("#name").fill("Танкист");
  await a.getByLabel("Джойстик", { exact: true }).check();
  await a.getByRole("button", { name: "Сохранить", exact: true }).click();
  await visible(a, "menu");
  await a.reload();
  await a.waitForFunction(
    () => document.querySelector("#player-label").textContent === "Танкист",
  );
  await stableHardware(a);
  // Let metadata and snapshots arrive before the initiating HTTP request completes.
  await a.route("**/game/battle/api/rooms", async (route) => {
    const response = await route.fetch();
    await new Promise((r) => setTimeout(r, 200));
    await route.fulfill({ response });
  });
  await a.locator("#solo").click();
  await visible(a, "battle");
  await a.waitForFunction(() =>
    document.querySelector("#lives").textContent.includes("1P"),
  );
  await visible(a, "joystick");
  await a.waitForFunction(() => window.__tankFrames[0].length >= 5);
  const rendered = await a.evaluate(() => window.__tankFrames[0].length);
  await a.waitForTimeout(200);
  assert(
    (await a.evaluate(() => window.__tankFrames[0].length)) > rendered + 3,
    "Starting client stopped rendering",
  );
  await a.unroute("**/game/battle/api/rooms");
  await fits(a);
  await a.screenshot({ path: "output/playwright/solo-portrait.png" });
  for (const size of [
    { width: 320, height: 568 },
    { width: 375, height: 667 },
    { width: 667, height: 375 },
    { width: 844, height: 390 },
  ]) {
    await a.setViewportSize(size);
    await fits(a);
    await a.screenshot({
      path: `output/playwright/battle-${size.width}x${size.height}.png`,
    });
  }
  await a.screenshot({ path: "output/playwright/solo-landscape.png" });
  await a.locator("#battle-menu").click();
  await visible(a, "battle-options");
  await a.getByRole("button", { name: "Выйти в меню", exact: true }).click();
  await visible(a, "menu");
  await a.setViewportSize({ width: 390, height: 844 });
  await stableHardware(a);
  await a.getByRole("button", { name: "Создать комнату", exact: true }).click();
  await a.locator("#coop").click();
  await visible(a, "lobby");
  const code = await a.locator("#room-code").textContent();
  await a.locator("#start").click();
  await visible(a, "battle");
  await b.goto(base + "/game/battle?room=" + code);
  await b.waitForFunction(() =>
    document.querySelector("#connection").textContent.includes("мс"),
  );
  await b.getByRole("button", { name: "Присоединиться", exact: true }).click();
  await visible(b, "battle");
  await b.waitForFunction(() =>
    document.querySelector("#lives").textContent.includes("2P"),
  );
  const r = app.rooms.get(code);
  assert.equal(r.slots[1].bot, false);
  await a.screenshot({ path: "output/playwright/coop.png" });
  // A clear lane makes frame-to-frame motion measurable independently of collisions.
  r.game.grid = r.game.grid.map((row) => row.map(() => 0));
  r.game.enemies = [];
  r.game.spawnTimer = 10000;
  r.game.players.forEach((p, i) => {
    p.x = 64 + i * 192;
    p.y = 320;
    p.inv = 600;
  });
  await a.waitForTimeout(300);
  await a.evaluate(() => {
    window.__networkLag = 75;
    window.__tankFrames = [[], []];
  });
  await b.evaluate(() => {
    window.__networkLag = 75;
    window.__tankFrames = [[], []];
  });
  await b.keyboard.down("ArrowUp");
  await b.waitForTimeout(900);
  await b.keyboard.up("ArrowUp");
  await a.waitForTimeout(300);
  const peer = await a.evaluate(() => window.__tankFrames[1]);
  const moved = peer[0].y - peer.at(-1).y;
  const jumps = peer.slice(1).map((p, i) => Math.abs(p.y - peer[i].y));
  assert(moved > 35, `Peer motion stalled: ${moved}`);
  assert(Math.max(...jumps) <= 6, `Peer motion jumped: ${Math.max(...jumps)}`);
  await a.evaluate(() => (window.__networkLag = 0));
  await b.evaluate(() => (window.__networkLag = 0));
  await a.waitForTimeout(200);

  await other.setOffline(true);
  await b.waitForTimeout(2300);
  assert.equal(r.slots[1].bot, true);
  const tick = r.game.tick;
  await a.waitForTimeout(100);
  assert(r.game.tick > tick);
  await other.setOffline(false);
  await b.waitForFunction(() =>
    document.querySelector("#connection").textContent.includes("мс"),
  );
  await b.waitForTimeout(200);
  assert.equal(r.slots[1].bot, false);
  // Generate genuine multi-touch events so pointer capture and independent pointers are exercised.
  const cdp = await context.newCDPSession(a),
    stick = await a.locator("#joystick").boundingBox(),
    fire = await a.locator("#fire").boundingBox();
  const beforeY = r.game.players[0].y;
  const touchPoints = [
    {
      id: 11,
      x: stick.x + stick.width / 2,
      y: stick.y + stick.height / 2 - 42,
    },
    { id: 12, x: fire.x + fire.width / 2, y: fire.y + fire.height / 2 },
  ];
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints,
  });
  await a.waitForTimeout(150);
  assert(r.game.players[0].y < beforeY);
  assert(r.game.players[0].cd > 0);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await a.locator("#battle-menu").click();
  await a.getByRole("button", { name: "Выйти в меню", exact: true }).click();
  await b.waitForTimeout(100);
  assert.equal(r.slots[0].bot, true);
  assert.equal(r.slots[1].bot, false);
  await b.locator("#battle-menu").click();
  await b.getByRole("button", { name: "Выйти в меню", exact: true }).click();
  await a.getByRole("button", { name: "Создать комнату", exact: true }).click();
  await a.locator("#duel").click();
  await visible(a, "lobby");
  const duel = await a.locator("#room-code").textContent();
  await b.getByRole("button", { name: "Войти по коду", exact: true }).click();
  await b.locator("#code").fill(duel);
  await b.getByRole("button", { name: "Присоединиться", exact: true }).click();
  await visible(b, "lobby");
  await b.locator("#ready").click();
  await a.locator("#start").click();
  await visible(a, "battle");
  await visible(b, "battle");
  const match = app.rooms.get(duel);
  match.game.bases[1].alive = false;
  app.step();
  await visible(a, "result");
  await visible(b, "result");
  assert.equal(await a.locator("#result-title").textContent(), "Победа!");
  await a.locator("#next").click();
  await b.locator("#next").click();
  await visible(a, "battle");
  await visible(b, "battle");
  await a.emulateMedia({ reducedMotion: "reduce" });
  await fits(a);
  assert.deepEqual(errors, []);
  console.log(
    "Browser checks passed: stable hardware size, delayed start response, peer interpolation with RTT/jitter, controls, 4 mobile viewports, offline/rejoin, host exit and rematch.",
  );
} finally {
  await browser.close();
  await app.close();
}
