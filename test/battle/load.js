import { cpus } from "node:os";
import { performance } from "node:perf_hooks";
import { once } from "node:events";
import WebSocket from "ws";
import { createApp } from "../../server/app.js";
const app = createApp({ dbPath: ":memory:" }),
  clients = [];
await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + app.server.address().port;
try {
  for (let i = 0; i < 20; i++) {
    const init = await fetch(base + "/game/api/profile"),
      cookie = init.headers.get("set-cookie").split(";")[0];
    const res = await fetch(base + "/game/api/rooms", {
      method: "POST",
      headers: { cookie, Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: i % 2 ? "coop" : "duel" }),
    });
    if (!res.ok) throw Error(await res.text());
    const { room } = await res.json();
    const ws = new WebSocket(base.replace("http", "ws") + "/game/ws", {
      headers: { cookie, Origin: base },
    });
    let seq = 0,
      snapshots = 0,
      revision = 0;
    ws.on("message", (raw) => {
      const b = JSON.parse(raw);
      if (b.type === "snapshot") {
        snapshots++;
        revision = b.revision;
      }
    });
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "start" }));
    const interval = setInterval(
      () =>
        ws.readyState === 1 &&
        ws.send(
          JSON.stringify({
            type: "inputs",
            code: room.code,
            revision,
            commands: Array.from({ length: 2 }, () => ({
              seq: seq++,
              d: Math.floor(seq / 120) % 4,
              fire: true,
            })),
          }),
        ),
      1000 / 30,
    );
    clients.push({ ws, interval, snapshots: () => snapshots });
  }
  // One deliberately slow receiver must not stall the other rooms.
  clients[0].ws._socket.pause();
  const start = performance.now();
  await new Promise((r) => setTimeout(r, 15000));
  const steps = app.metrics().sort((a, b) => a - b),
    p95 = steps[Math.floor(steps.length * 0.95)];
  const rooms = [...app.rooms.values()],
    minSnapshots = Math.min(...clients.slice(1).map((c) => c.snapshots()));
  console.log(
    JSON.stringify(
      {
        cpu: cpus()[0].model,
        cores: cpus().length,
        node: process.version,
        rooms: rooms.length,
        seconds: (performance.now() - start) / 1000,
        p95StepMs: +p95.toFixed(3),
        maxStepMs: +steps.at(-1).toFixed(3),
        minSnapshots,
        slowReceiver: true,
      },
      null,
      2,
    ),
  );
  if (rooms.length !== 20 || p95 >= 1000 / 60 || minSnapshots < 200)
    throw Error("Load target failed");
} finally {
  for (const c of clients) {
    clearInterval(c.interval);
    c.ws._socket.resume();
    c.ws.terminate();
  }
  await app.close();
}
