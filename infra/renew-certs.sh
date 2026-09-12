#!/bin/sh
# Продление сертификатов Let's Encrypt. Запускается cron'ом пользователя deploy
# раз в неделю; certbot сам решает, пора ли продлевать (за 30 дней до конца
# срока). После прогона nginx перечитывает конфиг и подхватывает новые файлы.
#
#   17 4 * * 1 /opt/am-site/infra/renew-certs.sh >> /opt/am-site/infra/renew-certs.log 2>&1
set -e
cd /opt/am-site/infra
docker compose --profile tools run --rm certbot renew --webroot -w /var/www/certbot --quiet
docker compose exec -T proxy nginx -s reload
