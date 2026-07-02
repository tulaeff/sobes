# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Шпаргалка для собеса (PHP/Symfony, финтех + фуллстек): 655 карточек вопрос-ответ по 31 теме, тёмная тема. Открывается на https://sobes.local (домен в `/etc/hosts`, TLS через общий nginx-proxy). Данные в **PostgreSQL**, отдаются тонким **PHP-API** с кэшем в **Redis**; фронт грузит всё одним запросом и ищет **в браузере** (поэтому быстро). Всё крутится в Docker.

## Команды (всё в Docker)

```bash
docker compose up -d --build                          # поднять/пересобрать стек (web, php, postgres, redis)
docker compose exec php php /var/www/api/seed.php      # (пере)залить БД из public/data/parts/*.json + db/*.json
docker compose down                                    # стоп (данные в volume sobes-pgdata сохраняются)
```

Проверять UI **только через расширение Chrome** (claude-in-chrome MCP), не через внутренний preview — внутренний preview не видит API/БД. Ассеты версионируются `?v=N` в `public/index.html` (бампать на всех `<link>/<script>` при правке фронта, иначе браузер отдаст старьё из кеша).

## Данные и бэкенд

- **Postgres** (`sobes-postgres`, БД/юзер/пароль `sobes`): `db/schema.sql` — таблицы `categories`, `questions` (q/a/detail/code/tags/weight/pinned/edited/orig/sort_order), `settings` (личные заготовки self/task). Источник правды.
- **Сид**: `api/seed.php` (запуск в php-контейнере) читает `db/categories.json` (порядок+названия), `public/data/parts/<key>.json` (карточки с полем `weight`), `db/personal.json`. **`TRUNCATE questions` — перезаливаются ТОЛЬКО вопросы**; категории и personal вставляются `ON CONFLICT DO NOTHING`, т.е. их правки в БД НЕ затираются пересидом (файлы `db/*.json` — только первичный бутстрап). `orig` = снимок карточки для «вернуть оригинал».
- **Redis** (`sobes-redis`): кэширует собранный JSON под ключом `sobes:cards`; любая правка делает `DEL` (см. `cacheBust()`).
- **API** `api/index.php` (php-fpm, PDO+phpredis, без фреймворка). Роуты после `/api`:
  - `GET /cards` — `{categories, items, personal}` из кэша (на промахе собирает из БД и кэширует).
  - `POST /cards/{id}/pin {pinned}` · `POST /pins/clear` — закрепы.
  - `PATCH /cards/{id}` (q/a/detail/code) → `edited=true` · `POST /cards/{id}/reset` → восстановить из `orig`.
  - `PATCH /personal/{self|task}` {title, body} — правка личных заготовок.
  - `PATCH /categories/{key}` {title} — переименование · `POST /categories/reorder` {order:[key]} — порядок (правило reorder ДО правила `{key}`, иначе "reorder" матчится как ключ).
  - Redis необязателен: при недоступности код падает на прямой запрос к БД.

В UI редактируются вопросы (карандаш) и personal (карандаш в попапе) — канонично в БД. Категории в UI НЕ редактируются (по просьбе пользователя кнопку убрали); их правит только бэкенд-API (`PATCH /categories/{key}`, `POST /categories/reorder`) — вызывать по запросу. Массово вопросы — правишь `parts/*.json` → `seed.php` (категории/personal при этом сохраняются).

## Фронт (`public/`, без сборки, неймспейс `window.SOBES`)

Порядок в `index.html`: `api.js` → `search.js` → `app.js`. `app.js` при старте делает `SOBES.api.load()` (`GET /api/cards`), кладёт в `SOBES._items`, `window.PERSONAL`, строит сайдбар и рендерит.

- **`api.js`** (`SOBES.api`): fetch-клиент — `load`, `setPin`, `clearPins`, `saveEdit`, `reset`. Правки/закрепы **оптимистичны**: UI меняется сразу, запрос в фоне, при ошибке — откат + alert. Флаги `pinned`/`edited` приходят прямо в item из БД (никакого localStorage).
- **`search.js`** (`SOBES.search`): движок в браузере. `reindex(it)` строит `_hay/_hayLat(транслит)/_tokens/_q/_a/_detail/...`. Поиск — AND по термам с весами полей; варианты терма: основа (стемминг рус), смена раскладки RU↔EN, транслит; пустой результат → fuzzy по Левенштейну. Сортировка: закреплённые → (в поиске: релевантность + подмешанный `weight`·0.03) → `weight` desc → индекс. **После правки текста карточки звать `engine.reindex(it)`**.
- **`app.js`**: весь UI (один IIFE). Рендер **чанками** (`CHUNK=70`, первый синхронно — быстрый первый экран); подсветка кода **ленивая** (`ensureHl` при раскрытии «Подробнее»); мини-markdown (`mdInline/mdBlock`) и мини-подсветка (`highlightCode`+`KW`) без либ; подсветка совпадений через `TreeWalker`. Главная без категории/поиска = только закреплённые (поиск при этом по всем). Кнопки «о себе»/«задача» → попап из `window.PERSONAL`.

## Отдача (docker)

`docker-compose.yml`: `web` (nginx:alpine) монтирует `public/` ro и `docker/site.conf`, в сетях `proxy-network` (внешняя, общий reverse-proxy) + `sobes-internal`; роут `/api/` → `sobes-php:9000` (fastcgi). `php` (`docker/php/Dockerfile`: php-fpm-alpine + pdo_pgsql + redis + opcache) в `sobes-internal`, монтирует `api/`, `db/`, `public/` ro. Домен `sobes.local` — в общем nginx-proxy (см. память `local-domain-recipe`), сертификат mkcert.
