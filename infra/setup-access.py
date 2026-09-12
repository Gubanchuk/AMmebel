#!/usr/bin/env python3
"""Роли, права и наполнение контентом для Directus (опт-сайт АМ).

Создаёт:
  - поле photo у моделей (картинка из библиотеки файлов);
  - роль «Контент-редактор» для клиента: правит контент, заявки только читает,
    в настройки Directus не попадает;
  - служебную роль «Сборка сайта» со статическим токеном: читает контент,
    больше ничего;
  - наполняет коллекции из content-fallback.json, если они пустые.

Повторный запуск безопасен. Запуск:
    python3 setup-access.py http://172.18.0.3:8055
"""

import json
import sys
import urllib.error
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8055"
FALLBACK = "/opt/am-site/infra/content-fallback.json"

with open("/opt/am-site/infra/.env", encoding="utf-8") as f:
    ENV = dict(
        line.strip().split("=", 1)
        for line in f
        if "=" in line and not line.startswith("#")
    )

token = None

CONTENT = ["settings", "conditions", "models", "faq"]


def call(method, path, payload=None, quiet=False):
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps(payload).encode() if payload is not None else None,
        method=method,
    )
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read().decode()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        if not quiet:
            print(f"  ! {method} {path} -> {e.code}: {e.read().decode()[:200]}")
        raise


def login():
    global token
    token = call(
        "POST",
        "/auth/login",
        {"email": ENV["ADMIN_EMAIL"], "password": ENV["ADMIN_PASSWORD"]},
    )["data"]["access_token"]
    print("вход выполнен")


def photo_field():
    try:
        call("GET", "/fields/models/photo", quiet=True)
        print("поле models.photo: уже есть")
        return
    except urllib.error.HTTPError:
        pass
    call(
        "POST",
        "/fields/models",
        {
            "field": "photo",
            "type": "uuid",
            "meta": {
                "interface": "file-image",
                "special": ["file"],
                "note": "Фото модели. Загружается прямо здесь",
                "width": "full",
            },
            "schema": {"is_nullable": True},
        },
    )
    call(
        "POST",
        "/relations",
        {
            "collection": "models",
            "field": "photo",
            "related_collection": "directus_files",
        },
    )
    print("поле models.photo: создано")


def find_by_name(path, name):
    for item in call("GET", f"{path}?limit=-1")["data"]:
        if item.get("name") == name:
            return item
    return None


def make_policy(name, app_access, icon):
    found = find_by_name("/policies", name)
    if found:
        print(f"политика «{name}»: уже есть")
        return found["id"]
    p = call(
        "POST",
        "/policies",
        {
            "name": name,
            "icon": icon,
            "admin_access": False,
            "app_access": app_access,
            "enforce_tfa": False,
        },
    )["data"]
    print(f"политика «{name}»: создана")
    return p["id"]


def make_role(name, policy_id, description):
    found = find_by_name("/roles", name)
    if found:
        role_id = found["id"]
        print(f"роль «{name}»: уже есть")
    else:
        role_id = call(
            "POST", "/roles", {"name": name, "description": description}
        )["data"]["id"]
        print(f"роль «{name}»: создана")
    links = call("GET", "/access?limit=-1")["data"]
    if not any(a.get("role") == role_id and a.get("policy") == policy_id for a in links):
        call("POST", "/access", {"role": role_id, "policy": policy_id})
        print(f"  политика привязана к роли «{name}»")
    return role_id


def grant(policy_id, collection, actions, fields="*"):
    existing = call("GET", "/permissions?limit=-1")["data"]
    for action in actions:
        if any(
            p.get("policy") == policy_id
            and p.get("collection") == collection
            and p.get("action") == action
            for p in existing
        ):
            continue
        call(
            "POST",
            "/permissions",
            {
                "policy": policy_id,
                "collection": collection,
                "action": action,
                "fields": fields,
                "permissions": {},
                "validation": {},
            },
        )
        print(f"  право: {collection} — {action}")


def seed():
    with open(FALLBACK, encoding="utf-8") as f:
        data = json.load(f)

    s = data["settings"]
    current = call("GET", "/items/settings")["data"]
    if not current or not current.get("phone"):
        call(
            "PATCH",
            "/items/settings",
            {
                "phone": s["phone"],
                "email": s["email"],
                "address": s["address"],
                "price_note": s.get("priceNote", ""),
            },
        )
        print("настройки: заполнены")
    else:
        print("настройки: уже заполнены, не трогаю")

    for name, rows, mapper in [
        (
            "conditions",
            data["conditions"],
            lambda r, i: {"name": r["name"], "value": r["value"], "sort": r.get("sort", i)},
        ),
        (
            "models",
            data["models"],
            lambda r, i: {
                "title": r["title"],
                "size": r.get("size") or "",
                "price_from": r.get("priceFrom"),
                "price_to": r.get("priceTo"),
                "visible": r.get("visible", True),
                "sort": r.get("sort", i),
            },
        ),
        (
            "faq",
            data["faq"],
            lambda r, i: {"q": r["q"], "a": r["a"], "sort": r.get("sort", i)},
        ),
    ]:
        have = call("GET", f"/items/{name}?limit=1")["data"]
        if have:
            print(f"{name}: уже есть записи, не трогаю")
            continue
        call("POST", f"/items/{name}", [mapper(r, i) for i, r in enumerate(rows, 1)])
        print(f"{name}: залито {len(rows)} записей")


def build_token_user(role_id):
    users = call("GET", "/users?limit=-1&fields=id,email,token")["data"]
    for u in users:
        if u.get("email") == "build@am-fabrika.ru":
            print("служебный пользователь сборки: уже есть")
            return u.get("token")
    import secrets

    static = secrets.token_urlsafe(32)
    call(
        "POST",
        "/users",
        {
            "first_name": "Сборка сайта",
            "email": "build@am-fabrika.ru",
            "role": role_id,
            "token": static,
            "status": "active",
        },
    )
    print("служебный пользователь сборки: создан")
    return static


def editor_user(role_id):
    """Вход клиента в админку. Почта и пароль берутся из .env.

    Пока клиент не дал рабочую почту, учётка заведена на почту Андрея;
    сменить её можно прямо в админке, пароль при этом не сбрасывается.
    """
    email = ENV.get("EDITOR_EMAIL", "").lower()
    password = ENV.get("EDITOR_PASSWORD", "")
    if not email or not password:
        print("редактор: EDITOR_EMAIL и EDITOR_PASSWORD не заданы в .env, пропускаю")
        return
    users = call("GET", "/users?limit=-1&fields=id,email")["data"]
    if any((u.get("email") or "").lower() == email for u in users):
        print(f"редактор {email}: уже есть")
        return
    call(
        "POST",
        "/users",
        {
            "first_name": "Контент-редактор",
            "email": email,
            "password": password,
            "role": role_id,
            "status": "active",
            "language": "ru-RU",
        },
    )
    print(f"редактор {email}: создан")


def main():
    login()
    photo_field()

    # Клиент: правит контент, заявки только смотрит.
    editor_policy = make_policy("Контент-редактор", app_access=True, icon="edit")
    editor_role = make_role(
        "Контент-редактор",
        editor_policy,
        "Правит цены, тексты и фото. Заявки только читает",
    )
    grant(editor_policy, "settings", ["read", "update"])
    for c in ["conditions", "models", "faq"]:
        grant(editor_policy, c, ["create", "read", "update", "delete"])
    grant(editor_policy, "leads", ["read"])
    grant(editor_policy, "directus_files", ["create", "read", "update"])
    grant(editor_policy, "directus_folders", ["read"])

    # Сборка сайта: читает контент и ничего больше.
    build_policy = make_policy("Сборка сайта", app_access=False, icon="cloud_download")
    build_role = make_role(
        "Сборка сайта", build_policy, "Служебная роль для сборки фронта"
    )
    for c in CONTENT:
        grant(build_policy, c, ["read"])
    grant(build_policy, "directus_files", ["read"])

    seed()
    editor_user(editor_role)
    static = build_token_user(build_role)
    print(f"\nтокен для сборки фронта: {static}")
    print("готово")


if __name__ == "__main__":
    main()
