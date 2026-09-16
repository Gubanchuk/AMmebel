#!/bin/sh
# Ночная резервная копия: база PostgreSQL (контент сайта и заявки) и файлы
# Directus (фото). Лежит 7 дней в /opt/am-site/backups, доступ только у
# deploy, и 14 дней в приватном хранилище S3 Timeweb (Санкт-Петербург,
# бакет am-site-backup, с 17.09.2026): локальная копия спасает от ошибки в
# данных, внешняя — от потери самого сервера. Ключи хранилища — в .env
# (S3_*), у ключа доступ только к этому бакету.
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

# Offsite copy. rclone takes the remote from environment variables, so the keys
# never land in a config file; a failed upload fails the job and shows in the log.
ENV_FILE=/opt/am-site/infra/.env
S3_KEEP_DAYS=14
env_get() { grep "^$1=" "$ENV_FILE" | cut -d= -f2-; }
if [ -n "$(env_get S3_ACCESS_KEY)" ]; then
	export RCLONE_CONFIG=/dev/null
	export RCLONE_CONFIG_OFFSITE_TYPE=s3
	export RCLONE_CONFIG_OFFSITE_PROVIDER=Other
	export RCLONE_CONFIG_OFFSITE_ENDPOINT="$(env_get S3_ENDPOINT)"
	export RCLONE_CONFIG_OFFSITE_REGION="$(env_get S3_REGION)"
	export RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID="$(env_get S3_ACCESS_KEY)"
	export RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY="$(env_get S3_SECRET_KEY)"
	export RCLONE_CONFIG_OFFSITE_NO_CHECK_BUCKET=true
	BUCKET=$(env_get S3_BUCKET)
	rclone copyto "$DIR/db-$STAMP.dump" "offsite:$BUCKET/db-$STAMP.dump"
	rclone copyto "$DIR/uploads-$STAMP.tgz" "offsite:$BUCKET/uploads-$STAMP.tgz"
	rclone delete --min-age "${S3_KEEP_DAYS}d" "offsite:$BUCKET"
	echo "$(date '+%F %T') offsite ok: $(rclone ls "offsite:$BUCKET" | wc -l) files in $BUCKET"
else
	echo "$(date '+%F %T') offsite skipped: no S3_ACCESS_KEY in .env"
fi
