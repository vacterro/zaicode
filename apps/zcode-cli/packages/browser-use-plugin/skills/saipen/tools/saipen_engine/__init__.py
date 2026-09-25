"""SAIPEN engine -- the zero-dependency mechanical layer (NITRO).

One reusable stdlib implementation for STATE/BOARD/LOG parsing, project
snapshots, and (in later milestones) locking, journal, transactions and
operations. The contract is saipen/OPS.md; the milestones are in
KNOWLEDGE/NITRO.md.

The parsers here are the shared primitives validate.py and the engine both
consume -- no parser drift by construction. Characterization rule: a parser
moves into this package only when the validator result on the existing
scenario/floor corpus is byte-identical before and after the move.
"""
