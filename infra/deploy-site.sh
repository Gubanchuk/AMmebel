#!/usr/bin/env bash
# Выкладывает код сайта на сервер и сразу пересобирает его там.
#
# Копирует frontend (без node_modules и результатов сборки) и
# content-fallback.json в /opt/am-site/site-src, при изменившемся
# package-lock.json ставит пакеты контейнером builder-deps (у самого builder
# интернета нет), затем просит builder собрать сайт без минутной паузы. Тексты и фото сборка берёт из Directus, не из
# репозитория. Файлы инфраструктуры (compose, nginx, builder) этот скрипт не
# трогает — они выкладываются отдельно.
#
#   bash clients/sf-sofa/am-site/infra/deploy-site.sh
set -euo pipefail

HOST=deploy@213.226.124.98
KEY="$HOME/.ssh/am_site"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

tar -C "$ROOT" -czf - \
	--exclude=frontend/node_modules \
	--exclude=frontend/dist \
	--exclude=frontend/.astro \
	--exclude=frontend/src/generated \
	--exclude=frontend/public/cms \
	--exclude=frontend/.vercel \
	--exclude=frontend/.impeccable \
	frontend content-fallback.json |
	ssh -i "$KEY" -o BatchMode=yes "$HOST" '
set -e
cd /opt/am-site/site-src
rm -rf .incoming && mkdir .incoming
tar -xzf - -C .incoming
mkdir -p frontend
# node_modules остаётся: пакеты переставляются ниже, только если сменился package-lock.json
find frontend -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
cp -a .incoming/frontend/. frontend/
cp .incoming/content-fallback.json content-fallback.json
rm -rf .incoming
echo "код сайта выложен"
lock=$(sha256sum frontend/package-lock.json | cut -d " " -f 1)
cd /opt/am-site/infra
if [ "$(cat ../site-src/frontend/node_modules/.package-lock-hash 2>/dev/null)" != "$lock" ]; then
	echo "package-lock.json изменился, ставлю пакеты"
	docker compose --profile tools run --rm -T builder-deps </dev/null
fi
docker compose exec -T builder sh -c "wget -qO- --header=\"X-Rebuild-Token: \$REBUILD_TOKEN\" --post-data= \"http://127.0.0.1:8090/rebuild?now=1\"" </dev/null
echo
echo "сборка запущена, ход: docker compose logs -f builder"
'
