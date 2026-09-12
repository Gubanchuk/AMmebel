#!/usr/bin/env python3
"""Flow в Directus: после правки контента просит сервис сборки обновить сайт.

Срабатывает на создание, правку и удаление записей в коллекциях сайта и на
загрузку файлов (замена фото в библиотеке). Запрос уходит в контейнер builder
по внутренней сети с токеном из .env (REBUILD_TOKEN); сама пересборка
стартует через минуту после последнего сохранения.

Повторный запуск безопасен: flow и его шаг находятся по имени и ключу,
адрес и токен перезаписываются.

    python3 setup-flows.py http://172.18.0.3:8055
"""

import json
import sys
import urllib.parse
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8055"

with open("/opt/am-site/infra/.env", encoding="utf-8") as f:
    ENV = dict(
        line.strip().split("=", 1)
        for line in f
        if "=" in line and not line.startswith("#")
    )

FLOW_NAME = "Пересборка сайта"
OPERATION_KEY = "rebuild"
REBUILD_URL = "http://builder:8090/rebuild"

FLOW_OPTIONS = {
    "type": "action",
    "scope": ["items.create", "items.update", "items.delete", "files.upload"],
    "collections": ["settings", "conditions", "models", "faq"],
}

token = None


def call(method, path, payload=None):
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps(payload).encode() if payload is not None else None,
        method=method,
    )
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=30) as r:
        body = r.read().decode()
        return json.loads(body) if body else {}


def main():
    global token
    token = call(
        "POST",
        "/auth/login",
        {"email": ENV["ADMIN_EMAIL"], "password": ENV["ADMIN_PASSWORD"]},
    )["data"]["access_token"]
    print("вход выполнен")

    name = urllib.parse.quote(FLOW_NAME)
    flows = call("GET", f"/flows?filter[name][_eq]={name}&fields=id")["data"]
    if flows:
        flow_id = flows[0]["id"]
        print(f"flow «{FLOW_NAME}»: уже есть")
    else:
        flow_id = call(
            "POST",
            "/flows",
            {
                "name": FLOW_NAME,
                "icon": "sync",
                "description": "Сайт пересобирается сам через минуту после сохранения",
                "status": "active",
                "trigger": "event",
                "accountability": "all",
                "options": FLOW_OPTIONS,
            },
        )["data"]["id"]
        print(f"flow «{FLOW_NAME}»: создан")

    operation_options = {
        "method": "POST",
        "url": REBUILD_URL,
        "headers": [{"header": "X-Rebuild-Token", "value": ENV["REBUILD_TOKEN"]}],
    }
    ops = call(
        "GET",
        f"/operations?filter[flow][_eq]={flow_id}&filter[key][_eq]={OPERATION_KEY}&fields=id",
    )["data"]
    if ops:
        op_id = ops[0]["id"]
        call("PATCH", f"/operations/{op_id}", {"options": operation_options})
        print("шаг запроса: обновлён")
    else:
        op_id = call(
            "POST",
            "/operations",
            {
                "flow": flow_id,
                "key": OPERATION_KEY,
                "name": "Запрос на пересборку",
                "type": "request",
                "position_x": 19,
                "position_y": 1,
                "options": operation_options,
            },
        )["data"]["id"]
        print("шаг запроса: создан")

    call("PATCH", f"/flows/{flow_id}", {"operation": op_id, "options": FLOW_OPTIONS})
    print("готово")


if __name__ == "__main__":
    main()
