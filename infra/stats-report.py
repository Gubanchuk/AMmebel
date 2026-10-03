#!/usr/bin/env python3
"""Report on the cookie-free page statistics (frontend/src/scripts/stats.js).

Reads the nginx stats log (format `stats` in nginx/00-logging.conf), keeps the
last signal of every page view (they are cumulative) and prints totals, the
block funnel, form activity and one line per view.

    python3 /opt/am-site/infra/stats-report.py                  # ad clicks, all time
    python3 /opt/am-site/infra/stats-report.py --since 2026-10-03
    python3 /opt/am-site/infra/stats-report.py --all            # every view, not only ad clicks

Ad click = the landing address had yclid (y=1). Views from automated browsers
(navigator.webdriver, wd=1) are dropped.
"""
import argparse
import collections
import statistics
from datetime import datetime, timedelta
from urllib.parse import parse_qs

LOG = '/opt/am-site/stats/stats.log'
BLOCKS = [('h', 'первый экран'), ('c', 'условия'), ('m', 'модели'), ('n', 'задачи'),
          ('r', 'производство'), ('f', 'форма'), ('z', 'подвал')]
COOKIE = {'a': 'разрешил', 'd': 'отклонил', 's': 'видел плашку, не нажал',
          'h': 'плашку не видел', 'py': 'разрешил раньше', 'pn': 'отклонил раньше'}
DEVICE = {'m': 'телефон', 't': 'планшет', 'd': 'компьютер'}


def load(path, since):
    views = {}
    with open(path, encoding='utf-8', errors='replace') as log:
        for line in log:
            parts = line.rstrip('\n').split(' ', 2)
            if len(parts) < 3 or parts[1] != '200':
                continue
            minute, _, args = parts
            if since and minute < since:
                continue
            q = {k: v[0] for k, v in parse_qs(args).items()}
            view_id = q.get('id')
            if not view_id or q.get('v') != '1':
                continue
            try:
                n = int(q.get('n', '0'))
            except ValueError:
                continue
            q['_minute'] = minute
            q['_n'] = n
            known = views.get(view_id)
            if known is None or n > known['_n']:
                q['_first'] = known['_first'] if known else minute
                views[view_id] = q
    return list(views.values())


def blocks(view):
    out = {}
    for item in filter(None, view.get('b', '').split(',')):
        try:
            code, first, seconds = item.split('.')
            out[code] = (int(first), int(seconds))
        except ValueError:
            continue
    return out


def msk(minute):
    # nginx writes container time, UTC.
    try:
        return (datetime.strptime(minute, '%Y-%m-%dT%H:%M') + timedelta(hours=3)).strftime('%d.%m %H:%M')
    except ValueError:
        return minute


def pct(part, whole):
    return f'{part} ({round(100 * part / whole)}%)' if whole else '0'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--since', help='YYYY-MM-DD, UTC')
    parser.add_argument('--all', action='store_true', help='every view, not only ad clicks')
    parser.add_argument('--log', default=LOG)
    args = parser.parse_args()

    views = [v for v in load(args.log, args.since) if v.get('wd') != '1']
    if not args.all:
        views = [v for v in views if v.get('y') == '1']
    views.sort(key=lambda v: v['_first'])
    total = len(views)
    print(f"Просмотров: {total} ({'все' if args.all else 'только клики по рекламе'}"
          f"{', с ' + args.since if args.since else ''})")
    if not total:
        return

    print('Устройства:', ', '.join(f'{DEVICE.get(k, k)} {n}' for k, n in
                                    collections.Counter(v.get('d', '?') for v in views).most_common()))
    print('Плашка cookie:', ', '.join(f'{COOKIE.get(k, k)} {n}' for k, n in
                                      collections.Counter(v.get('cb', '?') for v in views).most_common()))
    seconds = [int(v.get('t', 0)) for v in views]
    print(f'Время на странице: медиана {statistics.median(seconds):.0f} с, '
          f'меньше 10 с — {pct(sum(s < 10 for s in seconds), total)}')

    print('\nДокуда дошли (блок был на экране) и сколько на нём пробыли:')
    for code, name in BLOCKS:
        reached = [blocks(v)[code][1] for v in views if code in blocks(v)]
        dwell = f', медиана {statistics.median(reached):.0f} с' if reached else ''
        print(f'  {name:<13} {pct(len(reached), total)}{dwell}')

    touched = [v for v in views if v.get('fl')]
    attempts = [v for v in views if v.get('fa')]
    print(f"\nФорма: начали заполнять {pct(len(touched), total)}, нажали «Отправить» "
          f"{pct(len(attempts), total)}, заявка ушла {pct(sum(1 for v in views if v.get('l')), total)}")
    rejected = collections.Counter(f for v in views for f in v.get('fe', '').split(',') if f)
    if rejected:
        print('  форма не пустила из-за поля:', ', '.join(f'{k} {n}' for k, n in rejected.most_common()))
    failed = sum(1 for v in views if v.get('fx') == '1')
    if failed:
        print(f'  сервер не принял заявку: {failed}')
    goals = collections.Counter(g for v in views for g in v.get('g', '').split(',') if g)
    clicks = collections.Counter(k for v in views for k in v.get('k', '').split(',') if k)
    if goals:
        print('Цели:', ', '.join(f'{k} {n}' for k, n in goals.most_common()))
    if clicks:
        print('Клики:', ', '.join(f'{k} {n}' for k, n in clicks.most_common()))

    print('\nПо просмотрам (время МСК, объявление, фраза, устройство, секунды, прокрутка %, '
          'блоки код.первый_показ.секунды, форма, плашка):')
    for v in views:
        form = ''
        if v.get('fl'):
            form = f" форма:{v['fl']}"
            if v.get('fa'):
                form += f" отправить×{v['fa']}"
            if v.get('fe'):
                form += f" отказ:{v['fe']}"
            if v.get('l'):
                form += ' ЗАЯВКА'
        extra = ''.join(f" {k}:{v[k]}" for k in ('g', 'k') if v.get(k))
        print(f"  {msk(v['_first'])} {v.get('ux', '-')[-6:]:>6} {v.get('ut', '-')[:28]:<28} "
              f"{v.get('d', '?')} {v.get('t', '0'):>4}с {v.get('sc', '0'):>3}% {v.get('b', '-')}{form}{extra} "
              f"cb:{v.get('cb', '?')}")


if __name__ == '__main__':
    main()
