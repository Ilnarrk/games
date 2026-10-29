import http from "node:http";
import { createBattleService } from "./games/battle.js";
import { createStaticHandler } from "./static.js";

function requestPath(req) {
  try {
    return new URL(req.url, "http://local").pathname;
  } catch {
    return null;
  }
}

// Add a game's HTTP/WebSocket service here only if it needs a backend.
export function createApp(options = {}) {
  const serveStatic = createStaticHandler(options.publicRoot);
  const battle = createBattleService(options);
  const services = [battle];
  const server = http.createServer((req, res) => {
    const path = requestPath(req);
    if (path === null) {
      res.writeHead(400);
      res.end();
      return;
    }
    const service = services.find((s) => s.ownsHttp(path));
    if (service) return service.handleHttp(req, res);
    return serveStatic(req, res);
  });
  server.on("upgrade", (req, socket, head) => {
    const path = requestPath(req);
    if (path === null) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    const service = services.find((s) => s.ownsUpgrade(path));
    if (service) return service.handleUpgrade(req, socket, head);
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
  });
  return {
    server,
    // These handles support integration tests and diagnostics of the battle service.
    rooms: battle.rooms,
    db: battle.db,
    step: battle.step,
    metrics: battle.metrics,
    async close() {
      await Promise.all(services.map((s) => s.close()));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
