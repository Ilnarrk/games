// Coordinates and cooldowns use the original 416px / 60Hz game units.
export const DX = [0, 1, 0, -1],
  DY = [-1, 0, 1, 0];
const overlap = (a, b, size = 32) =>
  Math.abs(a.x - b.x) < size && Math.abs(a.y - b.y) < size;
export function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function terrain(level) {
  const r = rng(level * 7919 + 13),
    map = Array.from({ length: 26 }, () => Array(26).fill(0));
  for (let y = 1; y <= 10; y++)
    for (let x = 0; x <= 6; x++) {
      let v = 0;
      if (r() < Math.min(0.3 + level * 0.004, 0.55)) {
        const q = r(),
          steel = Math.min(0.03 + level * 0.0022, 0.2),
          corridor = y === 4 || y === 9;
        v =
          q < steel && !corridor
            ? 2
            : q < steel + 0.06 && !corridor
              ? 3
              : q < steel + 0.18
                ? 4
                : 1;
      }
      for (const col of new Set([x, 12 - x]))
        for (let a = 0; a < 2; a++)
          for (let b = 0; b < 2; b++) map[y * 2 + a][col * 2 + b] = v;
    }
  return map;
}
export function canMove(world, px, py, self) {
  if (px < 0 || py < 0 || px + 32 > 416 || py + 32 > 416) return false;
  for (let y = py >> 4; y <= (py + 31.9) >> 4; y++)
    for (let x = px >> 4; x <= (px + 31.9) >> 4; x++) {
      if ([1, 2, 3].includes(world.grid[y][x])) return false;
    }
  if (world.bases.some((b) => overlap({ x: px, y: py }, b))) return false;
  return ![...world.players, ...world.enemies].some(
    (t) => t.id !== self.id && t.alive && overlap({ x: px, y: py }, t),
  );
}
export function move(world, tank, direction, speed = 1.5 + tank.lv * 0.1) {
  if (direction < 0 || direction > 3) return false;
  if (direction % 2 !== tank.d % 2) {
    const x = Math.round(tank.x / 16) * 16,
      y = Math.round(tank.y / 16) * 16;
    if (canMove(world, x, y, tank)) {
      tank.x = x;
      tank.y = y;
    }
  }
  tank.d = direction;
  const x = tank.x + DX[direction] * speed,
    y = tank.y + DY[direction] * speed;
  if (!canMove(world, x, y, tank)) return false;
  tank.x = x;
  tank.y = y;
  tank.m += speed;
  return true;
}
export class Game {
  constructor(mode = "solo", level = 1, seed = Date.now()) {
    this.mode = mode;
    this.level = level;
    this.score = 0;
    this.tick = 0;
    this.serial = 0;
    this.random = rng(seed);
    this.players = [];
    this.reset();
  }
  tank(x, y, d, extra = {}) {
    return {
      id: ++this.serial,
      x,
      y,
      d,
      nb: 0,
      cd: 0,
      hp: 1,
      alive: true,
      inv: 0,
      m: 0,
      lv: 0,
      ty: 0,
      ...extra,
    };
  }
  reset(revive = false) {
    this.grid = terrain(this.level);
    this.enemies = [];
    this.bullets = [];
    this.bonuses = [];
    this.fx = [];
    this.todo =
      this.mode === "duel" ? 0 : Math.min(20 + Math.floor(this.level / 5), 30);
    this.spawnTimer = 60;
    this.spawnCount = 0;
    this.freeze = 0;
    this.shield = 0;
    this.state = "play";
    this.winner = null;
    this.paused = false;
    this.banner = 110;
    this.bases = [{ x: 192, y: 384, team: 0, alive: true }];
    if (this.mode === "duel") {
      // Mirror every tile across both axes; keep clear spawn lanes at each end.
      for (let y = 0; y < 13; y++)
        for (let x = 0; x < 13; x++) {
          const v = y < 4 ? 0 : this.grid[y][x];
          this.grid[y][x] =
            this.grid[y][25 - x] =
            this.grid[25 - y][x] =
            this.grid[25 - y][25 - x] =
              v;
        }
      this.bases.push({ x: 192, y: 0, team: 1, alive: true });
    }
    this.fort(1);
    const old = this.players;
    this.players = [];
    this.players = Array.from(
      { length: this.mode === "solo" ? 1 : 2 },
      (_, slot) => {
        const p = this.tank(0, 0, 0, {
          slot,
          team: this.mode === "duel" ? slot : 0,
          lives: revive ? 3 : (old[slot]?.lives ?? 3),
          lv: revive ? 0 : (old[slot]?.lv ?? 0),
          inv: 150,
        });
        this.respawn(p);
        p.alive = p.lives > 0;
        return p;
      },
    );
  }
  fort(value) {
    for (const base of this.bases) {
      const top = base.y === 0;
      for (let y = top ? 0 : 22; y < (top ? 4 : 26); y++)
        for (let x = 10; x < 16; x++) {
          if ((top ? y < 2 : y >= 24) && x >= 12 && x <= 13) continue;
          this.grid[y][x] = value;
        }
    }
  }
  respawn(p) {
    p.botWaypoint = null;
    const upper = this.mode === "duel" && p.slot === 1;
    const preferred = this.mode === "coop" && p.slot === 1 ? 256 : 128;
    const y = upper ? 0 : 384;
    for (const x of [preferred, 256, 64, 320, 0, 384]) {
      if (canMove(this, x, y, p)) {
        p.x = x;
        p.y = y;
        p.d = upper ? 2 : 0;
        return;
      }
    }
    p.x = preferred;
    p.y = y;
    p.d = upper ? 2 : 0;
  }
  effect(x, y, r) {
    this.fx.push({ id: ++this.serial, x, y, r, t: 0 });
  }
  fire(t) {
    if (
      !t.alive ||
      t.cd > 0 ||
      t.nb >= (t.slot !== undefined && t.lv >= 2 ? 2 : 1)
    )
      return;
    this.bullets.push({
      id: ++this.serial,
      x: t.x + 16 + DX[t.d] * 18,
      y: t.y + 16 + DY[t.d] * 18,
      d: t.d,
      owner: t.id,
      team: t.team,
      player: t.slot !== undefined,
      lv: t.lv,
      s: t.slot !== undefined ? (t.lv ? 3.6 : 2.8) : t.ty === 2 ? 3.6 : 2.4,
    });
    t.nb++;
    t.cd = t.slot !== undefined ? 14 : 30;
  }
  removeBullet(b) {
    if (b.dead) return;
    b.dead = true;
    const owner = [...this.players, ...this.enemies].find(
      (p) => p.id === b.owner,
    );
    if (owner) owner.nb = Math.max(0, owner.nb - 1);
  }
  hurt(p) {
    if (p.inv > 0 || !p.alive) return;
    this.effect(p.x + 16, p.y + 16, 26);
    p.lives--;
    p.lv = 0;
    if (p.lives <= 0) p.alive = false;
    else {
      this.respawn(p);
      p.inv = 150;
    }
  }
  killEnemy(t, drop) {
    if (!t.alive) return;
    t.alive = false;
    this.score += t.pts;
    this.effect(t.x + 16, t.y + 16, 24);
    if (drop && t.bn)
      this.bonuses.push({
        id: ++this.serial,
        x: Math.floor(this.random() * 12) * 32,
        y: Math.floor(this.random() * 11) * 32 + 16,
        k: Math.floor(this.random() * 6),
        t: 900,
      });
  }
  pick(p, k) {
    this.score += 500;
    if (k === 0) p.lv = Math.min(3, p.lv + 1);
    if (k === 1) p.inv = 600;
    if (k === 2) p.lives = Math.min(9, p.lives + 1);
    if (k === 3) this.enemies.forEach((t) => this.killEnemy(t, false));
    if (k === 4) this.freeze = 480;
    if (k === 5) {
      this.shield = 900;
      this.fort(2);
    }
  }
  bulletStep(b) {
    b.x += DX[b.d] * b.s;
    b.y += DY[b.d] * b.s;
    if (b.x < 0 || b.y < 0 || b.x >= 416 || b.y >= 416)
      return this.removeBullet(b);
    let hit = false;
    for (const o of [-7, 0, 7]) {
      const x = Math.floor((b.x + (DY[b.d] ? o : 0)) / 16),
        y = Math.floor((b.y + (DX[b.d] ? o : 0)) / 16);
      const v = this.grid[y]?.[x];
      if (v === 1 || (v === 2 && b.player && b.lv >= 3)) {
        this.grid[y][x] = 0;
        hit = true;
      } else if (v === 2) hit = true;
    }
    // Terrain stops bullets before they can damage a tank or a base behind it.
    if (hit) return this.removeBullet(b);
    for (const base of this.bases)
      if (
        base.alive &&
        b.x > base.x &&
        b.x < base.x + 32 &&
        b.y > base.y &&
        b.y < base.y + 32
      ) {
        if (b.team !== base.team) {
          base.alive = false;
          this.effect(base.x + 16, base.y + 16, 32);
        }
        return this.removeBullet(b);
      }
    for (const t of [...this.players, ...this.enemies]) {
      if (!t.alive || t.id === b.owner || t.team === b.team) continue;
      if (Math.abs(b.x - t.x - 16) < 16 && Math.abs(b.y - t.y - 16) < 16) {
        if (t.slot !== undefined) this.hurt(t);
        else if (--t.hp <= 0) this.killEnemy(t, true);
        return this.removeBullet(b);
      }
    }
  }
  duelBotInput(p) {
    const targets = [...this.players.filter((t) => t.alive && t.team !== p.team),
      ...this.bases.filter((b) => b.alive && b.team !== p.team)];
    const aim = (x, y) => {
      for (const t of targets) {
        const dx = t.x - x, dy = t.y - y;
        if (Math.min(Math.abs(dx), Math.abs(dy)) > 5 || Math.hypot(dx, dy) > 240) continue;
        const d = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0);
        let clear = true;
        for (let n = 16; n < Math.hypot(dx, dy); n += 8) {
          if (this.grid[Math.floor((y + 16 + DY[d] * n) / 16)]?.[Math.floor((x + 16 + DX[d] * n) / 16)] === 2) clear = false;
        }
        if (clear) return d;
      }
      return -1;
    };
    const shot = aim(p.x, p.y);
    if (shot >= 0) {
      p.d = shot;
      p.botWaypoint = null;
      return { d: -1, fire: true };
    }
    // Commit to a grid waypoint: rounding and replanning mid-tile causes oscillation.
    let waypoint = p.botWaypoint;
    if (!waypoint || Math.hypot(p.x - waypoint.x, p.y - waypoint.y) < 2) {
      const sx = Math.round(p.x / 16), sy = Math.round(p.y / 16);
      const queue = [[sx, sy, null]], seen = new Set([`${sx},${sy}`]);
      waypoint = null;
      for (let i = 0; i < queue.length; i++) {
        const [cx, cy, first] = queue[i];
        if (first && aim(cx * 16, cy * 16) >= 0) { waypoint = first; break; }
        for (let d = 0; d < 4; d++) {
          const nx = cx + DX[d], ny = cy + DY[d], key = `${nx},${ny}`;
          if (nx < 0 || ny < 0 || nx > 24 || ny > 24 || seen.has(key)) continue;
          if ([this.grid[ny][nx], this.grid[ny + 1][nx], this.grid[ny][nx + 1], this.grid[ny + 1][nx + 1]].some((v) => v === 2 || v === 3)) continue;
          if (this.bases.some((b) => overlap({ x: nx * 16, y: ny * 16 }, b))) continue;
          seen.add(key);
          queue.push([nx, ny, first || { x: nx * 16, y: ny * 16, d }]);
        }
      }
      p.botWaypoint = waypoint;
    }
    return { d: waypoint?.d ?? -1, fire: Boolean(waypoint) };
  }
  botInput(p) {
    if (this.mode === "duel") return this.duelBotInput(p);
    const opponent = this.players.find((t) => t.team !== p.team && t.alive);
    const targets =
      this.mode === "duel"
        ? [
            ...(opponent ? [opponent] : []),
            ...this.bases.filter((b) => b.team !== p.team),
          ]
        : this.enemies.filter((e) => e.alive);
    const target = targets.sort(
      (a, b) =>
        Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y),
    )[0] || { x: p.slot ? 256 : 128, y: 192 };
    // Breadth-first path on the 16px tank-origin grid, including destructible walls.
    // Bots can plan through brick, then stop and shoot it. Replan every 15 ticks.
    if (this.tick % 15 === p.slot || p.botDirection === undefined) {
      const start = [Math.round(p.x / 16), Math.round(p.y / 16)],
        queue = [[...start, -1]],
        seen = new Set([start.join(",")]);
      let best = Infinity,
        chosen = -1;
      for (let i = 0; i < queue.length; i++) {
        const [x, y, first] = queue[i],
          dist = Math.abs(x * 16 - target.x) + Math.abs(y * 16 - target.y);
        if (dist < best) {
          best = dist;
          chosen = first;
        }
        if (dist < 32) break;
        for (let n = 0; n < 4; n++) {
          const d = (n + (this.mode === "duel" ? Math.floor(this.tick / 180) + p.slot : 0)) % 4;
          const nx = x + DX[d],
            ny = y + DY[d],
            key = `${nx},${ny}`;
          if (nx < 0 || ny < 0 || nx > 24 || ny > 24 || seen.has(key)) continue;
          if (
            [
              this.grid[ny][nx],
              this.grid[ny + 1][nx],
              this.grid[ny][nx + 1],
              this.grid[ny + 1][nx + 1],
            ].some((v) => v === 2 || v === 3)
          )
            continue;
          if (
            this.bases.some(
              (b) =>
                b.team === p.team && overlap({ x: nx * 16, y: ny * 16 }, b),
            )
          )
            continue;
          seen.add(key);
          queue.push([nx, ny, first < 0 ? d : first]);
        }
      }
      p.botDirection = chosen;
    }
    let d = p.botDirection;
    const dx = target.x - p.x,
      dy = target.y - p.y;
    if (Math.abs(dx) < 16) d = dy > 0 ? 2 : 0;
    else if (Math.abs(dy) < 16) d = dx > 0 ? 1 : 3;
    return { d, fire: true };
  }
  step(inputs = []) {
    if (this.paused || this.state !== "play") return;
    this.tick++;
    if (this.banner > 0) this.banner--;
    this.players.forEach((p, i) => {
      if (!p.alive) return;
      if (p.cd > 0) p.cd--;
      if (p.inv > 0) p.inv--;
      const input = inputs[i] || { d: -1, fire: false };
      if (input.d >= 0) move(this, p, input.d);
      if (input.fire) this.fire(p);
    });
    if (this.freeze > 0) this.freeze--;
    if (this.shield > 0 && --this.shield === 0) this.fort(1);
    if (
      this.todo > 0 &&
      --this.spawnTimer <= 0 &&
      this.enemies.length < 4 + Math.min(Math.floor(this.level / 25), 2)
    ) {
      const t = this.tank([0, 192, 384][this.spawnCount % 3], 0, 2, {
        team: -1,
      });
      if (canMove(this, t.x, t.y, t)) {
        const r = this.random();
        t.ty =
          r < 0.4
            ? 0
            : r < 0.65
              ? this.level > 2
                ? 1
                : 0
              : r < 0.85
                ? this.level > 5
                  ? 2
                  : 0
                : this.level > 8
                  ? 3
                  : 0;
        t.hp = t.ty === 3 ? (this.level > 40 ? 4 : 3) : 1;
        t.pts = [100, 200, 300, 400][t.ty];
        t.bn = this.spawnCount % 4 === 3;
        t.spd = [0.7, 1.2, 0.8, 0.6][t.ty] + Math.min(this.level * 0.008, 0.4);
        this.enemies.push(t);
        this.todo--;
        this.spawnCount++;
        this.spawnTimer = Math.max(130 - this.level, 50);
      }
    }
    if (!this.freeze)
      for (const t of this.enemies) {
        if (!t.alive) continue;
        if (t.cd > 0) t.cd--;
        const ok = move(this, t, t.d, t.spd);
        if (!ok || this.random() < 0.008) {
          const target =
            this.level > 10 && this.random() < 0.4
              ? this.players.find((p) => p.alive) || this.bases[0]
              : this.bases[0];
          const dx = target.x - t.x,
            dy = target.y - t.y;
          t.d =
            this.random() < 0.5
              ? Math.abs(dx) > Math.abs(dy)
                ? dx > 0
                  ? 1
                  : 3
                : dy > 0
                  ? 2
                  : 0
              : this.random() < 0.5
                ? 2
                : Math.floor(this.random() * 4);
        }
        if (
          this.random() <
          Math.min(0.012 + this.level * 0.0004, 0.04) + (ok ? 0 : 0.08)
        )
          this.fire(t);
      }
    for (let i = 0; i < 2; i++)
      for (const b of this.bullets) if (!b.dead) this.bulletStep(b);
    this.bullets = this.bullets.filter((b) => !b.dead);
    this.enemies = this.enemies.filter((t) => t.alive);
    this.bonuses = this.bonuses.filter((b) => {
      const p = this.players.find((p) => p.alive && overlap(p, b, 30));
      if (p) {
        this.pick(p, b.k);
        return false;
      }
      return --b.t > 0;
    });
    this.fx = this.fx.filter((f) => ++f.t < 20);
    if (this.mode === "duel") {
      const lost = this.players.map(
        (p) => p.lives <= 0 || !this.bases[p.team].alive,
      );
      if (lost.some(Boolean)) {
        this.state = "done";
        this.winner = lost.every(Boolean) ? null : lost[0] ? 1 : 0;
      }
    } else if (!this.bases[0].alive || this.players.every((p) => !p.alive))
      this.state = "lose";
    else if (this.todo === 0 && !this.enemies.length) this.state = "win";
  }
  next() {
    if (this.state === "play") return false;
    if (this.mode === "duel") {
      this.score = 0;
      this.reset(true);
    } else if (this.state === "win" && this.level < 99) {
      this.level++;
      this.reset();
    } else {
      if (this.state === "win" || this.mode === "coop") this.level = 1;
      this.score = 0;
      this.reset(true);
    }
    return true;
  }
  snapshot() {
    const {
      mode,
      level,
      score,
      tick,
      grid,
      players,
      enemies,
      bullets,
      bonuses,
      fx,
      todo,
      bases,
      state,
      winner,
      freeze,
      shield,
      banner,
      paused,
    } = this;
    return {
      mode,
      level,
      score,
      tick,
      grid,
      players,
      enemies,
      bullets,
      bonuses,
      fx,
      todo,
      bases,
      state,
      winner,
      freeze,
      shield,
      banner,
      paused,
    };
  }
}
