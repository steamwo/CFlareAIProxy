from pathlib import Path

path = Path('.github/pr37-fix.py')
text = path.read_text(encoding='utf-8')
old = r'includes("INTO \"gateway_keys\"")'
new = r'includes("INTO \\\"gateway_keys\\\"")'
count = text.count(old)
if count != 2:
    raise RuntimeError(f'expected two gateway_keys escape sites, found {count}')
path.write_text(text.replace(old, new), encoding='utf-8')
