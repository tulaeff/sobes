import sys, json
# Читает вывод `claude -p --output-format json`, достаёт .result, чистит ограждения, валидирует JSON.
raw = sys.stdin.read()
try:
    env = json.loads(raw)
except Exception:
    print(''); sys.exit()
if env.get('is_error'):
    sys.stderr.write('claude error: ' + str(env.get('result', '')) + '\n')
    print(''); sys.exit()
t = (env.get('result') or '').strip()
fence = chr(96) * 3           # ```
if t.startswith(fence):
    nl = t.find('\n')
    t = t[nl + 1:] if nl != -1 else t[3:]
    if t.rstrip().endswith(fence):
        t = t.rstrip()[:-3]
t = t.strip()
try:
    json.loads(t)
    print(t)
except Exception:
    print('')
