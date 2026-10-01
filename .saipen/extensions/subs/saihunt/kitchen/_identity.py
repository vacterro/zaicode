import sys
from pathlib import Path

sys.path.insert(0, "V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_SAIPEN")

from tools.freshness import compute_source_identity

for root in sys.argv[1:]:
    identity = compute_source_identity(Path(root))
    print(root)
    print("  source_head:", identity.source_head)
    print("  fingerprint:", identity.source_tree_fingerprint)