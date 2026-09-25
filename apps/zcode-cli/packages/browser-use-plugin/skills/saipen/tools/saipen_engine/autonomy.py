"""Bounded progress detection for the legacy crew-only intent loop.

The compatibility ``autonomous_crew_loop`` lives in
:mod:`saipen_engine.intent`; canonical continue/converge and targeted producer
execution have separate CLI routes and do not enter it. This module owns only
the reusable, pure stall detector, so there is no dormant second control flow
with a different blocker taxonomy.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class IterationRecord:
    state_hash: str
    action: str
    reason: str
    result_code: str


class ProgressTracker:
    """Detect repeated or oscillating autonomous-loop observations."""

    def __init__(self, max_iterations: int = 50):
        self.max_iterations = max_iterations
        self.iterations = 0
        self.history: list[IterationRecord] = []

    def record(self, state_hash: str, action: str, reason: str, result_code: str) -> bool:
        """Record an observation; return ``False`` when progress has stalled."""
        self.iterations += 1
        self.history.append(IterationRecord(state_hash, action, reason, result_code))

        if self.iterations >= self.max_iterations:
            return False

        current = (state_hash, action, reason, result_code)
        repeats = sum(
            1
            for item in self.history
            if (item.state_hash, item.action, item.reason, item.result_code) == current
        )
        if repeats >= 3:
            return False

        recent = [
            (item.state_hash, item.action, item.reason, item.result_code)
            for item in self.history[-6:]
        ]
        return not (
            len(recent) == 6
            and recent[0] == recent[2] == recent[4]
            and recent[1] == recent[3] == recent[5]
            and recent[0] != recent[1]
        )

    def stalled_reason(self) -> str:
        if not self.history:
            return "no iterations recorded"
        last = self.history[-1]
        return (
            f"loop stalled after {self.iterations} iterations; "
            f"last action={last.action} reason={last.reason} "
            f"code={last.result_code}"
        )
