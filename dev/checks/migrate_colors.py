"""Rename `X-[color:var(--name)]` Tailwind classes to named theme colours.

Tailwind 3 emits no rule for `X-[color:var(--name)]/NN`, so tints written that
way never rendered. tailwind.config.js defines the same palette as real colours
with alpha support; this rewrites every usage to them.

usage: migrate_colors.py <src dir> [--write]
"""
import pathlib
import re
import sys

NAMES = {
    'ink-text': 'ink', 'muted': 'muted', 'line': 'line', 'surface': 'surface',
    'surface-2': 'surface-2', 'accent': 'accent', 'accent-soft': 'accent-soft',
    'success': 'success', 'danger': 'danger', 'danger-soft': 'danger-soft', 'mic': 'mic',
}
PAT = re.compile(r'\[color:var\(--(' + '|'.join(sorted(NAMES, key=len, reverse=True)) + r')\)\]')

root = pathlib.Path(sys.argv[1])
write = '--write' in sys.argv
total = 0
for path in sorted(root.rglob('*')):
    if path.suffix not in ('.jsx', '.js', '.css') or not path.is_file():
        continue
    text = path.read_text()
    new, n = PAT.subn(lambda m: NAMES[m.group(1)], text)
    if n:
        total += n
        print(f'{n:4d}  {path}')
        if write:
            path.write_text(new)
left = sum(len(re.findall(r'\[color:var\(', p.read_text())) for p in root.rglob('*') if p.suffix in ('.jsx', '.js', '.css') and p.is_file()) if write else None
print(f'total {total} replacements' + (f', {left} unmatched [color:var( left' if write else ' (dry run)'))
