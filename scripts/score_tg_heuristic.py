#!/usr/bin/env python3
# Keyless-скоринг тг-вакансий для крона (без LLM, без API-ключа).
# Вход (stdin): JSON от scan_tg.php — [{source_id, chat, max_id, messages:[{msg_id, text}]}]
# Выход (stdout): {"matches":[...], "last":{source_id:max_id}} для save_results.php
# Грубая эвристика под резюме: PHP backend, Laravel/Symfony, middle..lead, удалёнка, B1.
# Хуже LLM (по тексту поста, без фетча ссылки), но ловит явные PHP-бэкенд посты.
# Понимает два формата: структурные аггрегаторы (courierus) и hh-бот ("N. Заголовок + описание").
import sys, json, re

PHP_RE     = re.compile(r'\bphp\b|laravel|symfony|\byii\b|битрикс|bitrix|phalcon', re.I)
FOREIGN_RE = re.compile(r'\bjava\b|#java|\bc#|\bc\+\+|\bgolang\b|#go\b|python|#python|\bruby\b|node\.?js|#node|\brust\b|kotlin|swift|\.net|dotnet|elixir', re.I)
NONDEV_RE  = re.compile(r'\bqa\b|тестировщ|автотест|\bui/?ux\b|дизайн|design|#artjob|аниматор|devops|\bsre\b|систем.{0,4}админ|sysadmin|аналитик|\banalyst\b|data ?scien|дата.?саент|product ?manager|проджект|маркетолог|\bhr\b|рекрут|менеджер по прода|копирайт|\bsmm\b|таргетолог', re.I)
# чисто-UI/служебные сообщения ботов — не вакансии
UI_RE      = re.compile(r'у вас есть созданн|выберите резюме|создайте новое резюме|я наш[её]л \d+|подходящие вакансии\s*$|чем я могу|^/start|перейдите в|личный кабинет|как вам вакансии|оцените', re.I)
ROLE_RE    = re.compile(r'разработ|программист|developer|engineer|инженер|\bphp\b|laravel|symfony|backend|бэкенд|бекенд|fullstack|full-?stack|фулстек|фуллстек|архитектор|тимлид|team ?lead|\blead\b|\bcto\b', re.I)
MGMT_RE    = re.compile(r'\bcto\b|тимлид|team ?lead|руковод|head of|техдир|технический директор|co-?founder|сооснователь', re.I)
FRONT_RE   = re.compile(r'typescript|\breact\b|next\.?js|angular|\bvue\b|frontend|фронтенд|верстальщик', re.I)
TITLE_PHP_RE = re.compile(r'php|laravel|symfony|битрикс|bitrix|\byii\b|phalcon', re.I)
REMOTE_RE  = re.compile(r'remote|удал[её]н|удаленк|из любой точки|#remote', re.I)
RELOC_RE   = re.compile(r'релокейт|relocation|переезд|sponsored', re.I)
ENG_HIGH_RE= re.compile(r'\bc1\b|\bc2\b|\bb2\b|advanced|fluent|upper.?intermediate|свободн.{0,12}англ|разговорн.{0,12}англ', re.I)
FINTECH_RE = re.compile(r'финтех|fintech|платеж|платёж|\bбанк|биллинг|billing|highload|высоконагруж', re.I)
LINK_RE    = re.compile(r'https?://\S+')
PREAMBLE_RE= re.compile(r'напишите мне (её|ее) номер|чтобы посмотреть', re.I)

def extract_title(text):
    lines = [l.strip() for l in text.strip().splitlines() if l.strip()]
    # выкинуть преамбулу hh-бота и строки-эмодзи/служебное
    lines = [l for l in lines if not PREAMBLE_RE.search(l) and not l.startswith('👁')]
    if not lines:
        return ''
    first = re.sub(r'^\s*\d+\.\s*', '', lines[0])        # "11. Middle ..." -> "Middle ..."
    first = re.sub(r'^[^\wА-Яа-я]+', '', first)           # ведущие эмодзи/значки
    return re.split(r'\s[|—]\s|\s-\s', first)[0].strip()[:120]

def score_msg(text):
    if UI_RE.search(text):
        return None
    if not PHP_RE.search(text):          # PHP упомянут где-либо в посте
        return None
    title = extract_title(text)
    if not title or not ROLE_RE.search(title):
        return None                      # заголовок не похож на вакансию (UI-мусор)
    # тип роли определяем по ЗАГОЛОВКУ (в теле php может быть просто в перечислении стека)
    title_php = bool(TITLE_PHP_RE.search(title))
    if NONDEV_RE.search(title):
        return None                      # QA/дизайн/девопс/аналитик и т.п. в роли
    if FRONT_RE.search(title) and not title_php:
        return None                      # фронтенд-роль (TS/React/Vue), PHP не основной
    mism = []
    sc = 82
    if FOREIGN_RE.search(title):
        if not title_php:
            return None                  # основной язык в заголовке чужой (Java/Go/…), PHP нет
        sc -= 12; mism.append('часть стека чужая (не только PHP)')
    if MGMT_RE.search(title):
        mism.append('управленческий/не-чисто-dev уклон (CTO/тимлид)')
    if ENG_HIGH_RE.search(text):
        sc -= 14; mism.append('требуемый английский, похоже, выше B1')
    if RELOC_RE.search(text) and not REMOTE_RE.search(text):
        sc -= 25; mism.append('возможен переезд/офис, удалёнка не указана')
    if not REMOTE_RE.search(text):
        sc -= 8; mism.append('удалёнка в посте явно не указана')
    if FINTECH_RE.search(text):
        sc += 4
    sc = max(0, min(95, sc))
    if sc <= 70:
        return None
    link_m = LINK_RE.search(text)
    reason = 'PHP' + ('/Laravel' if re.search(r'laravel', text, re.I) else ('/Symfony' if re.search(r'symfony', text, re.I) else '')) \
             + (' + удалёнка' if REMOTE_RE.search(text) else '') + ' (грубый скоринг по посту)'
    return {'score': sc, 'title': title, 'reason': reason,
            'link': link_m.group(0) if link_m else '', 'mismatches': mism}

def main():
    data = json.load(sys.stdin) if not sys.stdin.isatty() else []
    matches, last = [], {}
    for chat in data:
        sid = int(chat['source_id'])
        last[str(sid)] = int(chat.get('max_id', 0))
        for m in chat.get('messages', []):
            r = score_msg(m.get('text', ''))
            if not r:
                continue
            matches.append({
                'source_id': sid, 'chat': chat.get('chat', ''), 'msg_id': int(m['msg_id']),
                'score': r['score'], 'title': r['title'], 'reason': r['reason'],
                'link': r['link'], 'text': m.get('text', ''), 'link_text': '',
                'mismatches': r['mismatches'],
            })
    print(json.dumps({'matches': matches, 'last': last}, ensure_ascii=False))

if __name__ == '__main__':
    main()
