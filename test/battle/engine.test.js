import test from "node:test";
import assert from "node:assert/strict";
import { Game, move, canMove } from "../../public/games/battle/engine.js";
const shot = (g, team, x, y, d, player = true) => ({
  id: ++g.serial,
  owner: -1,
  team,
  x,
  y,
  d,
  player,
  lv: 0,
  s: 2.8,
});
test("99 maps retain spawn space, progression and original enemy waves", () => {
  const g = new Game("solo", 1, 1);
  for (let level = 1; level <= 99; level++) {
    assert.equal(g.level, level);
    assert.equal(g.grid.length, 26);
    assert.equal(g.grid[0].length, 26);
    assert.equal(g.todo, Math.min(20 + Math.floor(level / 5), 30));
    assert(canMove(g, 128, 384, g.players[0]));
    g.todo = 0;
    g.enemies = [];
    g.step();
    assert.equal(g.state, "win");
    g.next();
  }
  assert.equal(g.level, 1);
  assert.equal(g.score, 0);
});
test("movement obeys terrain, boundaries, tank collisions and pause", () => {
  const g = new Game("coop", 1, 1),
    p = g.players[0];
  assert.equal(p.x, 128);
  assert.equal(g.players[1].x, 256);
  assert.equal(move(g, p, 3), true);
  assert.equal(p.x, 126.5);
  p.x = 0;
  assert.equal(move(g, p, 3), false);
  p.x = 32;
  p.y = 160;
  g.grid[10][4] = 2;
  assert.equal(canMove(g, 33, 160, p), false);
  p.x = 224;
  p.y = 384;
  assert.equal(move(g, p, 1), false);
  g.paused = true;
  g.step([{ d: 0, fire: true }]);
  assert.equal(g.tick, 0);
  assert.equal(g.bullets.length, 0);
});
test("coop personal lives, shared score and bonuses; elimination does not end partner game", () => {
  const g = new Game("coop", 1, 1),
    [a, b] = g.players;
  a.inv = 0;
  g.hurt(a);
  assert.equal(a.lives, 2);
  assert.equal(b.lives, 3);
  g.pick(b, 0);
  assert.equal(a.lv, 0);
  assert.equal(b.lv, 1);
  assert.equal(g.score, 500);
  g.pick(a, 2);
  assert.equal(a.lives, 3);
  g.pick(b, 1);
  assert.equal(b.inv, 600);
  g.pick(a, 4);
  assert.equal(g.freeze, 480);
  g.pick(a, 5);
  assert.equal(g.grid[22][10], 2);
  a.lives = 1;
  a.inv = 0;
  g.hurt(a);
  g.step();
  assert.equal(g.state, "play");
  b.lives = 1;
  b.inv = 0;
  g.hurt(b);
  g.step();
  assert.equal(g.state, "lose");
});
test("friendly shots protect players and base; brick blocks hits behind it", () => {
  const g = new Game("coop", 1, 1),
    b = g.players[1];
  b.inv = 0;
  g.bulletStep(shot(g, 0, b.x + 16, b.y + 16, 2));
  assert.equal(b.lives, 3);
  g.bulletStep(shot(g, 0, 208, 383, 2));
  assert.equal(g.bases[0].alive, true);
  g.grid[23][12] = 1;
  g.bulletStep(shot(g, -1, 208, 380, 2, false));
  assert.equal(g.bases[0].alive, true);
  g.bulletStep(shot(g, -1, 208, 383, 2, false));
  g.step();
  assert.equal(g.state, "lose");
});
test("duel is symmetric and supports base, lives and simultaneous defeat", () => {
  const g = new Game("duel", 1, 1);
  for (let y = 0; y < 26; y++)
    for (let x = 0; x < 26; x++)
      assert.equal(g.grid[y][x], g.grid[25 - y][25 - x]);
  assert.equal(g.todo, 0);
  assert.equal(g.bonuses.length, 0);
  g.bulletStep(shot(g, 0, 208, 31, 0));
  g.step();
  assert.equal(g.state, "done");
  assert.equal(g.winner, 0);
  g.next();
  g.players[0].lives = 1;
  g.players[0].inv = 0;
  g.hurt(g.players[0]);
  g.step();
  assert.equal(g.winner, 1);
  g.next();
  g.bases.forEach((b) => (b.alive = false));
  g.step();
  assert.equal(g.winner, null);
  assert.equal(g.state, "done");
});
test("bots navigate and fire without resetting player state; snapshots have no circular references", () => {
  for (const mode of ["coop", "duel"]) {
    const g = new Game(mode, 1, 4);
    const p = g.players[1];
    p.lives = 2;
    p.lv = 2;
    const start = p.y;
    for (let n = 0; n < 300; n++)
      g.step([{ d: -1, fire: false }, g.botInput(p)]);
    assert.notEqual(p.y, start);
    assert.equal(p.lv, 2);
    assert.equal(p.lives, 2);
    assert.doesNotThrow(() => JSON.stringify(g.snapshot()));
  }
});

test("duel bot reaches a firing position and defeats an idle opponent", () => {
  for (const level of [1, 12, 35, 99]) {
    const g = new Game("duel", level, 4);
    for (let n = 0; n < 3000 && g.state === "play"; n++)
      g.step([{ d: -1, fire: false }, g.botInput(g.players[1])]);
    assert.equal(g.state, "done", `Bot stalled on map ${level}`);
    assert.equal(g.winner, 1);
  }
});
