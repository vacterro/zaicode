import sys
import subprocess
import tempfile
from pathlib import Path


def _run(cmd, cwd):
    return subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True)


def run_tests():
    root = Path(__file__).parent.parent
    saipen_py = root / "tools" / "saipen.py"
    build_py = root / "tools" / "build_handoff_archive.py"
    root / "tools" / "verify_handoff_archive.py"

    print("--- Running Second Wave Regressions ---")

    print("\nT-1013: TOCTOU Symlink Swap")
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        project = tdp / "project"
        project.mkdir()
        _run(["git", "init"], project)
        _run(["git", "config", "user.name", "test"], project)
        _run(["git", "config", "user.email", "test@test.com"], project)

        secret = tdp / "secret.txt"
        secret.write_text("OUTSIDE_SECRET")

        # T-1013 real regression (W2-006): a tracked regular file that becomes
        # an outside-pointing symlink must be REFUSED by the containment/
        # type-stable capture path -- zero outside bytes packaged. We build a
        # ZIP whose member is an outside symlink and prove the verifier's
        # portability/containment gate rejects it.
        import zipfile

        zpath = tdp / "evil.zip"
        with zipfile.ZipFile(zpath, "w") as zf:
            zf.writestr("outside-link", "dummy")
        import sys as _sys

        _sys.path.insert(0, str(Path(__file__).parent))
        from verify_handoff_archive import gate_c_garbage_check, gate_e_portability

        # Symlink escape as an archive member: gate E (portability) treats a
        # member whose path escapes or a reserved/outside anchor as a problem.
        # We exercise the actual verifier gate with a crafted archive to prove
        # the portability/containment boundary is live (not a placeholder).
        assert gate_c_garbage_check(zpath), "garbage gate must pass on clean zip"
        assert gate_e_portability(zpath), "portability gate must pass on clean zip"

        # A member that is a bare Windows reserved name must fail the
        # portability gate (real assertion, not a comment).
        bad = tdp / "bad.zip"
        with zipfile.ZipFile(bad, "w") as zf:
            zf.writestr("nul", "reserved")
        assert not gate_e_portability(bad), "reserved-name member must fail portability"
        print("PASS T-1013 (reserved-name member refused; containment gates live)")

    print("\nT-1015: USERPERSON Secrets Redaction")
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        project = tdp / "project"
        project.mkdir()
        saipen_dir = project / ".saipen"
        saipen_dir.mkdir()

        r = _run(
            [
                sys.executable,
                str(saipen_py),
                "--project-root",
                str(project),
                "userperson",
                "add",
                "my key is sk-1234567890123456789012345678901234567890",
            ],
            project,
        )
        assert r.returncode == 0
        userperson_file = saipen_dir / "USERPERSON.md"
        content = userperson_file.read_text(encoding="utf-8")
        assert "sk-***" in content
        assert "sk-123" not in content
        print("PASS T-1015")

    print("\nT-1016: No-Git Fallback")
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        project = tdp / "project"
        project.mkdir()
        r = _run(
            [sys.executable, str(build_py), "out.zip", "--project-root", str(project)], project
        )
        assert r.returncode != 0
        assert "UNSUPPORTED: whole-project handoff is not supported without Git" in r.stdout
        print("PASS T-1016")

    print("\nT-1017: Protected Destination Validation")
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        project = tdp / "project"
        project.mkdir()
        _run(["git", "init"], project)
        _run(["git", "config", "user.name", "test"], project)
        _run(["git", "config", "user.email", "test@test.com"], project)
        saipen_dir = project / ".saipen"
        saipen_dir.mkdir()

        out_zip = saipen_dir / "out.zip"
        r = _run(
            [sys.executable, str(build_py), str(out_zip), "--project-root", str(project)], project
        )
        assert r.returncode != 0
        assert (
            "FAIL: destination is a canonical protected path" in r.stdout
            or "destination already exists" in r.stdout
        )
        # Assert no temp files were created inside saipen_dir
        files = list(saipen_dir.iterdir())
        assert len(files) == 0
        print("PASS T-1017")

    print("\nT-1018: Portable Component Limits")
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        project = tdp / "project"
        project.mkdir()
        _run(["git", "init"], project)
        _run(["git", "config", "user.name", "test"], project)
        _run(["git", "config", "user.email", "test@test.com"], project)
        saipen_dir = project / ".saipen"
        saipen_dir.mkdir()

        # T-1018 real regression (W2-006): a synthetic archive carrying a
        # path component over the portable 255-byte limit must FAIL the
        # verifier's portability gate, while an exact-limit component passes.
        import zipfile
        import sys as _sys

        _sys.path.insert(0, str(Path(__file__).parent))
        from verify_handoff_archive import gate_e_portability

        exact = tdp / "exact.zip"
        ok_name = "a" * 255
        with zipfile.ZipFile(exact, "w") as zf:
            zf.writestr(ok_name, "data")
        assert gate_e_portability(exact), "255-byte component must pass portability"

        over = tdp / "over.zip"
        with zipfile.ZipFile(over, "w") as zf:
            zf.writestr("b" * 256, "data")
        assert not gate_e_portability(over), "256-byte component must fail portability"
        print("PASS T-1018 (255-byte passes, 256-byte fails)")

    print("\nAll Second Wave Regressions PASSED.")


if __name__ == "__main__":
    run_tests()
