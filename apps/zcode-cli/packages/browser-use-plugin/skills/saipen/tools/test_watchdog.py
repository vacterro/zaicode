"""Focused T-1448 watchdog/lease-fencing acceptance."""

from __future__ import annotations

import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path

from saipen_engine import watchdog


class WatchdogTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="saipen-watchdog-")
        self.root = Path(self.tmp.name)
        (self.root / ".saipen").mkdir()
        self.t0 = dt.datetime(2026, 9, 22, 10, 0, tzinfo=dt.timezone.utc)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_healthy_heartbeat_does_not_take_over(self) -> None:
        lease = watchdog.acquire_lease(self.root, "worker-a", now=self.t0)
        status = watchdog.observe(self.root, now=self.t0 + dt.timedelta(seconds=10))
        self.assertEqual(status.state, watchdog.HEALTHY)
        with self.assertRaisesRegex(RuntimeError, "LIVE_LEASE_PRESENT"):
            watchdog.acquire_lease(self.root, "worker-b", now=self.t0 + dt.timedelta(seconds=10))
        self.assertTrue(
            watchdog.mutation_allowed(
                self.root, "worker-a", lease["lease_generation"], now=self.t0
            )
        )

    def test_frozen_or_dead_worker_expires_then_replacement_advances_generation(self) -> None:
        old = watchdog.acquire_lease(self.root, "worker-a", now=self.t0)
        status = watchdog.observe(self.root, now=self.t0 + dt.timedelta(seconds=121))
        self.assertEqual(status.state, watchdog.EXPIRED)
        watchdog.fence(
            self.root, "worker-a", old["lease_generation"],
            now=self.t0 + dt.timedelta(seconds=121),
        )
        new = watchdog.acquire_lease(self.root, "worker-b", now=self.t0 + dt.timedelta(seconds=122))
        self.assertEqual(new["lease_generation"], old["lease_generation"] + 1)
        self.assertFalse(
            watchdog.mutation_allowed(
                self.root, "worker-a", old["lease_generation"],
                now=self.t0 + dt.timedelta(seconds=122),
            )
        )
        self.assertTrue(
            watchdog.mutation_allowed(
                self.root, "worker-b", new["lease_generation"],
                now=self.t0 + dt.timedelta(seconds=122),
            )
        )

    def test_old_worker_return_is_fenced(self) -> None:
        old = watchdog.acquire_lease(self.root, "worker-a", now=self.t0)
        watchdog.fence(
            self.root, "worker-a", old["lease_generation"],
            now=self.t0 + dt.timedelta(seconds=121),
        )
        new = watchdog.acquire_lease(self.root, "worker-b", now=self.t0 + dt.timedelta(seconds=122))
        with self.assertRaisesRegex(RuntimeError, "FENCED_LEASE_GENERATION"):
            watchdog.heartbeat(
                self.root, "worker-a", old["lease_generation"],
                now=self.t0 + dt.timedelta(seconds=123),
            )
        self.assertEqual(
            watchdog.observe(
                self.root, now=self.t0 + dt.timedelta(seconds=123)
            ).lease_generation,
            new["lease_generation"],
        )

    def test_supervisor_restart_reconstructs_health_from_runtime_carrier(self) -> None:
        lease = watchdog.acquire_lease(self.root, "worker-a", now=self.t0)
        reloaded = watchdog.observe(self.root, now=self.t0 + dt.timedelta(seconds=31))
        self.assertEqual(reloaded.state, watchdog.SUSPECT)
        self.assertEqual(reloaded.worker_id, lease["worker_id"])
        self.assertEqual(reloaded.lease_generation, lease["lease_generation"])

    def test_missing_or_corrupt_heartbeat_fails_closed(self) -> None:
        self.assertEqual(watchdog.observe(self.root, now=self.t0).state, watchdog.UNKNOWN)
        path = self.root / watchdog.CACHE_REL
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"schema_version": 1, "worker_id": "a"}), encoding="utf-8")
        self.assertEqual(watchdog.observe(self.root, now=self.t0).state, watchdog.UNKNOWN)
        self.assertFalse(watchdog.mutation_allowed(self.root, "a", 1, now=self.t0))

    def test_terminal_worker_is_not_recovered_as_healthy(self) -> None:
        lease = watchdog.acquire_lease(self.root, "worker-a", now=self.t0)
        path = self.root / watchdog.CACHE_REL
        payload = json.loads(path.read_text(encoding="utf-8"))
        payload["status"] = watchdog.TERMINAL
        path.write_text(json.dumps(payload), encoding="utf-8")
        self.assertEqual(watchdog.observe(self.root, now=self.t0).state, watchdog.TERMINAL)
        self.assertFalse(
            watchdog.mutation_allowed(
                self.root, lease["worker_id"], lease["lease_generation"], now=self.t0
            )
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
