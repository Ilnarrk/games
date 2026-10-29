const PALETTE = [
  ["#c0c4cc", "#555a66", "#f2f4f8"],
  ["#3cc7c0", "#1b6b67", "#a8f2ee"],
  ["#e8742a", "#8a3a0c", "#ffc08a"],
  ["#4caf50", "#1b5e20", "#a5e8a8"],
];
export function renderer(canvas) {
  const x = canvas.getContext("2d");
  x.imageSmoothingEnabled = false;
  function tank(t, colors) {
    const [main, dark, light] = colors;
    x.save();
    x.translate(Math.round(t.x) + 16, Math.round(t.y) + 16);
    x.rotate((t.d * Math.PI) / 2);
    x.fillStyle = dark;
    x.fillRect(-15, -15, 8, 30);
    x.fillRect(7, -15, 8, 30);
    x.fillStyle = "#76816b";
    for (let i = -14 + Math.floor(t.m % 4); i < 14; i += 4) {
      x.fillRect(-15, i, 8, 2);
      x.fillRect(7, i, 8, 2);
    }
    x.fillStyle = main;
    x.fillRect(-9, -12, 18, 25);
    x.fillStyle = light;
    x.fillRect(-9, -12, 3, 22);
    x.fillStyle = dark;
    x.fillRect(-6, 7, 12, 5);
    x.fillStyle = light;
    x.fillRect(-2, -22 - t.lv, 4 + t.lv, 18);
    x.fillStyle = dark;
    x.fillRect(-7, -6, 14, 14);
    x.fillStyle = main;
    x.fillRect(-5, -5, 10, 10);
    x.fillStyle = light;
    x.fillRect(-5, -5, 4, 3);
    if (t.lv >= 2) {
      x.fillStyle = light;
      x.fillRect(-7, -15, 3, 7);
      x.fillRect(4, -15, 3, 7);
    }
    x.restore();
    if (t.inv > 0 && (t.inv > 60 || Math.floor(t.inv / 6) % 2)) {
      x.strokeStyle = "#9cd9b0";
      x.lineWidth = 2;
      x.strokeRect(Math.round(t.x) - 3, Math.round(t.y) - 3, 38, 38);
    }
  }
  function bonus(b) {
    x.fillStyle = [
      "#b79b42",
      "#428b9c",
      "#b95752",
      "#7b7b6c",
      "#6683bd",
      "#a27542",
    ][b.k];
    x.fillRect(b.x + 2, b.y + 2, 28, 28);
    x.strokeStyle = "#eef2d0";
    x.strokeRect(b.x + 3, b.y + 3, 26, 26);
    x.fillStyle = "#fff";
    x.font = "bold 20px monospace";
    x.textAlign = "center";
    x.fillText(["★", "S", "+", "B", "T", "F"][b.k], b.x + 16, b.y + 23);
  }
  return function draw(w) {
    x.fillStyle = "#101810";
    x.fillRect(0, 0, 416, 416);
    if (!w) return;
    for (let j = 0; j < 26; j++)
      for (let i = 0; i < 26; i++) {
        const v = w.grid[j][i],
          px = i * 16,
          py = j * 16;
        if (v === 1) {
          x.fillStyle = "#b77443";
          x.fillRect(px, py, 16, 16);
          x.fillStyle = "#573b29";
          x.fillRect(px, py + 7, 16, 2);
          x.fillRect(px + (j % 2 ? 3 : 11), py, 2, 7);
          x.fillRect(px + (j % 2 ? 11 : 3), py + 9, 2, 7);
        }
        if (v === 2) {
          x.fillStyle = "#859183";
          x.fillRect(px, py, 16, 16);
          x.fillStyle = "#cad4ba";
          x.fillRect(px, py, 16, 2);
          x.fillRect(px, py, 2, 16);
          x.fillStyle = "#adb7a0";
          x.fillRect(px + 4, py + 4, 8, 8);
        }
        if (v === 3) {
          x.fillStyle = "#284c69";
          x.fillRect(px, py, 16, 16);
          x.fillStyle = "#5888a1";
          const offset = (Math.floor(w.tick / 16) % 2) * 6;
          x.fillRect(px + 2 + offset, py + 4, 6, 2);
          x.fillRect(px + 8 - offset, py + 11, 6, 2);
        }
      }
    for (const base of w.bases) {
      x.fillStyle = base.alive
        ? base.team
          ? "#58b8d0"
          : "#d9ce73"
        : "#58614e";
      x.fillRect(base.x + 2, base.y + 2, 28, 28);
      x.fillStyle = "#303c35";
      x.fillRect(base.x + 8, base.y + 8, 16, 18);
      x.fillStyle = base.alive ? "#eef2d0" : "#58614e";
      x.fillRect(base.x + 12, base.y + 12, 8, 8);
    }
    for (const b of w.bonuses) if (b.t > 180 || w.tick % 10 >= 5) bonus(b);
    for (const t of w.enemies) {
      let p = PALETTE[t.ty];
      if (t.ty === 3) p = PALETTE[Math.max(0, t.hp - 1)] || p;
      if (t.bn && w.tick % 20 < 10) p = ["#c65551", "#76322f", "#f5a282"];
      x.globalAlpha = w.freeze ? 0.65 : 1;
      tank(t, p);
      x.globalAlpha = 1;
    }
    for (const p of w.players)
      if (p.alive)
        tank(
          p,
          p.slot === 0
            ? ["#d9ce73", "#817b3e", "#f1e5a6"]
            : ["#58b8d0", "#316b7b", "#b1e4e6"],
        );
    for (const b of w.bullets) {
      x.fillStyle = "#eef2d0";
      x.fillRect(Math.round(b.x) - 2, Math.round(b.y) - 2, 4, 4);
    }
    for (let j = 0; j < 26; j++)
      for (let i = 0; i < 26; i++)
        if (w.grid[j][i] === 4) {
          x.fillStyle = "#2a512a";
          x.fillRect(i * 16, j * 16, 16, 16);
          x.fillStyle = "#527a3a";
          x.fillRect(i * 16 + 2, j * 16 + 2, 7, 6);
          x.fillRect(i * 16 + 8, j * 16 + 8, 7, 6);
        }
    for (const f of w.fx) {
      const k = f.t / 20,
        size = Math.ceil((f.r * k + 4) / 4) * 4;
      x.globalAlpha = 1 - k;
      x.fillStyle = k < 0.4 ? "#efe59a" : "#dc8742";
      x.fillRect(f.x - size / 2, f.y - size / 2, size, size);
      x.globalAlpha = 1;
    }
    if (w.banner > 0) {
      x.fillStyle = "#101810d9";
      x.fillRect(70, 177, 276, 50);
      x.fillStyle = "#eef2d0";
      x.font = "30px Retro, monospace";
      x.textAlign = "center";
      x.fillText(
        w.mode === "duel" ? "ЗАЩИТИ БАЗУ" : "УРОВЕНЬ " + w.level,
        208,
        211,
      );
    }
  };
}
