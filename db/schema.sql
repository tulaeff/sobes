-- Схема БД шпаргалки

CREATE TABLE IF NOT EXISTS categories (
    key        TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    sort_order INT  NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS questions (
    id           SERIAL PRIMARY KEY,
    category_key TEXT NOT NULL REFERENCES categories(key) ON DELETE CASCADE,
    q            TEXT NOT NULL DEFAULT '',
    a            TEXT NOT NULL DEFAULT '',
    detail       TEXT NOT NULL DEFAULT '',
    code         TEXT NOT NULL DEFAULT '',
    tags         JSONB NOT NULL DEFAULT '[]',
    weight       INT  NOT NULL DEFAULT 50,
    pinned       BOOLEAN NOT NULL DEFAULT false,
    edited       BOOLEAN NOT NULL DEFAULT false,
    orig         JSONB,                    -- снимок исходника для "вернуть оригинал"
    sort_order   INT NOT NULL DEFAULT 0,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_questions_cat ON questions(category_key);

-- личные заготовки (о себе / задача) и прочие настройки
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value JSONB NOT NULL
);

-- источники для мониторинга вакансий: тг-чаты (файл выгрузки) и аккаунты/сайты (url)
CREATE TABLE IF NOT EXISTS sources (
    id          SERIAL PRIMARY KEY,
    kind        TEXT NOT NULL,            -- 'tg' | 'account'
    title       TEXT NOT NULL DEFAULT '',
    value       TEXT NOT NULL DEFAULT '', -- имя файла выгрузки (tg) или URL (account)
    login       TEXT NOT NULL DEFAULT '', -- для account
    password    TEXT NOT NULL DEFAULT '', -- для account (локально, plaintext)
    enabled     BOOLEAN NOT NULL DEFAULT true,
    auto_apply  BOOLEAN NOT NULL DEFAULT false, -- авто-отклик без подтверждения на релевантные вакансии из этого источника
    last_msg_id BIGINT NOT NULL DEFAULT 0, -- id последнего проанализированного сообщения (tg)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (kind, value)                  -- один источник = один файл/URL, без дублей
);

-- найденные релевантные вакансии (матч с резюме > 70%)
CREATE TABLE IF NOT EXISTS vacancies (
    id         SERIAL PRIMARY KEY,
    source_id  INT REFERENCES sources(id) ON DELETE CASCADE,
    chat       TEXT NOT NULL DEFAULT '',  -- название чата
    msg_id     BIGINT NOT NULL,
    score      INT NOT NULL DEFAULT 0,    -- 0-100, насколько подходит под резюме
    title      TEXT NOT NULL DEFAULT '',  -- короткое название вакансии
    reason     TEXT NOT NULL DEFAULT '',  -- почему подходит (1-2 строки)
    link       TEXT NOT NULL DEFAULT '',  -- ссылка/контакт из сообщения
    text       TEXT NOT NULL DEFAULT '',  -- оригинальный текст поста
    link_text  TEXT NOT NULL DEFAULT '',  -- содержимое страницы по ссылке (полное описание вакансии)
    mismatches JSONB NOT NULL DEFAULT '[]', -- главные несоответствия резюме (массив строк)
    -- автоотклик
    apply_status TEXT NOT NULL DEFAULT 'new', -- new | queued (черновик готов, ждёт одобрения) | approved (одобрен, ждёт отправки) | applied | direct (нашли прямые контакты, пишем в обход площадки) | done (работа по вакансии закончена) | needs_manual | skipped (юзер отказался навсегда, скрыта из UI)
    applied_at   TIMESTAMPTZ,               -- когда откликнулись
    cover_letter TEXT NOT NULL DEFAULT '',   -- черновик сопроводительного
    apply_note   TEXT NOT NULL DEFAULT '',   -- заметка (причина ручной формы / детали отклика)
    company      TEXT NOT NULL DEFAULT '',   -- название компании-работодателя
    company_url  TEXT NOT NULL DEFAULT '',   -- найденный сайт/раздел вакансий компании (вне источника)
    hr_contacts  JSONB NOT NULL DEFAULT '[]', -- прямые контакты нанимающей стороны: [{kind: email|tg|linkedin|phone|site, value, name, note, source}]
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source_id, msg_id)            -- одно сообщение = одна вакансия
);
CREATE INDEX IF NOT EXISTS idx_vacancies_score ON vacancies(score DESC);

-- записи встреч: видео вкладки + смешанный звук (микрофон + собеседники).
-- Сам файл лежит на диске (./recordings), в БД только метаданные и текст.
CREATE TABLE IF NOT EXISTS recordings (
    id          SERIAL PRIMARY KEY,
    title       TEXT NOT NULL DEFAULT '',
    file        TEXT NOT NULL DEFAULT '',            -- имя файла в /var/www/recordings
    mime        TEXT NOT NULL DEFAULT 'video/webm',
    status      TEXT NOT NULL DEFAULT 'recording',   -- recording | done | failed
    size_bytes  BIGINT NOT NULL DEFAULT 0,
    duration_ms BIGINT NOT NULL DEFAULT 0,
    chunks      INT NOT NULL DEFAULT 0,              -- сколько кусков дописано (по нему ловим повтор после ретрая)
    transcript_kind TEXT NOT NULL DEFAULT 'live',    -- live (браузерное распознавание) | whisper (точная расшифровка)
    whisper_status  TEXT NOT NULL DEFAULT '',        -- '' | queued | running | done | failed
    whisper_note    TEXT NOT NULL DEFAULT '',        -- что пошло не так / сколько заняло
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_recordings_started ON recordings(started_at DESC);

-- расшифровка речи: реплика = строка, t_ms — смещение от старта записи (по нему перемотка плеера)
CREATE TABLE IF NOT EXISTS recording_lines (
    id           BIGSERIAL PRIMARY KEY,
    recording_id INT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    t_ms         BIGINT NOT NULL DEFAULT 0,
    text         TEXT NOT NULL DEFAULT '',
    speaker      TEXT NOT NULL DEFAULT ''            -- me | them | '' (когда говорящего не различали)
);
CREATE INDEX IF NOT EXISTS idx_recording_lines ON recording_lines(recording_id, t_ms);

-- лог работы агента (что делал автопрогон: запуск, скан, отклики, ошибки)
CREATE TABLE IF NOT EXISTS agent_log (
    id         SERIAL PRIMARY KEY,
    kind       TEXT NOT NULL DEFAULT '',   -- тип события: run | scan | apply | error ...
    message    TEXT NOT NULL DEFAULT '',   -- строка лога
    meta       JSONB NOT NULL DEFAULT '{}',-- доп. данные (счётчики, id вакансий и т.п.)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_log_created ON agent_log(created_at DESC);
