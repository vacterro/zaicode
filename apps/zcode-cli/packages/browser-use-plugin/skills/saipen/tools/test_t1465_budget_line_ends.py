"""T-1465: a context budget measures the protocol, not the checkout.

`protocol_budget` counted `st_size`. With `* text=auto`, a file a tool rewrote
carries CRLF in a Windows working tree and LF in every Linux clone, so the
same REGISTRY.json measured 30496 bytes here and 29346 on CI, and whether
`command_resolution` fit its 43008-byte budget depended on who checked it out.
The budget itself was also over on content alone (44411 LF bytes): REGISTRY.json
was indented by two spaces, whitespace every routine command resolution loads.
It is re-serialized with one-space indentation -- the same document, parsed.
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import protocol_budget  # noqa: E402

PROTOCOL = TOOLS.parent / "saipen"


class LineEndTests(unittest.TestCase):
    def test_crlf_and_lf_copies_measure_the_same(self):
        with tempfile.TemporaryDirectory(prefix="saipen-t1465-") as tmp:
            lf = Path(tmp) / "lf.md"
            crlf = Path(tmp) / "crlf.md"
            body = "".join(f"line {index}\n" for index in range(50))
            lf.write_bytes(body.encode("utf-8"))
            crlf.write_bytes(body.replace("\n", "\r\n").encode("utf-8"))
            self.assertEqual(protocol_budget._size(lf), protocol_budget._size(crlf))
            self.assertEqual(protocol_budget._size(lf), len(body.encode("utf-8")))

    def test_every_budget_holds(self):
        self.assertEqual(protocol_budget.check(PROTOCOL), [])


class RegistryTests(unittest.TestCase):
    def test_the_registry_is_one_space_indented_and_unchanged_in_meaning(self):
        text = (PROTOCOL / "REGISTRY.json").read_text(encoding="utf-8")
        data = json.loads(text)
        normalized = text.replace("\r\n", "\n")
        self.assertEqual(normalized, json.dumps(data, indent=1, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    unittest.main()
