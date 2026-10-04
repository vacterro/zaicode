import re
import sys

src = open('tools/validate.py', encoding='utf-8').read()
ids = re.findall(r'cross-doc drift \[([a-z0-9-]+)\]', src)
seen = []
for i in ids:
    if i not in seen:
        seen.append(i)
sys.stdout.write(str(len(seen)) + " distinct drift rules:\n")
for i in seen:
    sys.stdout.write("   " + i + "\n")