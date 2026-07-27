from pathlib import Path

path = Path('.github/pr37-fix.py')
text = path.read_text(encoding='utf-8')

quote_old = r'includes("INTO \"gateway_keys\"")'
quote_new = r'includes("INTO \\\"gateway_keys\\\"")'
quote_count = text.count(quote_old)
if quote_count != 2:
    raise RuntimeError(f'expected two gateway_keys escape sites, found {quote_count}')
text = text.replace(quote_old, quote_new)

crlf_old = r'\r\n\r\n'
crlf_new = r'\\r\\n\\r\\n'
crlf_count = text.count(crlf_old)
if crlf_count != 2:
    raise RuntimeError(f'expected two CRLF escape sites, found {crlf_count}')
text = text.replace(crlf_old, crlf_new)

path.write_text(text, encoding='utf-8')
