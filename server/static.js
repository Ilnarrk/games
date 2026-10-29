import { readFileSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { dirname, extname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../public",
);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
};
// Old cached battle pages and clients retain their original asset addresses.
const legacy = new Map(
  ["client.js", "engine.js", "render.js", "netcode.js", "style.css"].map(
    (name) => ["assets/" + name, "games/battle/" + name],
  ),
);
const reserved = new Set(["api", "assets", "games", "ws", "catalog"]);
export function createStaticHandler(publicRoot = defaultRoot) {
  const catalog = JSON.parse(
    readFileSync(resolve(publicRoot, "catalog.json"), "utf8"),
  );
  if (
    !Array.isArray(catalog) ||
    catalog.some(
      (g) =>
        !g ||
        !/^[a-z][a-z0-9-]*$/.test(g.id) ||
        reserved.has(g.id) ||
        typeof g.title !== "string" ||
        typeof g.description !== "string",
    ) ||
    new Set(catalog.map((g) => g.id)).size !== catalog.length
  )
    throw Error("Invalid public/catalog.json");
  const games = new Set(catalog.map((g) => g.id));
  return async (req, res) => {
    try {
      if (!["GET", "HEAD"].includes(req.method)) {
        res.writeHead(405, { Allow: "GET, HEAD" });
        res.end();
        return;
      }
      const path = decodeURIComponent(
        new URL(req.url, "http://local").pathname,
      );
      if (path !== "/game" && !path.startsWith("/game/"))
        throw Object.assign(Error(), { status: 404 });
      const parts = path.slice("/game".length).split("/").filter(Boolean);
      if (
        parts.some(
          (p) => p.startsWith(".") || p.includes("\\") || p.includes("\0"),
        )
      )
        throw Object.assign(Error(), { status: 404 });
      let file = parts.join("/") || "index.html";
      if (games.has(file)) file = `games/${file}/index.html`;
      file = legacy.get(file) || file;
      const absolute = await realpath(resolve(publicRoot, file));
      if (relative(publicRoot, absolute).startsWith(".."))
        throw Object.assign(Error(), { status: 404 });
      const contents = await readFile(absolute);
      res.writeHead(200, {
        "Content-Type": types[extname(file)] || "application/octet-stream",
        "Content-Length": contents.length,
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'self'",
      });
      res.end(req.method === "HEAD" ? undefined : contents);
    } catch (e) {
      const status =
        e.status ||
        (e instanceof URIError
          ? 400
          : ["ENOENT", "ENOTDIR", "EISDIR"].includes(e.code)
            ? 404
            : 500);
      if (status === 500) console.error(e);
      res.writeHead(status, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(
        status === 500 ? "Сервис временно недоступен." : "Страница не найдена.",
      );
    }
  };
}
