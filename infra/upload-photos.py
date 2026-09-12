#!/usr/bin/env python3
"""Загружает фото моделей в Directus и привязывает их к карточкам.

Сопоставление идёт по полю sort: оно уникально у каждой модели, тогда как
названия повторяются — «Модульный диван Lounge» есть и в карусели, и в
витрине. Первая версия скрипта сопоставляла по названию и поэтому выдала
двум моделям чужие фото.

Повторный запуск не плодит дубли: файл с таким именем уже в библиотеке —
берётся существующий. Привязка проставляется заново всегда, чтобы чинить
последствия неверного сопоставления.

    python3 upload-photos.py http://172.18.0.3:8055 /opt/am-site/photos
"""

import json
import mimetypes
import os
import sys
import urllib.error
import urllib.request
import uuid

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8055"
PHOTO_DIR = sys.argv[2] if len(sys.argv) > 2 else "/opt/am-site/photos"
FALLBACK = "/opt/am-site/infra/content-fallback.json"

with open("/opt/am-site/infra/.env", encoding="utf-8") as f:
    ENV = dict(
        line.strip().split("=", 1)
        for line in f
        if "=" in line and not line.startswith("#")
    )

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
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read().decode()
        return json.loads(body) if body else {}


def upload(path, title):
    """Отправляет файл multipart-запросом и возвращает его id в Directus."""
    name = os.path.basename(path)
    ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
    boundary = uuid.uuid4().hex
    with open(path, "rb") as f:
        content = f.read()

    parts = []
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n'
        f"{title}\r\n".encode()
    )
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; '
        f'filename="{name}"\r\nContent-Type: {ctype}\r\n\r\n'.encode()
    )
    parts.append(content)
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    body = b"".join(parts)

    req = urllib.request.Request(f"{BASE}/files", data=body, method="POST")
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode())["data"]["id"]


def main():
    global token
    token = call(
        "POST",
        "/auth/login",
        {"email": ENV["ADMIN_EMAIL"], "password": ENV["ADMIN_PASSWORD"]},
    )["data"]["access_token"]
    print("вход выполнен")

    with open(FALLBACK, encoding="utf-8") as f:
        wanted = {
            m["sort"]: os.path.basename(m["photo"])
            for m in json.load(f)["models"]
            if m.get("photo")
        }

    existing_files = {
        f["filename_download"]: f["id"]
        for f in call("GET", "/files?limit=-1&fields=id,filename_download")["data"]
    }
    models = call("GET", "/items/models?limit=-1&fields=id,title,sort,photo")["data"]

    linked = already = 0
    for m in models:
        filename = wanted.get(m["sort"])
        if not filename:
            print(f"  ? модель «{m['title']}» (порядок {m['sort']}) — фото не задано")
            continue

        file_id = existing_files.get(filename)
        if not file_id:
            local = os.path.join(PHOTO_DIR, filename)
            if not os.path.exists(local):
                print(f"  ! файла нет на диске: {filename}")
                continue
            file_id = upload(local, m["title"])
            existing_files[filename] = file_id
            print(f"  загружен {filename}")

        if m.get("photo") == file_id:
            already += 1
            continue
        call("PATCH", f"/items/models/{m['id']}", {"photo": file_id})
        print(f"  привязано: [{m['sort']}] {m['title']} <- {filename}")
        linked += 1

    print(f"\nпривязано заново {linked}, уже было верно {already}")


if __name__ == "__main__":
    main()
