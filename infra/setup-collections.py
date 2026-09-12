#!/usr/bin/env python3
"""Создаёт коллекции Directus для опт-сайта АМ.

Запускается на сервере, где Directus доступен по внутреннему адресу.
Повторный запуск безопасен: уже существующие коллекции и поля пропускаются.

    python3 setup-collections.py http://172.18.0.3:8055
"""

import json
import sys
import urllib.error
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8055"

with open("/opt/am-site/infra/.env", encoding="utf-8") as f:
    ENV = dict(
        line.strip().split("=", 1)
        for line in f
        if "=" in line and not line.startswith("#")
    )

token = None


def call(method, path, payload=None, quiet=False):
    url = f"{BASE}{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read().decode()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode()
        if not quiet:
            print(f"  ! {method} {path} -> {e.code}: {detail[:200]}")
        raise


def login():
    global token
    r = call(
        "POST",
        "/auth/login",
        {"email": ENV["ADMIN_EMAIL"], "password": ENV["ADMIN_PASSWORD"]},
    )
    token = r["data"]["access_token"]
    print("вход выполнен")


def collection_exists(name):
    try:
        call("GET", f"/collections/{name}", quiet=True)
        return True
    except urllib.error.HTTPError:
        return False


def make_collection(name, note, icon, singleton=False, hidden=False, sortable=True):
    if collection_exists(name):
        print(f"коллекция {name}: уже есть")
        return
    call(
        "POST",
        "/collections",
        {
            "collection": name,
            "schema": {},
            "meta": {
                "note": note,
                "icon": icon,
                "singleton": singleton,
                "hidden": hidden,
                "sort_field": "sort" if sortable and not singleton else None,
            },
        },
    )
    print(f"коллекция {name}: создана")


def make_field(collection, field, ftype, note="", **kw):
    try:
        call("GET", f"/fields/{collection}/{field}", quiet=True)
        return
    except urllib.error.HTTPError:
        pass
    meta = {"note": note}
    meta.update(kw.pop("meta", {}))
    schema = kw.pop("schema", {})
    call(
        "POST",
        f"/fields/{collection}",
        {"field": field, "type": ftype, "meta": meta, "schema": schema},
    )
    print(f"  поле {collection}.{field} ({ftype})")


def text_field(collection, field, note, required=False, multiline=False):
    make_field(
        collection,
        field,
        "text" if multiline else "string",
        note,
        meta={
            "interface": "input-multiline" if multiline else "input",
            "required": required,
            "width": "full" if multiline else "half",
        },
        schema={"is_nullable": not required},
    )


def sort_field(collection):
    make_field(
        collection,
        "sort",
        "integer",
        "Порядок вывода на сайте: меньше — выше",
        meta={"interface": "input", "hidden": True},
        schema={"is_nullable": True},
    )


def main():
    login()

    # --- настройки сайта: телефон, почта, адрес ---
    make_collection(
        "settings", "Контакты и общие надписи сайта", "settings", singleton=True
    )
    text_field("settings", "phone", "Телефон в шапке и футере", required=True)
    text_field("settings", "email", "Почта для заявок", required=True)
    text_field("settings", "address", "Адрес производства", required=True)
    text_field(
        "settings", "price_note", "Приписка про прайс рядом с формой", multiline=True
    )

    # --- условия работы ---
    make_collection("conditions", "Условия работы: строки таблицы", "table_rows")
    text_field("conditions", "name", "Название условия", required=True)
    text_field("conditions", "value", "Значение", required=True, multiline=True)
    sort_field("conditions")

    # --- модели ---
    make_collection("models", "Модели в витрине «Популярные модели»", "weekend")
    text_field("models", "title", "Название модели", required=True)
    text_field("models", "size", "Габариты, как показывать на карточке")
    make_field(
        "models",
        "price_from",
        "integer",
        "Цена «от», рублей. Пусто — цена не показывается",
        meta={"interface": "input", "width": "half"},
        schema={"is_nullable": True},
    )
    make_field(
        "models",
        "price_to",
        "integer",
        "Цена «до», рублей. Пусто — показывается только «от»",
        meta={"interface": "input", "width": "half"},
        schema={"is_nullable": True},
    )
    make_field(
        "models",
        "visible",
        "boolean",
        "Показывать на сайте",
        meta={"interface": "boolean", "width": "half"},
        schema={"default_value": True, "is_nullable": False},
    )
    sort_field("models")

    # --- вопросы и ответы ---
    make_collection("faq", "Частые вопросы", "help")
    text_field("faq", "q", "Вопрос", required=True)
    text_field("faq", "a", "Ответ", required=True, multiline=True)
    sort_field("faq")

    # --- заявки: сюда пишет lead-service, руками не заполняется ---
    make_collection("leads", "Заявки с сайта. Только чтение", "inbox", sortable=False)
    # У заявок нет поля sort. Первая версия скрипта всё равно прописала его
    # как поле сортировки, и Directus отвечал 403 на любой список заявок —
    # даже администратору. Сброс чинит уже созданную коллекцию.
    call("PATCH", "/collections/leads", {"meta": {"sort_field": None}})
    make_field(
        "leads",
        "created_at",
        "timestamp",
        "Когда пришла заявка",
        meta={"interface": "datetime", "readonly": True, "width": "half"},
        schema={"is_nullable": True},
    )
    make_field(
        "leads",
        "type",
        "string",
        "Откуда пришла: quiz — из квиза, price — из формы прайса",
        meta={
            "interface": "select-dropdown",
            "options": {"choices": [{"text": "Квиз", "value": "quiz"},
                                     {"text": "Форма прайса", "value": "price"}]},
            "readonly": True,
            "width": "half",
        },
        schema={"is_nullable": True},
    )
    for f, note in [
        ("company_inn", "ИНН компании"),
        ("name", "Имя закупщика"),
        ("phone", "Телефон"),
        ("city", "Город"),
        ("need", "Что нужно: выбранный вариант"),
        ("need_extra", "Что нужно: уточнение текстом"),
        ("source_page", "Страница, с которой отправлена заявка"),
    ]:
        make_field(
            "leads",
            f,
            "string",
            note,
            meta={"interface": "input", "readonly": True, "width": "half"},
            schema={"is_nullable": True},
        )
    make_field(
        "leads",
        "utm",
        "json",
        "Метки рекламной кампании",
        meta={"interface": "input-code", "readonly": True},
        schema={"is_nullable": True},
    )
    make_field(
        "leads",
        "ip",
        "string",
        "Адрес отправителя. Нужен как доказательство согласия",
        meta={"interface": "input", "readonly": True, "width": "half"},
        schema={"is_nullable": True},
    )
    make_field(
        "leads",
        "consent_version",
        "string",
        "Версия текста согласия, действовавшая в момент отправки",
        meta={"interface": "input", "readonly": True, "width": "half"},
        schema={"is_nullable": True},
    )
    make_field(
        "leads",
        "consent_at",
        "timestamp",
        "Когда отмечено согласие",
        meta={"interface": "datetime", "readonly": True, "width": "half"},
        schema={"is_nullable": True},
    )
    make_field(
        "leads",
        "email_status",
        "string",
        "Состояние письма менеджеру",
        meta={
            "interface": "select-dropdown",
            "options": {"choices": [{"text": "Отправлено", "value": "sent"},
                                     {"text": "В очереди", "value": "queued"},
                                     {"text": "Ошибка", "value": "failed"}]},
            "readonly": True,
            "width": "half",
        },
        schema={"is_nullable": True},
    )

    print("\nготово")


if __name__ == "__main__":
    main()
