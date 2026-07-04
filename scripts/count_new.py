import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    d = []
print(sum(len(c.get('messages', [])) for c in d))
