# Сервер опт-сайта АМ

Как устроено, как выкладывать, как восстанавливаться. Состояние на 13.09.2026.

## Где что

- Timeweb Cloud, Санкт-Петербург (SPB-3), `213.226.124.98`, Ubuntu 24.04. Аккаунт Timeweb оформлен на Андрея.
- Вход: `ssh -i ~/.ssh/am_site deploy@213.226.124.98`, системные дела — через `sudo` (без пароля). Вход под root и по паролю выключен.
- `/opt/am-site/infra` — compose, конфиги nginx, скрипты, `.env` с секретами (chmod 600).
- `/opt/am-site/site-src` — код сайта, его выкладывает `deploy-site.sh`.
- `/opt/am-site/site` — выпуски сайта; ссылка `current` указывает на тот, что отдаёт nginx.
- `/opt/am-site/backups` — ночные копии (chmod 700).
- `/opt/am-site` принадлежит root: новые папки там создавать через `sudo` и отдавать `deploy`.

Адреса: https://am-fabrika.ru — сайт, `www`, `amfabrika.ru`, `www.amfabrika.ru` уходят на него 301. https://admin.am-fabrika.ru/admin — админка Directus.

## Контейнеры

Все команды — из `/opt/am-site/infra`.

| Сервис | Что делает | Сети |
|---|---|---|
| `db` | PostgreSQL 16: контент и заявки | внутренняя |
| `directus` | админка, версия закреплена 11.17.4 | внутренняя |
| `proxy` | nginx, единственный с портами наружу (80, 443) | внутренняя + внешняя |
| `builder` | собирает сайт после правок в админке | внутренняя |
| `lead-service` | приём заявок с формы и квиза, пока выключен | внутренняя |
| `builder-deps` | ставит npm-пакеты при выкладке, запускается разово | внешняя |
| `certbot` | выпуск и продление сертификатов, запускается разово | внешняя |

Внутренняя сеть (`am-internal`) без выхода в интернет. Базу и Directus снаружи не видно; стороннему коду из npm не достаются одновременно и база, и интернет.

## Частые действия

**Выложить новый код сайта** — с машины Андрея, из корня репозитория:

```
bash clients/sf-sofa/am-site/infra/deploy-site.sh
```

Скрипт копирует код, при изменившемся `package-lock.json` ставит пакеты и сразу пересобирает сайт. Тексты и фото сборка берёт из Directus.

**Пересобрать вручную и посмотреть статус:**

```
docker compose exec -T builder sh -c 'wget -qO- --header="X-Rebuild-Token: $REBUILD_TOKEN" --post-data= "http://127.0.0.1:8090/rebuild?now=1"'
docker compose exec -T builder wget -qO- http://127.0.0.1:8090/status
docker compose logs -f builder
```

После сохранения в админке сборка стартует сама через минуту. Если Directus недоступен, сборка падает и на сайте остаётся прежний выпуск.

**Выложить изменения инфраструктуры** (compose, nginx, скрипты): скопировать файлы в `/opt/am-site/infra` через `scp`, убрать виндовские переводы строк `sed -i 's/\r$//' <файлы>`, затем:

```
docker compose config -q && docker compose up -d
docker compose exec -T proxy nginx -t && docker compose exec -T proxy nginx -s reload
```

После пересоздания `directus` nginx перечитывать обязательно — иначе он держит старый адрес контейнера.

**Схема, права и flow в Directus** задаются скриптами, не кликами: `setup-collections.py`, `setup-access.py`, `setup-flows.py`, `upload-photos.py`. Все повторно запускаемые. Запуск на сервере: `python3 <скрипт> http://<IP directus>:8055`, IP — `docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' infra-directus-1`. Снимок схемы после изменений:

```
docker compose exec -T directus npx directus schema snapshot --yes /tmp/schema.yaml
docker compose cp directus:/tmp/schema.yaml ./directus-schema.yaml
```

## Приём заявок

`lead-service` (код в `clients/sf-sofa/am-site/lead-service`, на сервере `/opt/am-site/lead-service`) принимает `POST /api/lead` от формы прайса и квиза через nginx (`location /api/`: 6 запросов в минуту с адреса, тело до 16 КБ). Пишет в таблицу `leads` под ролью `lead_service`: только добавить заявку и сменить статус письма; IP и журнал согласия роль записывает, но прочитать не может.

**Сейчас выключен:** `LEADS_ENABLED` не задан, сервис отвечает 503 и к базе не подключается, форма предлагает позвонить. Включать только после подачи уведомления в Роскомнадзор.

Как включить:

1. Уведомление в Роскомнадзор подано.
2. В `.env`: `LEADS_ENABLED=true`; для письма менеджеру — `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `MAIL_TO`; для MAX — `MAX_BOT_TOKEN`, `MAX_CHAT_ID`.
3. Почте и MAX нужен выход в интернет, а сервис сейчас только во внутренней сети. Перед включением добавить ему сеть с выходом наружу; для MAX смонтировать корневой сертификат Минцифры и указать его в `NODE_EXTRA_CA_CERTS` (подробности — `lead-service/README.md`).
4. `docker compose up -d lead-service`, отправить тестовую заявку с сайта, проверить её в админке и удалить.

Новый код сервиса: скопировать папку в `/opt/am-site/lead-service`, `docker compose build lead-service && docker compose up -d lead-service`. Права роли переустанавливаются повторным запуском `sql/grant.sql` (команда в шапке файла). Интеграционный тест прогнан 13.09.2026 на копии рабочей базы из бэкапа — под владельцем таблицы и под `lead_service`.

## Резервные копии

Каждую ночь в 03:30 `backup.sh` снимает `db-<дата>.dump` (pg_dump) и `uploads-<дата>.tgz` (фото из Directus), хранит 7 дней. Лог — `/opt/am-site/backups/backup.log`.

Пока нет хранилища S3, копии лежат на том же сервере: от ошибки в данных спасают, от потери сервера — нет. Файл `.env` в копию не входит, его держать отдельно в менеджере паролей: без `DIRECTUS_SECRET` и паролей базу не поднять.

Восстановление базы в отдельный контейнер проверено 13.09.2026: все десять проверенных таблиц совпали с рабочей базой по числу строк. Порядок восстановления рабочей базы (целиком не прогонялся):

```
docker compose stop directus builder
docker compose exec -T db sh -c 'dropdb -U "$POSTGRES_USER" "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner' < /opt/am-site/backups/db-<дата>.dump
docker run --rm -i -v infra_directus-uploads:/data node:22-alpine tar -C /data -xzf - < /opt/am-site/backups/uploads-<дата>.tgz
docker compose start directus builder
docker compose exec -T proxy nginx -s reload
```

## Сертификаты

Let's Encrypt: отдельно `admin.am-fabrika.ru` и общий на `am-fabrika.ru`, `www.am-fabrika.ru`, `amfabrika.ru`, `www.amfabrika.ru`. Продление — `renew-certs.sh` по cron в понедельник 04:17, лог `renew-certs.log`. Сервер по умолчанию (`nginx/default.conf`) отвечает на проверку Let's Encrypt для любого имени, поэтому новое имя выпускается без временных конфигов:

```
docker compose --profile tools run --rm certbot certonly --webroot -w /var/www/certbot -d <имя> --agree-tos --no-eff-email --register-unsafely-without-email -n
```

## Защита — что настроено

- SSH: только ключи, вход под root запрещён, `MaxAuthTries 3`, `LoginGraceTime 30`, туннели и проброс агента запрещены. В `authorized_keys` один ключ `am-site-deploy`. fail2ban: 5 ошибок входа за 10 минут — бан на час; три бана за сутки — бан на неделю на все порты.
- ufw: входящие только 22, 80, 443 и 443/udp (HTTP/3). Docker публикует только порты nginx. Снаружи проверено: 5432, 8055, 8090, 10050 закрыты.
- Автоматические обновления безопасности Ubuntu.
- Контейнеры: `no-new-privileges`, лимиты памяти, у `directus`, `builder`, `builder-deps`, `lead-service` сброшены все capabilities; у `lead-service` файловая система только для чтения; ротация логов 10 МБ × 3. Версии Directus и nginx закреплены.
- Directus: cookie входа только по https; ограничение 150 запросов в секунду с адреса; в библиотеку файлов — только jpeg, png, webp, avif; пароль не короче 10 символов; публичная регистрация и MCP выключены. Роли: администратор; «Контент-редактор» (контент, заявки только чтение); «Сборка сайта» (токен только на чтение контента, к заявкам — 403).
- nginx: HSTS, TLS 1.2/1.3 (1.0 и 1.1 отклоняются), HTTP/3, версия сервера скрыта, 5 попыток входа в админку в минуту с адреса, неизвестные имена не обслуживаются, `Permissions-Policy` и `Cross-Origin-Opener-Policy` на сайте, сайт и админка закрыты от индексации (`X-Robots-Tag`).
- DNS: записи CAA панель Timeweb не поддерживает (13.09.2026 в списке типов только A, AAAA, TXT, SRV, CNAME, MX).

## Обновление Directus

Версия закреплена в compose, `docker compose pull` её не меняет. Обновлять руками: бэкап → новый тег в `docker-compose.yml` → `docker compose pull directus && docker compose up -d directus` → перечитать nginx → проверить вход в админку и сборку (`rebuild?now=1`).

## Секреты в `.env`

| Переменная | Для чего |
|---|---|
| `DB_NAME`, `DB_USER`, `DB_PASSWORD` | база |
| `DIRECTUS_SECRET` | подпись сессий Directus |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | администратор Directus |
| `PUBLIC_URL` | адрес админки |
| `FRONTEND_TOKEN` | чтение контента при сборке |
| `REBUILD_TOKEN` | запрос пересборки от flow |
| `EDITOR_EMAIL`, `EDITOR_PASSWORD` | учётка контент-редактора |
| `LEAD_DB_PASSWORD` | роль `lead_service` в базе |
| `LEADS_ENABLED`, `SMTP_*`, `MAIL_FROM`, `MAIL_TO`, `MAX_BOT_TOKEN`, `MAX_CHAT_ID` | приём заявок, письмо менеджеру, MAX — пока не заданы |
