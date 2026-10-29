import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStaticHandler } from "../server/static.js";
import { createApp } from "../server/app.js";

test("catalog, battle page and legacy assets are served from the public tree", async (t) => {
  const app = createApp({ dbPath: ":memory:" });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(() => app.close());
  const base = "http://127.0.0.1:" + app.server.address().port;
  const malformedStatus = await new Promise((resolve, reject) => {
    http
      .get(
        {
          hostname: "127.0.0.1",
          port: app.server.address().port,
          path: "http://[",
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      )
      .on("error", reject);
  });
  assert.equal(malformedStatus, 400);
  for (const [path, type] of [
    ["/game", "text/html"],
    ["/game/", "text/html"],
    ["/game/battle", "text/html"],
    ["/game/battle/", "text/html"],
    ["/game/games/battle/client.js", "text/javascript"],
    ["/game/assets/console.css", "text/css"],
    ["/game/assets/fonts/retro.ttf", "font/ttf"],
    ["/game/assets/style.css", "text/css"],
    ["/game/assets/client.js", "text/javascript"],
    ["/game/assets/engine.js", "text/javascript"],
    ["/game/assets/netcode.js", "text/javascript"],
    ["/game/assets/render.js", "text/javascript"],
  ]) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, path);
    assert(res.headers.get("content-type").startsWith(type), path);
    assert(
      res.headers.get("content-security-policy").includes("default-src 'self'"),
    );
  }
  const catalog = await (await fetch(base + "/game/catalog.json")).json();
  assert.equal(catalog[0].id, "battle");
  const head = await fetch(base + "/game/battle", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const initial = await fetch(base + "/game/battle/api/profile"),
    cookie = initial.headers.get("set-cookie").split(";")[0],
    profile = await initial.json();
  const legacy = await (
    await fetch(base + "/game/api/profile", { headers: { cookie } })
  ).json();
  assert.deepEqual(legacy, profile);
});

test("a new static game needs only its directory and catalog entry", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "games-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "games/snake"), { recursive: true });
  await mkdir(join(root, "assets"));
  await writeFile(
    join(root, "catalog.json"),
    JSON.stringify([{ id: "snake", title: "Змейка", description: "Аркада" }]),
  );
  await writeFile(join(root, "index.html"), "<h1>Каталог</h1>");
  await writeFile(join(root, "games/snake/index.html"), "<h1>Змейка</h1>");
  await writeFile(
    join(root, "games/snake/game.js"),
    "export const snake = true;",
  );
  const outside = join(root, "..", root.split("/").at(-1) + "-secret.txt");
  await writeFile(outside, "private");
  t.after(() => rm(outside, { force: true }));
  await symlink(outside, join(root, "assets/leak.txt"));
  const server = http.createServer(createStaticHandler(root));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = "http://127.0.0.1:" + server.address().port;
  assert.equal(
    await (await fetch(base + "/game/snake")).text(),
    "<h1>Змейка</h1>",
  );
  assert.equal((await fetch(base + "/game/games/snake/game.js")).status, 200);
  for (const path of [
    "/game/missing",
    "/game/assets/leak.txt",
    "/game/%2e%2e%2fsecret.txt",
    "/game/.env",
    "/server/index.js",
  ])
    assert.equal((await fetch(base + path)).status, 404, path);
  assert.equal((await fetch(base + "/game/%FF")).status, 400);
  assert.equal(
    (await fetch(base + "/game/snake", { method: "POST" })).status,
    405,
  );
});
