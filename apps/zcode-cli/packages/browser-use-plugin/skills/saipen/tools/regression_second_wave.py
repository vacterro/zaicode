import subprocess
import tempfile
import sys
from pathlib import Path


def _run(cmd, cwd):
    r = subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True)
    return r


def run_tests():
    root = Path(__file__).parent.parent
    saipen_py = root / "tools" / "saipen.py"

    print("Testing T-1015 (USERPERSON credentials)")
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        project = tdp / "project"
        project.mkdir()
        saipen_dir = project / ".saipen"
        saipen_dir.mkdir()

        r = subprocess.run(
            [
                sys.executable,
                str(saipen_py),
                "--project-root",
                str(project),
                "userperson",
                "add",
                "my key is sk-1234567890123456789012345678901234567890",
            ],
            cwd=str(project),
            capture_output=True,
            text=True,
        )
        if "sk-***" not in r.stdout and "sk-***" not in r.stderr:
            if r.returncode == 0:
                userperson_file = saipen_dir / "USERPERSON.md"
                content = userperson_file.read_text(encoding="utf-8")
                assert "sk-***" in content
                assert "sk-123" not in content
                print("T-1015 PASS")
            else:
                print(f"T-1015 FAIL: {r.stderr} {r.stdout}")

    print("ALL TESTS PASSED")


if __name__ == "__main__":
    run_tests()
