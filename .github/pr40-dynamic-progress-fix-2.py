from pathlib import Path

path = Path(".github/pr40-dynamic-progress-fix.py")
text = path.read_text(encoding="utf-8")
old = '''    const [payload, signature] = String(first.nextCursor).split(".");
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as {
'''
new = '''    const [payload, signature] = String(first.nextCursor).split(".");
    if (!payload || !signature) throw new Error("cursor envelope missing");
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as {
'''
if text.count(old) != 1:
    raise RuntimeError(f"expected one test cursor match, found {text.count(old)}")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
