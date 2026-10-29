import test from "node:test";
import assert from "node:assert/strict";
import { Game } from "../../public/games/battle/engine.js";
import {
  ClientSimulation,
  SnapshotBuffer,
  STEP,
} from "../../public/games/battle/netcode.js";
function game() {
  const g = new Game("coop", 1, 1);
  g.grid = g.grid.map((row) => row.map(() => 0));
  g.todo = 20;
  g.spawnTimer = 10000;
  g.players.forEach((p, i) => {
    p.x = 64 + i * 192;
    p.y = 320;
    p.inv = 0;
  });
  return g;
}
const packet = (g, ack = -1, revision = 1, code = "ROOM") => ({
  code,
  revision,
  ack,
  world: structuredClone(g.snapshot()),
});
test("time spent in menus cannot become a backlog of simulated movement", () => {
  const client = new ClientSimulation(),
    g = game();
  for (let i = 0; i < 1200; i++)
    client.advance(i * STEP, { d: 0, fire: true }, true);
  client.setRoom("ROOM", 0);
  client.accept(packet(g), 20000);
  client.advance(20000, { d: 0, fire: true }, true);
  client.advance(20000 + STEP, { d: 0, fire: true }, true);
  assert.equal(client.pending.length, 1);
  assert.equal(client.flush().length, 1);
  assert.equal(client.prediction.y, 318.5);
});
test("prediction replays only unacknowledged fixed steps and keeps the fractional frame", () => {
  const client = new ClientSimulation(),
    g = game();
  client.setRoom("ROOM", 0);
  client.accept(packet(g), 0);
  client.advance(0, { d: 0, fire: false }, true);
  for (let i = 1; i <= 12; i++)
    client.advance(i * STEP, { d: 0, fire: false }, true);
  for (let i = 0; i < 6; i++)
    g.step([
      { d: 0, fire: false },
      { d: -1, fire: false },
    ]);
  client.accept(packet(g, 6), 12 * STEP);
  assert.equal(client.pending.length, 6);
  assert.equal(client.prediction.y, 302);
  client.advance(12.5 * STEP, { d: 0, fire: false }, true);
  client.accept(packet(g, 6), 12.5 * STEP);
  client.advance(13 * STEP, { d: 0, fire: false }, true);
  assert.equal(client.pending.length, 7);
  assert.equal(client.prediction.y, 300.5);
});
test("a delayed HTTP room response and packets from another room do not reset the running scene", () => {
  const client = new ClientSimulation(),
    g = game();
  client.setRoom("ROOM", 0);
  client.accept(packet(g), 0);
  const world = client.world;
  client.setRoom("ROOM", 0);
  assert.equal(client.world, world);
  assert.equal(client.accept(packet(g, -1, 1, "OTHER"), 50), false);
  assert.equal(client.world, world);
  client.advance(0, { d: 0, fire: true }, true);
  client.advance(STEP, { d: 0, fire: true }, true);
  g.players[0].y = 384;
  client.accept(packet(g, -1, 2), 100);
  assert.equal(client.pending.length, 0);
  assert.equal(client.outgoing.length, 0);
  assert.equal(client.prediction.y, 384);
});
test("interpolation stays continuous with 50/150/300ms RTT and delivery jitter", () => {
  for (const rtt of [50, 150, 300]) {
    const buffer = new SnapshotBuffer(),
      g = game(),
      packets = [];
    for (let tick = 0; tick <= 120; tick += 3) {
      g.tick = tick;
      g.players[1].x = 64 + tick * 1.5;
      packets.push({
        at: tick * STEP + rtt / 2 + [-20, 20, 0][(tick / 3) % 3],
        world: structuredClone(g.snapshot()),
      });
    }
    let index = 0,
      last = null,
      maxJump = 0,
      moved = 0;
    for (let now = 0; now <= 1800; now += STEP) {
      while (index < packets.length && packets[index].at <= now) {
        buffer.push(packets[index].world, packets[index].at);
        index++;
      }
      const render = buffer.sample(now);
      if (!render) continue;
      const x = render.players[1].x;
      if (now > 500 && last !== null) {
        const delta = x - last;
        assert(delta >= -0.001, `RTT ${rtt}: backwards ${delta}`);
        maxJump = Math.max(maxJump, delta);
        moved += delta;
      }
      last = x;
    }
    assert(maxJump < 2, `RTT ${rtt}: jump ${maxJump}`);
    assert(moved > 90);
  }
});
