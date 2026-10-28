"""The stable operation result shape (OPS.md section 7).

Every operation — read-only or mutating — returns one of these. The CLI prints
terse human text by default and exact JSON under `--json`, so no program ever
has to scrape "Looks good, ticket seems claimed!" out of prose.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from .errors import CODES


@dataclass
class Result:
    """One operation outcome.

    `code` is a stable identifier on both paths: a success code the caller can
    branch on (`CLAIMED`, `STATUS`, `NEXT`) or, when `ok` is False, one of
    OPS.md's refusal codes.
    """

    ok: bool
    code: str
    data: dict[str, Any] = field(default_factory=dict)
    message: str = ""
    changed_files: list[str] = field(default_factory=list)
    op_id: str | None = None
    recovery_required: bool = False

    def __post_init__(self) -> None:
        if not self.ok and self.code not in CODES:
            # T-1437: an unregistered refusal code is a REGISTRY defect, not a
            # traceback and not a silent generic failure. The refusal keeps its
            # original code and is explicitly MARKED; the developer-facing
            # completeness contract (tools/test_refusal_registry.py) is what
            # fails loudly when the registry falls behind production.
            self.data["unregistered_code"] = True
            self.data.setdefault("detail", "refusal code missing from REGISTRY.json error_codes")

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "ok": self.ok,
            "code": self.code,
            "op_id": self.op_id,
            "changed_files": list(self.changed_files),
            "recovery_required": self.recovery_required,
        }
        if self.message:
            out["message"] = self.message
        out.update(self.data)
        return out

    def get(self, key: str, default: Any = None) -> Any:
        return self.to_dict().get(key, default)

    def __getitem__(self, key: str) -> Any:
        return self.to_dict()[key]

    def __contains__(self, key: str) -> bool:
        return key in self.to_dict()

    def __bool__(self) -> bool:
        return self.ok

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2, sort_keys=False, ensure_ascii=False)

    @classmethod
    def refuse(cls, code: str, message: str, next_action: str | None = None) -> "Result":
        data = {"next_action_hint": next_action} if next_action else {}
        return cls(ok=False, code=code, message=message, data=data)
