# notes

Персональная зашифрованная доска: заметки, картинки, Markdown, группы и связи. Вход через passkey, данные шифруются в браузере; сервер хранит зашифрованные изменения отдельных объектов. Для шифрования нужен passkey с поддержкой PRF.

## Локально

Node.js 24.13+.

```sh
npm ci
npm run dev
```

Фронт: `http://localhost:5173`, API: `http://localhost:3001`.

Чтобы проверить собранное приложение с одного порта:

```sh
npm run build
ORIGIN=http://localhost:3001 RP_ID=localhost npm start
```

## Docker

```sh
docker build -t notes .
docker run -d --name notes --restart unless-stopped \
  -p 127.0.0.1:3001:3001 \
  -e ORIGIN=https://notes.example.com \
  -e RP_ID=notes.example.com \
  -v notes-data:/data \
  notes
```

Замените пример домена своим. Перед контейнером нужен HTTPS reverse proxy на порт 3001. `ORIGIN` — точный внешний origin без завершающего `/`, `RP_ID` — его hostname. Фронт и `/api/*` обслуживает один Node.js процесс. Домен привязан к passkey: при его смене существующие ключи для старого домена не подойдут.

Контейнер запускается от пользователя `node`. SQLite сохраняется в томе `notes-data` по пути `/data/notes.sqlite`; не удаляйте том при обновлении контейнера. Для резервного копирования SQLite используйте согласованный snapshot/SQLite backup, учитывая WAL, либо остановите контейнер перед копированием каталога `/data`.

Переменные: `ORIGIN`, `RP_ID`, `HOST` (в контейнере `0.0.0.0`), `PORT` (3001), `DATABASE_PATH` и `NODE_ENV` (в контейнере `production`). Проверка доступности: `GET /api/health`.
