#!/usr/bin/env python3
"""Понятная админка для контент-редактора: русские названия, подсказки, списки.

Что делает (повторный запуск безопасен, значения перезаписываются):
  - разделы и поля по-русски, подсказки говорят, где это видно на сайте;
  - прячет то, чего на сайте нет: цены моделей, приписку про прайс, раздел
    «Частые вопросы»;
  - списки по умолчанию: у моделей миниатюра фото, название и «показывать»,
    у заявок — новые сверху;
  - страница входа и интерфейс по-русски, имя проекта «Сайт АМ».

Правки найдены при съёмке инструкции для редактора 13.09.2026
(clients/sf-sofa/am-site/docs/admin-guide.md).

    python3 setup-ui.py http://172.18.0.3:8055
"""

import json
import sys
import urllib.error
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8055"
LANG = "ru-RU"

with open("/opt/am-site/infra/.env", encoding="utf-8") as f:
    ENV = dict(
        line.strip().split("=", 1)
        for line in f
        if "=" in line and not line.startswith("#")
    )

token = None

COLLECTIONS = {
    "settings": {
        "translation": "Контакты",
        "note": "Телефон, почта и адрес внизу страницы сайта",
    },
    "conditions": {
        "translation": "Условия сотрудничества",
        "singular": "Условие",
        "plural": "Условия",
        "note": "Строки таблицы «Условия сотрудничества» на сайте",
        "display_template": "{{name}}",
    },
    "models": {
        "translation": "Модели",
        "singular": "Модель",
        "plural": "Модели",
        "note": "Фото и названия в карусели наверху и в «Популярных моделях»",
        "display_template": "{{title}}",
    },
    "faq": {
        "translation": "Частые вопросы",
        "note": "Сейчас на сайте не показываются",
        "hidden": True,
    },
    "leads": {
        "translation": "Заявки",
        "singular": "Заявка",
        "plural": "Заявки",
        "note": "Заявки с сайта. Только просмотр",
        "display_template": "{{name}} · {{phone}}",
    },
}

# collection -> field -> (название, подсказка или None, дополнительные meta)
FIELDS = {
    "settings": {
        "phone": ("Телефон", "В меню на телефоне и внизу страницы", {}),
        "email": ("Почта", "Внизу страницы", {}),
        "address": ("Адрес производства", "Внизу страницы", {}),
        "price_note": ("Приписка про прайс", "На сайте сейчас не выводится", {"hidden": True}),
    },
    "conditions": {
        "name": ("Условие", "Левая колонка таблицы", {}),
        "value": ("Текст", "Правая колонка таблицы", {}),
        "sort": ("Порядок", None, {}),
    },
    "models": {
        "title": ("Название", "Подпись к фото на сайте", {}),
        "size": ("Габариты", "Показывается под названием. Можно оставить пустым", {}),
        "photo": (
            "Фото",
            "Без фото модель на сайт не попадает",
            {"display": "image", "display_options": {"circle": False}},
        ),
        "visible": ("Показывать на сайте", "Снимите галочку, чтобы скрыть модель, не удаляя её", {}),
        "price_from": ("Цена от", "На сайте цены сейчас не показываются", {"hidden": True}),
        "price_to": ("Цена до", "На сайте цены сейчас не показываются", {"hidden": True}),
        "sort": ("Порядок", None, {}),
    },
    "faq": {
        "q": ("Вопрос", None, {}),
        "a": ("Ответ", None, {}),
        "sort": ("Порядок", None, {}),
    },
    "leads": {
        "created_at": ("Когда пришла", None, {}),
        "type": ("Откуда", "Форма прайса или квиз", {}),
        "company_inn": ("Компания / ИНН", None, {}),
        "name": ("Имя", None, {}),
        "phone": ("Телефон", None, {}),
        "city": ("Город", None, {}),
        "need": ("Что нужно", "Форма: выбранный вариант. Квиз: что продаёт", {}),
        "need_extra": ("Уточнение", "Форма: уточнение текстом. Квиз: масштаб", {}),
        "source_page": ("Страница", "Адрес страницы, с которой отправлена заявка", {}),
        "utm": ("Рекламные метки", None, {}),
        "ip": ("IP-адрес", "Нужен как доказательство согласия", {}),
        "consent_version": ("Версия согласия", "Какой текст согласия действовал при отправке", {}),
        "consent_at": ("Когда дано согласие", None, {}),
        "email_status": ("Письмо менеджеру", None, {}),
    },
}

# Списки по умолчанию для всех пользователей (глобальные пресеты).
PRESETS = {
    "models": {"fields": ["photo", "title", "visible"], "sort": ["sort"]},
    "conditions": {"fields": ["name", "value"], "sort": ["sort"]},
    "leads": {"fields": ["created_at", "type", "name", "phone", "city", "need"], "sort": ["-created_at"]},
}


def call(method, path, payload=None):
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
        print(f"  ! {method} {path} -> {e.code}: {e.read().decode()[:200]}")
        raise


def main():
    global token
    token = call(
        "POST",
        "/auth/login",
        {"email": ENV["ADMIN_EMAIL"], "password": ENV["ADMIN_PASSWORD"]},
    )["data"]["access_token"]
    print("вход выполнен")

    for name, spec in COLLECTIONS.items():
        translation = {"language": LANG, "translation": spec["translation"]}
        if "singular" in spec:
            translation["singular"] = spec["singular"]
            translation["plural"] = spec["plural"]
        meta = {"translations": [translation], "note": spec["note"]}
        for key in ("display_template", "hidden"):
            if key in spec:
                meta[key] = spec[key]
        call("PATCH", f"/collections/{name}", {"meta": meta})
        print(f"раздел {name}: «{spec['translation']}»")

    for collection, fields in FIELDS.items():
        for field, (label, note, extra) in fields.items():
            meta = {"translations": [{"language": LANG, "translation": label}], **extra}
            if note is not None:
                meta["note"] = note
            call("PATCH", f"/fields/{collection}/{field}", {"meta": meta})
        print(f"  поля {collection}: {len(fields)}")

    existing = call(
        "GET",
        "/presets?limit=-1&fields=id,collection,user,role,bookmark"
        "&filter[user][_null]=true&filter[role][_null]=true&filter[bookmark][_null]=true",
    )["data"]
    by_collection = {p["collection"]: p["id"] for p in existing}
    for collection, spec in PRESETS.items():
        preset = {
            "collection": collection,
            "layout": "tabular",
            "layout_query": {"tabular": {"fields": spec["fields"], "sort": spec["sort"], "page": 1}},
        }
        if collection in by_collection:
            call("PATCH", f"/presets/{by_collection[collection]}", preset)
        else:
            call("POST", "/presets", {**preset, "user": None, "role": None, "bookmark": None})
        print(f"список {collection}: {', '.join(spec['fields'])}")

    call("PATCH", "/settings", {"project_name": "Сайт АМ", "default_language": LANG})
    print("проект: «Сайт АМ», язык по умолчанию русский")
    print("готово")


if __name__ == "__main__":
    main()
