#!/bin/sh
# Ночная резервная копия: база PostgreSQL (контент сайта и заявки) и файлы
# Directus (фото). Лежит 7 дней в /opt/am-site/backups, доступ только у
# deploy. Копия в S3 добавится после покупки хранилища: локальная копия
# спасает от ошибки в данных, но не от потери самого сервера.
#
#   30 3 * * * /opt/am-site/infra/backup.sh >> /opt/am-site/backups/backup.log 2>&1
set -eu

DIR=/opt/am-site/backups
KEEP_DAYS=7
STAMP=$(date +%Y%m%d-%H%M)

umask 077
mkdir -p "$DIR"
cd /opt/am-site/infra

# Пишем во временный файл и переименовываем в конце: недописанная копия
# никогда не выглядит как готовая.
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
	</dev/null >"$DIR/db-$STAMP.dump.tmp"
mv "$DIR/db-$STAMP.dump.tmp" "$DIR/db-$STAMP.dump"

docker run --rm --network none -v infra_directus-uploads:/data:ro node:22-alpine \
	tar -C /data -czf - . </dev/null >"$DIR/uploads-$STAMP.tgz.tmp"
mv "$DIR/uploads-$STAMP.tgz.tmp" "$DIR/uploads-$STAMP.tgz"

find "$DIR" -maxdepth 1 \( -name 'db-*.dump' -o -name 'uploads-*.tgz' \) -mtime +"$KEEP_DAYS" -delete
find "$DIR" -maxdepth 1 -name '*.tmp' -mtime +1 -delete

echo "$(date '+%F %T') ok: db $(du -h "$DIR/db-$STAMP.dump" | cut -f1), uploads $(du -h "$DIR/uploads-$STAMP.tgz" | cut -f1)"
