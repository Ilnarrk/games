# Карманные игры

Каталог браузерных игр с общим ретро-оформлением. Сейчас доступна «Танчики 99»: соло, кооператив и дуэль. Адрес каталога — `/game`, игры — `/game/battle`.

## Запуск

Node.js 24.15 или новее:

```sh
npm ci
npm start
```

Открыть http://localhost:8080/game. `PORT` меняет порт, `DB_PATH` — путь к SQLite «Танчиков» (по умолчанию `data/game.sqlite`).

Для Docker сначала запустите внешний шлюз с сетью `gateway`. Скопируйте `.env.example` в `.env` и задайте `PUBLIC_ORIGIN` равным внешнему адресу сайта, например `https://example.com`, без завершающего слеша.

```sh
docker compose up -d --build
```

nginx в сервисе `games` проксирует весь `/game` в Node.js. Для новой игры не нужно добавлять маршруты в nginx или новые монтирования. Внешний шлюз должен передавать WebSocket Upgrade для всего `/game`: полный пример — [infra/gateway.nginx.conf.example](infra/gateway.nginx.conf.example). Сам конфиг шлюза в другом репозитории автоматически не меняется.

## Структура

```text
public/
  index.html                 каталог
  catalog.json               список игр
  assets/                    общие стили, шрифты, код каталога
  games/battle/              HTML, клиент, симуляция и стили «Танчиков»
server/
  index.js                   запуск и остановка процесса
  app.js                     HTTP/WebSocket-маршрутизация
  static.js                  каталог и безопасная раздача public/
  games/battle.js            комнаты, сессии и сохранения «Танчиков»
test/
  catalog.test.js            каталог, маршруты, доступ к файлам
  battle/                    проверки «Танчиков», браузер и нагрузка
infra/                       nginx и пример внешнего шлюза
docs/battle.md               правила игры, сеть, сохранения и ограничения
```

Данные SQLite, зависимости и результаты браузерных проверок исключены из Git. Постоянный Docker volume `game-data` сохраняется при обычном `docker compose down`; `down -v` удаляет его. Перенос файлов не меняет cookie, таблицы SQLite и имя volume.

## Добавление игры

1. Создайте `public/games/<id>/index.html` и положите рядом JavaScript, стили и ресурсы игры. `id` — строчные латинские буквы, цифры и дефисы, начиная с буквы.
2. Добавьте запись в `public/catalog.json`:

   ```json
   { "id": "snake", "title": "Змейка", "description": "Классическая аркада" }
   ```

3. Игра появится в каталоге по `/game/snake`. Подключайте её ресурсы по `/game/games/snake/...`, а общий стиль — `/game/assets/console.css`. Стили конкретной игры держите рядом с ней.
4. Если нужен сервер, добавьте модуль в `server/games/` и подключите его в списке `services` в `server/app.js`. Используйте собственные маршруты `/game/<id>/api/*` и `/game/<id>/ws`. Сервис предоставляет `ownsHttp`, `handleHttp`, `ownsUpgrade`, `handleUpgrade`, `close`; комнаты и правила остаются внутри него. Для статической игры серверный модуль не нужен.
5. Добавьте проверки `test/<id>/*.test.js` — `npm test` подхватит их автоматически. Затем перезапустите Node.js или пересоберите контейнеры.

Зарезервированы имена `api`, `assets`, `games`, `ws` и `catalog`. Старые адреса `/game/api/*`, `/game/ws` и `/game/assets/{client,engine,render}.js` и `/game/assets/style.css` поддерживаются как совместимость с предыдущим клиентом «Танчиков». Новые игры их не используют.

## Проверки

```sh
npm test
npm run test:load
npm run test:browser
```

Обычные тесты используют встроенный `node:test`. Для браузерных проверок нужен отдельно установленный Playwright и Chromium; можно задать `PLAYWRIGHT_MODULE` и `CHROMIUM_PATH`. Скриншоты сохраняются в `output/playwright/`. Правила, ограничения сервера и работа сохранений описаны в [docs/battle.md](docs/battle.md).
