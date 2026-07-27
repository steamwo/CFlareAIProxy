from pathlib import Path

path = Path('.github/pr40-model-refresh-fix.py')
text = path.read_text(encoding='utf-8')

old = '''replace_once(
    "src/models.ts",
    '{ purpose: "models", timeoutMs })',
    '{ purpose: "models", timeoutMs, proxyConfig })',
)
replace_once(
    "src/models.ts",
    ': await providerFetch(env, provider, url, init, { purpose: "models", timeoutMs });',
    ': await providerFetch(env, provider, url, init, { purpose: "models", timeoutMs, proxyConfig });',
)
'''
new = '''models_text = read("src/models.ts")
old_fetch_options = '{ purpose: "models", timeoutMs })'
if models_text.count(old_fetch_options) != 2:
    raise RuntimeError(f"src/models.ts: expected two model fetch option sites, found {models_text.count(old_fetch_options)}")
write("src/models.ts", models_text.replace(old_fetch_options, '{ purpose: "models", timeoutMs, proxyConfig })'))
'''
if text.count(old) != 1:
    raise RuntimeError(f'expected one fetch replacement block, found {text.count(old)}')
text = text.replace(old, new)

old = '''replace_once(
    "src/upstream-fetch.ts",
    '  const config = await getProviderProxyConfig(env, provider.id);',
    '  const config = options.proxyConfig === undefined ? await getProviderProxyConfig(env, provider.id) : options.proxyConfig;',
)
'''
new = """replace_once(
    "src/upstream-fetch.ts",
    '''  const timeoutMs = Math.max(1000, options.timeoutMs ?? 120_000);
  const config = await getProviderProxyConfig(env, provider.id);''',
    '''  const timeoutMs = Math.max(1000, options.timeoutMs ?? 120_000);
  const config = options.proxyConfig === undefined ? await getProviderProxyConfig(env, provider.id) : options.proxyConfig;''',
)
"""
if text.count(old) != 1:
    raise RuntimeError(f'expected one upstream proxy replacement block, found {text.count(old)}')
text = text.replace(old, new)

path.write_text(text, encoding='utf-8')
