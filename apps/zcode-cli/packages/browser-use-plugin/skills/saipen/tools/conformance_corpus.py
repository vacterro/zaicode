#!/usr/bin/env python
"""Validate or regenerate the compact human conformance index."""

from __future__ import annotations

import argparse

from saipen_engine.corpus import check_generated, write_generated


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.write:
        write_generated()
    errors = check_generated()
    if errors:
        for error in errors:
            print(f"FAIL: {error}")
        return 1
    print("CONFORMANCE CORPUS PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
