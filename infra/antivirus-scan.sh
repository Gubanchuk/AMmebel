#!/bin/sh
# Ночная антивирусная проверка сервера (документ о мерах защиты, п. 7.10):
# фото, загруженные в Directus, и весь /opt/am-site. Запускается после
# резервного копирования (03:30), от root — каталог тома Docker закрыт для
# остальных.
#
#   /etc/cron.d/am-site-antivirus: 30 4 * * * root /opt/am-site/infra/antivirus-scan.sh
#
# Базы ClamAV обновляет служба clamav-freshclam с зеркал внутри досягаемости
# из России (официальная сеть доставки отвечает 403), настройка — DEPLOY.md.
# О находке, об ошибке проверки и о базах старше трёх дней уходит сообщение
# в MAX, в тот же чат, что и уведомления о заявках. Имена файлов в сообщение
# не попадают, только в журнал.
#
# DRY_RUN=1 печатает сообщение вместо отправки (проверка скрипта).
set -u
PATH=/usr/sbin:/usr/bin:/sbin:/bin

LOG_DIR=/var/log/am-site
LOG="$LOG_DIR/antivirus.log"
ENV_FILE=/opt/am-site/infra/.env
RU_CA=/opt/am-site/infra/certs/russian_trusted_root_ca.pem
MAX_API=https://platform-api2.max.ru

mkdir -p "$LOG_DIR"
stamp() { date '+%F %T'; }

notify() {
	if [ "${DRY_RUN:-0}" = 1 ]; then
		echo "DRY_RUN message: $1"
		return 0
	fi
	token=$(grep '^MAX_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
	chat=$(grep '^MAX_CHAT_ID=' "$ENV_FILE" | cut -d= -f2-)
	if [ -z "$token" ] || [ -z "$chat" ]; then
		echo "$(stamp) notify skipped: MAX_BOT_TOKEN or MAX_CHAT_ID is empty" >>"$LOG"
		return 1
	fi
	# platform-api2.max.ru is signed by the Russian Trusted Root CA, which the
	# system store does not carry: add it to a temporary bundle for this call
	bundle=$(mktemp)
	cat /etc/ssl/certs/ca-certificates.crt "$RU_CA" >"$bundle"
	code=$(curl -sS -m 20 -o /dev/null -w '%{http_code}' --cacert "$bundle" \
		-X POST "$MAX_API/messages?chat_id=$chat" \
		-H "authorization: $token" -H 'content-type: application/json' \
		--data "{\"text\": \"$1\"}")
	rm -f "$bundle"
	echo "$(stamp) notify: MAX answered $code" >>"$LOG"
}

UPLOADS=$(docker volume inspect infra_directus-uploads --format '{{.Mountpoint}}' 2>/dev/null)
if [ -z "$UPLOADS" ]; then
	echo "$(stamp) error: Directus uploads volume not found" >>"$LOG"
	notify "Антивирус на сервере am-fabrika.ru: не нашёл каталог фото Directus, проверка не прошла. Нужен Андрей."
	exit 2
fi

started=$(date +%s)
report=$(mktemp)
nice -n 19 ionice -c3 clamscan --recursive --infected --no-summary \
	"$UPLOADS" /opt/am-site >"$report" 2>&1
rc=$?
took=$(( $(date +%s) - started ))
found=$(grep -c ' FOUND$' "$report")
version=$(sigtool --info /var/lib/clamav/daily.cvd 2>/dev/null | sed -n 's/^Version: //p')
[ -n "$version" ] || version=$(sigtool --info /var/lib/clamav/daily.cld 2>/dev/null | sed -n 's/^Version: //p')

echo "$(stamp) rc=$rc found=$found took=${took}s daily=${version:-unknown}" >>"$LOG"
if [ "$rc" -ne 0 ]; then
	sed 's/^/    /' "$report" >>"$LOG"
fi
rm -f "$report"

case "$rc" in
	0) ;;
	1) notify "Антивирус на сервере am-fabrika.ru нашёл подозрительные файлы: $found. Файлы не удалены, список — в журнале проверки. Перешлите это Андрею." ;;
	*) notify "Антивирус на сервере am-fabrika.ru: ночная проверка завершилась с ошибкой. Перешлите это Андрею." ;;
esac

# Bases older than three days mean the mirrors stopped updating (АВЗ.2).
if ! find /var/lib/clamav -maxdepth 1 -name 'daily.c[lv]d' -mtime -3 | grep -q .; then
	echo "$(stamp) warning: daily signatures are older than 3 days" >>"$LOG"
	notify "Антивирус на сервере am-fabrika.ru: базы признаков не обновлялись больше трёх дней. Перешлите это Андрею."
fi

exit "$rc"
