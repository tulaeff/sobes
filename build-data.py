#!/usr/bin/env python3
# Собирает public/data/data.js из public/data/parts/*.json
import json, os, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
PARTS = os.path.join(ROOT, 'public', 'data', 'parts')
OUT = os.path.join(ROOT, 'public', 'data', 'data.js')

# Порядок и названия категорий (сайдбар отрисуется в этом порядке)
CATS = [
    ('php-core', 'PHP Core'),
    ('php8', 'PHP 7.4–8.4'),
    ('oop', 'ООП'),
    ('solid-patterns', 'SOLID и паттерны'),
    ('arrays-strings', 'Массивы и строки'),
    ('functions-closures', 'Функции и замыкания'),
    ('errors-exceptions', 'Ошибки и исключения'),
    ('spl-datastructures', 'SPL и структуры данных'),
    ('namespaces-psr-composer', 'Namespaces, PSR, Composer'),
    ('performance', 'Производительность'),
    ('security', 'Безопасность'),
    ('testing', 'Тестирование'),
    ('laravel', 'Laravel'),
    ('symfony-doctrine', 'Symfony / Doctrine'),
    ('http-rest', 'HTTP и REST'),
    ('web-general', 'Веб-общее'),
    ('integrations', 'Интеграции (REST/SOAP)'),
    ('sql-basics', 'SQL основы'),
    ('db-internals', 'Индексы и транзакции'),
    ('postgres-mysql', 'PostgreSQL и MySQL'),
    ('redis-caching', 'Redis и кеширование'),
    ('queues-async', 'Очереди и асинхронность'),
    ('fintech', 'Финтех / платежи'),
    ('architecture', 'Архитектура'),
    ('sysdesign', 'Проектирование систем'),
    ('observability', 'Observability'),
    ('algorithms', 'Алгоритмы'),
    ('javascript', 'JavaScript'),
    ('vue-nuxt', 'Vue / Nuxt'),
    ('git-docker-cicd', 'Git, Docker, CI/CD'),
    ('kubernetes', 'Kubernetes'),
]

categories = []
items = []
missing = []
for key, title in CATS:
    path = os.path.join(PARTS, key + '.json')
    if not os.path.exists(path):
        missing.append(key)
        continue
    with open(path, encoding='utf-8') as f:
        arr = json.load(f)
    categories.append({'key': key, 'title': title})
    for i, it in enumerate(arr, 1):
        items.append({
            'id': f'{key}-{i}',
            'cat': key,
            'catTitle': title,
            'q': it.get('q', ''),
            'a': it.get('a', ''),
            'detail': it.get('detail', ''),
            'code': it.get('code', ''),
            'tags': it.get('tags', []),
            'weight': int(it.get('weight', 50)),
        })

payload = {'categories': categories, 'items': items}
js = ('/* Автосборка из public/data/parts/*.json. Не редактировать вручную. */\n'
      'window.CHEATSHEET = ' + json.dumps(payload, ensure_ascii=False) + ';\n')
with open(OUT, 'w', encoding='utf-8') as f:
    f.write(js)

print(f'категорий: {len(categories)}, карточек: {len(items)}, размер data.js: {len(js)} байт')
if missing:
    print('НЕТ part-файлов (пропущены):', ', '.join(missing))
