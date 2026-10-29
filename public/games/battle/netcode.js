import { canMove, move } from "./engine.js";
export const STEP = 1000 / 60;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const continuous = (a, b) =>
  a &&
  b &&
  a.alive === b.alive &&
  a.lives === b.lives &&
  Math.hypot(a.x - b.x, a.y - b.y) < 64;

// A render clock follows simulation ticks, not individual packet arrival gaps.
export class SnapshotBuffer {
  constructor() {
    this.items = [];
    this.offsets = [];
    this.jitter = 0;
    this.playhead = null;
    this.lastRender = null;
  }
  push(world, now) {
    const at = world.tick * STEP,
      last = this.items.at(-1);
    if (last && at <= last.at) {
      if (at === last.at) last.world = world;
      return;
    }
    if (last)
      this.jitter +=
        (Math.abs(now - last.received - (at - last.at)) - this.jitter) * 0.1;
    this.offsets.push(at - now);
    if (this.offsets.length > 32) this.offsets.shift();
    this.items.push({ at, received: now, world });
    if (this.items.length > 32) this.items.shift();
  }
  sample(now) {
    if (!this.items.length) return null;
    const latest = this.items.at(-1),
      delay = clamp(100 + this.jitter * 2, 100, 200);
    const target = now + Math.max(...this.offsets) - delay;
    if (this.playhead === null) this.playhead = target;
    else {
      const dt = clamp(now - this.lastRender, 0, 50);
      this.playhead +=
        dt * clamp(1 + (target - this.playhead - dt) * 0.005, 0.9, 1.1);
    }
    this.lastRender = now;
    let before = this.items[0],
      after = before;
    for (let i = 1; i < this.items.length; i++) {
      after = this.items[i];
      if (after.at >= this.playhead) break;
      before = after;
    }
    if (this.playhead > latest.at) {
      before = this.items.at(-2) || latest;
      after = latest;
    }
    const blend =
      after.at > before.at
        ? clamp((this.playhead - before.at) / (after.at - before.at), 0, 1)
        : 1;
    const base = this.playhead >= after.at ? after.world : before.world;
    const render = { ...base };
    for (const key of ["players", "enemies", "bullets"]) {
      render[key] = base[key].map((entity) => {
        const a = before.world[key].find((t) => t.id === entity.id),
          b = after.world[key].find((t) => t.id === entity.id);
        const result = { ...entity };
        if (!continuous(a, b)) return result;
        result.x = a.x + (b.x - a.x) * blend;
        result.y = a.y + (b.y - a.y) * blend;
        result.m = (a.m || 0) + ((b.m || 0) - (a.m || 0)) * blend;
        // A brief missing snapshot may coast, but tanks never predict through walls.
        const extra =
          latest.world.paused || latest.world.state !== "play"
            ? 0
            : clamp(this.playhead - after.at, 0, 75);
        if (extra && after.at > before.at) {
          const x = b.x + ((b.x - a.x) * extra) / (after.at - before.at);
          const y = b.y + ((b.y - a.y) * extra) / (after.at - before.at);
          if (key === "bullets" || canMove(after.world, x, y, entity)) {
            result.x = x;
            result.y = y;
          }
        }
        return result;
      });
    }
    return render;
  }
}

export class ClientSimulation {
  constructor() {
    this.sequence = 0;
    this.reset();
  }
  reset() {
    this.code = null;
    this.revision = -1;
    this.slot = -1;
    this.world = null;
    this.prediction = null;
    this.pending = [];
    this.outgoing = [];
    this.acc = 0;
    this.lastFrame = null;
    this.buffer = new SnapshotBuffer();
    this.correction = { x: 0, y: 0 };
  }
  setRoom(code, slot) {
    if (this.code === code && this.slot === slot) return;
    this.reset();
    this.code = code;
    this.slot = slot;
  }
  reconnect() {
    this.sequence = 0;
    const { code, slot } = this;
    this.reset();
    this.code = code;
    this.slot = slot;
  }
  accept(packet, now) {
    if (
      !this.code ||
      packet.code !== this.code ||
      !packet.world.players[this.slot]
    )
      return false;
    const changed = packet.revision !== this.revision;
    if (!changed && this.world && packet.world.tick < this.world.tick)
      return false;
    const previous = this.prediction;
    if (changed) {
      this.pending = [];
      this.outgoing = [];
      this.acc = 0;
      this.buffer = new SnapshotBuffer();
    }
    this.world = packet.world;
    this.revision = packet.revision;
    this.pending = this.pending.filter((c) => c.seq > packet.ack);
    if (this.world.paused || this.world.state !== "play") {
      this.pending = [];
      this.outgoing = [];
      this.acc = 0;
    }
    this.prediction = { ...this.world.players[this.slot] };
    if (!this.world.paused && this.world.state === "play")
      for (const c of this.pending)
        if (this.prediction.alive && c.d >= 0)
          move(this.world, this.prediction, c.d);
    if (
      !changed &&
      !this.world.paused &&
      continuous(previous, this.prediction)
    ) {
      this.correction.x += previous.x - this.prediction.x;
      this.correction.y += previous.y - this.prediction.y;
      if (Math.hypot(this.correction.x, this.correction.y) > 32)
        this.correction = { x: 0, y: 0 };
    } else this.correction = { x: 0, y: 0 };
    this.buffer.push(this.world, now);
    return true;
  }
  advance(now, command, connected) {
    const dt = this.lastFrame === null ? 0 : clamp(now - this.lastFrame, 0, 50);
    this.lastFrame = now;
    if (
      !connected ||
      !this.world ||
      this.world.paused ||
      this.world.state !== "play"
    ) {
      this.acc = 0;
      return;
    }
    this.acc += dt;
    while (this.acc + 0.000001 >= STEP) {
      this.acc -= STEP;
      if (this.pending.length >= 120) {
        this.acc = 0;
        break;
      }
      const c = { seq: ++this.sequence, d: command.d, fire: command.fire };
      this.pending.push(c);
      this.outgoing.push(c);
      if (this.prediction?.alive && c.d >= 0)
        move(this.world, this.prediction, c.d);
    }
    const decay = Math.exp(-dt / 50);
    this.correction.x *= decay;
    this.correction.y *= decay;
  }
  flush() {
    return this.outgoing.splice(0, 8);
  }
  render(now) {
    const world = this.buffer.sample(now);
    if (world && this.prediction)
      world.players[this.slot] = {
        ...this.prediction,
        x: this.prediction.x + this.correction.x,
        y: this.prediction.y + this.correction.y,
      };
    return world;
  }
}
