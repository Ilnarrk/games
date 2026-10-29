const list = document.getElementById("games");
const status = document.getElementById("catalog-status");
try {
  const response = await fetch("/game/catalog.json");
  if (!response.ok) throw Error("Catalog unavailable");
  const games = await response.json();
  list.replaceChildren(
    ...games.map((game) => {
      const link = document.createElement("a");
      link.className = "cartridge";
      link.href = "/game/" + encodeURIComponent(game.id);
      const title = document.createElement("strong");
      title.textContent = game.title;
      const description = document.createElement("span");
      description.textContent = game.description;
      const action = document.createElement("span");
      action.className = "cartridge-cta";
      action.textContent = "Вставить картридж ▸";
      if (game.icon) {
        const icon = document.createElement("span");
        icon.className = game.icon;
        icon.setAttribute("aria-hidden", "true");
        link.append(icon);
      }
      link.append(title, description, action);
      return link;
    }),
  );
  status.hidden = true;
} catch {
  status.textContent =
    "Не удалось загрузить игры. Обновите страницу, чтобы повторить.";
}
