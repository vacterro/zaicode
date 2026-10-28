"""Declared core-unit family: SHIP evidence and baseline (T-1344).

    python tools/core_unit.py evidence T-###   # run the family, cite it in LOG
    python tools/core_unit.py baseline         # record the family's red set

The logic lives in ``saipen_engine/core_unit.py``; this is its entry point.
"""

import sys

from saipen_engine.core_unit import main

if __name__ == "__main__":
    sys.exit(main())
