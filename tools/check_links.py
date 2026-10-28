"""Проверка относительных ссылок и картинок в Markdown: файл, на который ссылаемся, существует.
Внешние ссылки не проверяются, якоря — тоже: GitHub строит их по своим правилам.
Запуск из корня репозитория: python3 tools/check_links.py"""
import pathlib, re, sys

root = pathlib.Path(__file__).resolve().parent.parent
link = re.compile(r'!?\[[^\]]*\]\(([^)\s]+)\)')
bad = []
for md in root.rglob('*.md'):
    if 'node_modules' in md.parts:
        continue
    text = md.read_text(encoding='utf-8')
    text = re.sub(r'```.*?```', '', text, flags=re.S)       # ссылки в коде не проверяем
    for target in link.findall(text):
        if re.match(r'^[a-z]+:', target) or target.startswith('#'):
            continue
        path = target.split('#')[0]
        if not (md.parent / path).exists():
            bad.append(f'{md.relative_to(root)}: {target}')
for b in bad:
    print('✗', b)
print(f'{"✗" if bad else "✓"} битых ссылок: {len(bad)}')
sys.exit(1 if bad else 0)
