# Сервер опт-сайта АМ

Как устроено, как выкладывать, как восстанавливаться. Состояние на 14.09.2026.

## Где что

- Timeweb Cloud, Санкт-Петербург (SPB-3), `213.226.124.98`, Ubuntu 24.04. Аккаунт Timeweb оформлен на Андрея.
- Вход: `ssh -i ~/.ssh/am_site deploy@213.226.124.98`, системные дела — через `sudo` (без пароля). Вход под root и по паролю выключен.
- `/opt/am-site/infra` — compose, конфиги nginx, скрипты, `.env` с секретами (chmod 600).
- `/opt/am-site/site-src` — код сайта, его выкладывает `deploy-site.sh`.
- `/opt/am-site/site` — выпуски сайта; ссылка `current` указывает на тот, что отдаёт nginx.
- `/opt/am-site/backups` — ночные копии (chmod 700).
- `/opt/am-site/stats` — журнал статистики страниц `stats.log` (см. «Статистика страниц»).
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
| `lead-service` | приём заявок с формы и квиза, включён 14.09.2026 | внутренняя + `am-leads-out` |
| `builder-deps` | ставит npm-пакеты при выкладке, запускается разово | внешняя |
| `certbot` | выпуск и продление сертификатов, запускается разово | внешняя |

Внутренняя сеть (`am-internal`) без выхода в интернет. Базу и Directus снаружи не видно; стороннему коду из npm не достаются одновременно и база, и интернет. `lead-service` ходит наружу (почта, MAX) через свою сеть `am-leads-out`, других контейнеров в ней нет.

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

**Схема, права, flow и вид админки в Directus** задаются скриптами, не кликами: `setup-collections.py`, `setup-access.py`, `setup-flows.py`, `setup-ui.py` (русские названия, подсказки, списки по умолчанию), `upload-photos.py`. Все повторно запускаемые. Запуск на сервере: `python3 <скрипт> http://<IP directus>:8055`, IP — `docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' infra-directus-1`. Снимок схемы после изменений:

```
docker compose exec -T directus npx directus schema snapshot --yes /tmp/schema.yaml
docker compose cp directus:/tmp/schema.yaml ./directus-schema.yaml
```

## Приём заявок

`lead-service` (код в `clients/sf-sofa/am-site/lead-service`, на сервере `/opt/am-site/lead-service`) принимает `POST /api/lead` от формы прайса и квиза через nginx (`location /api/`: 6 запросов в минуту с адреса, тело до 16 КБ). Пишет в таблицу `leads` под ролью `lead_service`: только добавить заявку и сменить статус письма; IP и журнал согласия роль записывает, но прочитать не может.

**Включён 14.09.2026** решением Андрея: заявки пишутся в базу, в MAX уходит уведомление с кнопкой на карточку заявки, письма менеджеру не настроены. Выключить: `LEADS_ENABLED=false` в `.env` и `docker compose up -d lead-service` — сервис ответит 503, форма предложит позвонить.

Как включали:

1. Уведомление в Роскомнадзор — на 14.09.2026 не подано, приём включён без него решением Андрея.
2. В `.env`: `LEADS_ENABLED=true`; для письма менеджеру — `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `MAIL_TO`. `MAX_BOT_TOKEN` и `MAX_CHAT_ID` заданы 14.09.2026.
3. Выход наружу и MAX готовы с 14.09.2026: сеть `am-leads-out`, корневой сертификат Минцифры `certs/russian_trusted_root_ca.pem` смонтирован, `NODE_EXTRA_CA_CERTS` задан в compose. Отправка из контейнера проверена тестовым сообщением.
4. `docker compose up -d lead-service`, отправить тестовую заявку с сайта, проверить её в админке и удалить.

**Заявки из лид-формы VK** (с 23.10.2026, код в `lead-service/src/vk-leads.mjs`, описание в README сервиса): сервис раз в минуту забирает заявки форм из `VK_LEAD_FORM_IDS` через API VK Рекламы и пишет их в `leads` с типом `vk`. Включить: в `.env` задать `VK_ADS_CLIENT_ID`, `VK_ADS_CLIENT_SECRET`, `VK_LEAD_FORM_IDS=1026922`, затем `docker compose up -d lead-service`; в логе должно быть `vk lead forms: polling forms 1026922 every 60 s`. Выход к `ads.vk.ru` из контейнера проверен 23.10.2026. Поле `leads.external_id` (уникальное) добавлено `setup-collections.py` 23.10.2026.

Новый код сервиса: скопировать папку в `/opt/am-site/lead-service`, `docker compose build lead-service && docker compose up -d lead-service`. Права роли переустанавливаются повторным запуском `sql/grant.sql` (команда в шапке файла). Интеграционный тест прогнан 13.09.2026 на копии рабочей базы из бэкапа — под владельцем таблицы и под `lead_service`.

## Статистика страниц

С 03.10.2026. Метрика загружается только после «Разрешить» в окне о cookie и не видит большинство заходов с рекламы. Поэтому сайт сам, без cookie и без записи в хранилище браузера, шлёт сигналы о каждом просмотре страницы (`frontend/src/scripts/stats.js`): докуда долистали и сколько секунд провели на каждом блоке, какие поля формы трогали и на каких форма остановила (без введённых значений), звонок, заявка, что сделали с окном о cookie, UTM-метки и признак клика по рекламе (`yclid` был в адресе, само значение не передаётся). Номер просмотра случайный и живёт до перезагрузки страницы.

nginx отвечает на `GET /s` пустой картинкой (`location = /s` в `nginx/site.conf`, 60 запросов в минуту с адреса) и пишет в `/opt/am-site/stats/stats.log` только время с точностью до минуты (UTC), статус и строку запроса. IP, браузер и referer туда не попадают, в общий журнал обращений эти запросы не пишутся. Папка смонтирована в `proxy` и переживает пересоздание контейнера. Журнал растёт примерно на 0,5 КБ за просмотр, ротации пока нет.

Отчёт по кликам с рекламы (визиты автоматических браузеров с `navigator.webdriver` отбрасываются):

```
python3 /opt/am-site/infra/stats-report.py --since 2026-10-03
python3 /opt/am-site/infra/stats-report.py --all     # все просмотры, не только реклама
```

Тексты политики про эту статистику ещё не обновлены — правка в `clients/sf-sofa/legal/next-revision.md`.

## Резервные копии

Каждую ночь в 03:30 `backup.sh` снимает `db-<дата>.dump` (pg_dump) и `uploads-<дата>.tgz` (фото из Directus), хранит 7 дней на сервере и отправляет те же файлы в S3. Лог — `/opt/am-site/backups/backup.log`.

S3 с 17.09.2026: Timeweb Cloud, Санкт-Петербург, «Стандартный», 10 ГБ, 79 ₽/мес, автомасштабирование выключено, приватный бакет `am-site-backup` на аккаунте Андрея. Ключи — у отдельного пользователя хранилища `am-site-backup-server` с правами «Чтение и запись» только на этот бакет, лежат в `.env` (`S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`). rclone (из apt) берёт настройки из переменных окружения, файла конфигурации нет. В хранилище копии живут 14 дней (`rclone delete --min-age 14d`). Первая отправка и чтение проверены 17.09.2026.

Посмотреть, что лежит в хранилище (на сервере под `deploy`):

```
E=/opt/am-site/infra/.env; g(){ grep "^$1=" $E | cut -d= -f2-; }
RCLONE_CONFIG=/dev/null RCLONE_CONFIG_O_TYPE=s3 RCLONE_CONFIG_O_PROVIDER=Other RCLONE_CONFIG_O_ENDPOINT=$(g S3_ENDPOINT) RCLONE_CONFIG_O_REGION=$(g S3_REGION) RCLONE_CONFIG_O_ACCESS_KEY_ID=$(g S3_ACCESS_KEY) RCLONE_CONFIG_O_SECRET_ACCESS_KEY=$(g S3_SECRET_KEY) rclone ls o:$(g S3_BUCKET)
```

Файл `.env` в копию не входит, его держать отдельно в менеджере паролей: без `DIRECTUS_SECRET` и паролей базу не поднять.

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
- Directus: cookie входа только по https; ограничение 150 запросов в секунду с адреса; в библиотеку файлов — только jpeg, png, webp, avif; пароль не короче 12 символов; публичная регистрация и MCP выключены. Роли: администратор; «Контент-редактор» (контент, заявки только чтение); «Сборка сайта» (токен только на чтение контента, к заявкам — 403).
- nginx: HSTS, TLS 1.2/1.3 (1.0 и 1.1 отклоняются), HTTP/3, сайт во фрейме показывают только он сам и интерфейс Метрики (`frame-ancestors` вместо `X-Frame-Options` с 03.10.2026 — для Вебвизора и карт; у админки `X-Frame-Options SAMEORIGIN`), версия сервера скрыта, 5 попыток входа в админку в минуту с адреса, неизвестные имена не обслуживаются, `Permissions-Policy` и `Cross-Origin-Opener-Policy` на сайте, сайт и админка закрыты от индексации (`X-Robots-Tag`).
- Журналы: nginx пишет IP посетителя без последнего октета (`nginx/00-logging.conf`), в журнале ошибок nginx адрес полный; логи контейнеров ротируются по размеру, 10 МБ × 3. Directus удаляет журнал действий и историю правок через год, журналы flow — через 30 дней; у заявок хранится только журнал действий, без снимков записи.
- Антивирус (17.09.2026): ClamAV 1.5.3. Официальная сеть доставки баз отвечает из России 403, поэтому в `/etc/clamav/freshclam.conf` вместо `DatabaseMirror` — `PrivateMirror https://mirror.truenetwork.ru/clamav` и запасной `PrivateMirror https://packages.microsoft.com/clamav`, `ScriptedUpdates no`, `Checks 2`, `TestDatabases no` (исходный файл — `freshclam.conf.orig`). Служба `clamav-freshclam` включена. Ночная проверка — `infra/antivirus-scan.sh` из `/etc/cron.d/am-site-antivirus` в 04:30 от root: том с фото Directus и весь `/opt/am-site`, журнал `/var/log/am-site/antivirus.log`. О находке, ошибке проверки и базах старше трёх дней скрипт пишет в MAX (чат из `MAX_CHAT_ID`), имена файлов — только в журнал. Проверено 17.09.2026: базы скачались с зеркала с файлами подписи, тестовый EICAR найден, полная проверка 2 мин 5 с, пик памяти 1,0 ГБ, чисто. `DRY_RUN=1` печатает сообщение вместо отправки. Если зеркала перестанут обновлять базы — запасной вариант Dr.Web Server Security Suite для Unix (сравнение в `clients/sf-sofa/checklist-zapusk.md`).
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
| `LEADS_ENABLED` | приём заявок, `true` с 14.09.2026 |
| `SMTP_*`, `MAIL_FROM`, `MAIL_TO` | письмо менеджеру — пока не заданы |
| `MAX_BOT_TOKEN`, `MAX_CHAT_ID` | бот MAX «Авторская мебель» `@id2373027390_bot`; чат — личный диалог Жени с ботом. Заданы 14.09.2026 |
