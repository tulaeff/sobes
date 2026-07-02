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
