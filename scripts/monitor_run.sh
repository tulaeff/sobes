#!/bin/bash
# Один прогон авто-мониторинга вакансий (ТОЛЬКО телеграм): скан новых тг-сообщений -> скоринг -> сохранение.
# С ключом ANTHROPIC_API_KEY — качественный LLM-скоринг (headless Claude, текст->текст).
# БЕЗ ключа — грубая эвристика по тексту поста (scripts/score_tg_heuristic.py): бесплатно, работает в кроне.
# Сайты (hh/Хабр) сюда НЕ входят — им нужен живой браузер (/scan_all в сессии).

export PATH="/Users/ivangrigorov/.nvm/versions/node/v20.17.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
DIR="/Users/ivangrigorov/Работа/phpStormProjects/Citrus-media/sobes.local"
cd "$DIR" || exit 1
ts() { date '+%F %T'; }

# ключ можно положить в ~/.config/sobes/env одной строкой: ANTHROPIC_API_KEY=sk-ant-...
KEYFILE="$HOME/.config/sobes/env"
[ -z "$ANTHROPIC_API_KEY" ] && [ -f "$KEYFILE" ] && . "$KEYFILE"

NEW=$(docker compose exec -T php php /var/www/api/scan_tg.php 2>/dev/null)
CNT=$(printf '%s' "$NEW" | python3 "$DIR/scripts/count_new.py")
CNT=${CNT:-0}

if [ "$CNT" -eq 0 ]; then
  echo '{"matches":[],"last":{}}' | docker compose exec -T php php /var/www/api/save_results.php >/dev/null 2>&1
  echo "$(ts) новых сообщений нет"
  exit 0
fi

if [ -n "$ANTHROPIC_API_KEY" ]; then
  echo "$(ts) LLM-скоринг новых сообщений: $CNT"
  OUT=$(claude -p "$(cat "$DIR/scripts/monitor_prompt.txt") $NEW" --output-format json 2>&1)
  CLEAN=$(printf '%s' "$OUT" | python3 "$DIR/scripts/extract_result.py")
  if [ -z "$CLEAN" ]; then
    echo "$(ts) Claude не авторизовался/невалидный JSON — падаю на эвристику"
    CLEAN=$(printf '%s' "$NEW" | python3 "$DIR/scripts/score_tg_heuristic.py")
  fi
else
  echo "$(ts) эвристический скоринг без ключа: $CNT"
  CLEAN=$(printf '%s' "$NEW" | python3 "$DIR/scripts/score_tg_heuristic.py")
fi

if [ -n "$CLEAN" ]; then
  SAVED=$(printf '%s' "$CLEAN" | docker compose exec -T php php /var/www/api/save_results.php 2>&1)
  echo "$(ts) сохранено: $SAVED"
else
  echo "$(ts) скоринг вернул пусто"
fi
