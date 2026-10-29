import { createApp } from "./app.js";
const app = createApp();
const port = Number(process.env.PORT || 8080);
app.server.listen(port, "0.0.0.0", () =>
  console.log(`Карманные игры: http://localhost:${port}/game`),
);
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
