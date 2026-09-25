"""Document I/O with genuine encoding/BOM/newline byte preservation.

Reads never die on a `.saipen/` file's encoding (a decode error must not kill
the whole run). A Document retains every representation fact -- encoding,
BOM, newline convention, final-newline state -- and `encode()` reproduces the
exact byte representation of a mutated text. `read_doc` remains the normalised
LF view used by parsers; mutations that claim preservation go through the
Document so the journal stores the EXACT intended bytes (NITRO integrity).

A UTF-16LE BOM file is decoded as UTF-16 and re-encoded as UTF-16 with its BOM.
No path ever prepends a UTF-16 BOM to UTF-8 bytes or silently rewrites a
non-UTF-8 document as UTF-8.
"""

from __future__ import annotations

import hashlib
import os
import re as _re
from dataclasses import dataclass
from pathlib import Path

_BOMS = (
    (b"\xef\xbb\xbf", "utf-8-sig", "utf-8"),
    (b"\xff\xfe\x00\x00", "utf-32-le", "utf-32-le"),
    (b"\x00\x00\xfe\xff", "utf-32-be", "utf-32-be"),
    (b"\xff\xfe", "utf-16-le", "utf-16-le"),
    (b"\xfe\xff", "utf-16-be", "utf-16-be"),
)
# bom_bytes -> (decoder, clean_codec_name)
_DECODE = {bom: (dec, clean) for bom, dec, clean in _BOMS}


def _bomless_utf16(raw: bytes):
    """Name the UTF-16 flavour of a BOM-less file, or None."""
    if len(raw) < 4 or b"\x00" not in raw:
        return None
    head = raw[:4096]
    head = head[: len(head) - len(head) % 2]
    half = len(head) // 2
    if not half:
        return None
    even, odd = head[0::2].count(0), head[1::2].count(0)
    if odd > half * 0.3 and even < half * 0.1:
        return "utf-16-le"
    if even > half * 0.3 and odd < half * 0.1:
        return "utf-16-be"
    return None


def encoding_of(path: Path | str) -> str:
    """Name the encoding of a file, without decoding it.

    A BOM-carrying UTF-8 file is named `utf-8-sig`, NOT the clean `utf-8`:
    the release gate's own encoder names it that way, and callers gate on
    `!= "utf-8"` (validate.py, fast_check.validate_project) to refuse a file
    the strict parser cannot read whole -- a BOM alone breaks `^---`, so
    frontmatter silently parses as empty. Naming it clean would let a
    BOM'd checkpoint through post-write verification while every other tool
    misreads it.
    """
    try:
        raw = Path(path).read_bytes()
    except OSError:
        return "unreadable"
    for bom, _dec, clean in _BOMS:
        if raw.startswith(bom):
            return _dec
    bomless = _bomless_utf16(raw)
    if bomless:
        return bomless
    try:
        raw.decode("utf-8")
    except UnicodeDecodeError:
        return "not-utf-8"
    return "utf-8"


def _decode(raw: bytes) -> tuple[str, str, bytes]:
    """Return (text, clean_codec_name, bom)."""
    for bom, _dec, clean in _BOMS:
        if raw.startswith(bom):
            return raw[len(bom) :].decode(clean, errors="replace"), clean, bom
    bomless = _bomless_utf16(raw)
    if bomless:
        return raw.decode(bomless, errors="replace"), bomless, b""
    try:
        return raw.decode("utf-8"), "utf-8", b""
    except UnicodeDecodeError:
        try:
            return raw.decode("cp1251"), "cp1251", b""
        except UnicodeDecodeError:
            return raw.decode("utf-8", errors="replace"), "utf-8", b""


def is_canonical_encoding(raw: bytes) -> bool:
    """True ONLY for exactly UTF-8 WITHOUT a BOM and without surrogates.

    A BOM is three valid UTF-8 bytes, so a naive strict decode accepts a
    `utf-8-sig` file -- but every SAIPEN tool reads the checkpoint byte-wise
    and a leading BOM breaks `^---`, so the frontmatter silently parses as
    empty. Canonical means clean `utf-8`, never `utf-8-sig` (T-1003 / P1#3)."""
    if raw[:3] == b"\xef\xbb\xbf":
        return False
    try:
        raw.decode("utf-8", errors="strict")
        return True
    except UnicodeDecodeError:
        return False


def checkpoint_paths(root: Path | str) -> list[Path]:
    """The three canonical checkpoint files, in load order."""
    root = Path(root)
    return [root / ".saipen" / name for name in ("STATE.md", "BOARD.md", "LOG.md")]


def checkpoint_preflight(root: Path | str) -> str | None:
    """Refuse a checkpoint that is not readable as canonical UTF-8 (no BOM).

    Returns a human problem string when any canonical file is MISSING or NOT
    plain UTF-8-without-a-BOM, else None. Callers MUST run this BEFORE any
    decode/parse/write so a BOM/UTF-16 or absent checkpoint is refused with
    zero canonical writes, never transcoded implicitly (T-1003 / P1#3, P1#4)."""
    for path in checkpoint_paths(root):
        if not path.is_file():
            return (
                f"{path.name} is missing -- a SAIPEN checkpoint requires "
                f"STATE.md, BOARD.md and LOG.md to all be present"
            )
        raw = path.read_bytes()
        if not is_canonical_encoding(raw):
            enc = encoding_of(path)
            return (
                f"{path.name} is {enc}, not canonical UTF-8 without a BOM "
                f"-- every SAIPEN tool reads it byte-wise and will fail "
                f"differently; rewrite as UTF-8 without a BOM "
                f"(KNOWLEDGE/traps.md)"
            )
    return None


@dataclass(frozen=True)
class Document:
    """Decoded text plus the representation facts needed to write it back."""

    text: str
    encoding: str
    bom: bytes = b""
    newline: str = "\n"
    final_newline: bool = True
    raw_hash: str = ""

    @property
    def lines(self) -> list[str]:
        return self.text.splitlines()

    @property
    def text_norm(self) -> str:
        """The LF-normalised view parsers use."""
        return self.text.replace("\r\n", "\n").replace("\r", "\n")

    def encode(self, new_text: str) -> bytes:
        """Encode `new_text` (LF-normalised) into the ORIGINAL representation:
        same encoding, same BOM, same newline convention, same final-newline
        state. Returns the exact bytes a mutation should journal.

        Final-newline state is enforced BOTH ways (T-1003): a document whose
        original ended WITHOUT a terminal newline must not gain one from a
        mutation that happens to supply trailing LF -- a semantic edit would
        otherwise silently change representation. The trailing newline (in
        the document's own convention) is stripped when the original had none.
        """
        body = new_text
        if self.newline != "\n":
            body = body.replace("\n", self.newline)
        if not self.final_newline:
            while body.endswith(self.newline):
                body = body[: -len(self.newline)]
        elif not body.endswith(self.newline):
            body += self.newline
        if self.bom:
            return self.bom + body.encode(self.encoding)
        return body.encode(self.encoding)


class CheckpointLoadError(ValueError):
    """A canonical checkpoint file is MISSING or NOT plain UTF-8 without a BOM.

    The checkpoint loader raises this BEFORE any decode/parse so a corrupt
    checkpoint is refused with zero canonical writes (T-1003 / P1#3, P1#4).
    ``operations._read`` converts it into the operation's structured
    ``CheckpointError`` refusal; the exception type lives in ``codec`` so the
    loader and the caller stay decoupled."""


def read_document(path: Path | str, raw: bytes | None = None) -> Document:
    """Read a file and record its encoding/BOM/newline/final-newline facts.

    PERFORMANCE (PERF-003): when ``raw`` is supplied (already-read bytes from a
    single read of the file), it is reused instead of re-reading from disk, so
    the canonical checkpoint loader can read each STATE/BOARD/LOG document once
    and feed both the encoding preflight and the decode from the same bytes.
    """
    path = Path(path)
    if raw is None:
        raw = path.read_bytes() if path.is_file() else b""

    if path.name in ("STATE.md", "BOARD.md", "LOG.md"):
        if not is_canonical_encoding(raw):
            return Document(
                text="---\nphase: CORRUPT\ncorrupt_detail: non-canonical encoding\n---\n",
                encoding="utf-8",
                bom=b"",
                newline="\n",
                final_newline=True,
                raw_hash=hashlib.sha256(raw).hexdigest()[:16],
            )

    text, encoding, bom = _decode(raw)
    newline = "\n"
    for candidate in ("\r\n", "\r", "\n"):
        if candidate in text:
            newline = candidate
            break
    final_newline = bool(text) and text.endswith(("\n", "\r"))
    return Document(
        text=text,
        encoding=encoding,
        bom=bom,
        newline=newline,
        final_newline=final_newline,
        raw_hash=hashlib.sha256(raw).hexdigest()[:16],
    )


def read_checkpoint_doc(root: Path | str, name: str) -> Document:
    """Read ONE canonical checkpoint document (STATE/BOARD/LOG) once.

    Combines the old two-step ``checkpoint_preflight`` (encoding check) +
    ``read_document`` (decode) into a SINGLE filesystem read: the bytes are
    read once, canonical-encoding is checked against them, and the decoded
    ``Document`` is built from the same bytes (PERF-003). Raises
    ``CheckpointLoadError`` -- identical problem text to ``checkpoint_preflight``
    -- when the file is missing or not plain UTF-8 without a BOM, so callers
    refuse with ``CheckpointError`` and zero canonical writes exactly as before.
    """
    path = Path(root) / ".saipen" / name
    if not path.is_file():
        raise CheckpointLoadError(
            f"{name} is missing -- a SAIPEN checkpoint requires "
            f"STATE.md, BOARD.md and LOG.md to all be present"
        )
    raw = path.read_bytes()
    if not is_canonical_encoding(raw):
        enc = encoding_of(path)
        raise CheckpointLoadError(
            f"{name} is {enc}, not canonical UTF-8 without a BOM "
            f"-- every SAIPEN tool reads it byte-wise and will fail "
            f"differently; rewrite as UTF-8 without a BOM "
            f"(KNOWLEDGE/traps.md)"
        )
    return read_document(path, raw)


def write_document(path: Path | str, doc: Document, new_text: str) -> None:
    """Write a document preserving its representation facts. Atomic."""
    payload = doc.encode(new_text)
    tmp = Path(path).with_name(Path(path).name + ".tmp")
    with open(tmp, "wb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def read_doc(path: Path | str) -> str:
    """The LF-normalised decoded text, as the validator sees it."""
    return read_document(path).text_norm


def encode_preserving(path: Path | str, new_text: str) -> bytes:
    """Encode `new_text` into the exact bytes the file at `path` would carry
    after a mutation, preserving that file's current representation."""
    return read_document(path).encode(new_text)


# T-1101: the ONE canonical credential redaction primitive. All user-derived
# text that reaches any persistence target (STATE/BOARD/LOG/recovery/sealed
# segments) MUST pass through this function before bytes are constructed.
# userperson._redact_credentials and any other isolated copies are replaced
# by this single boundary function to make credential exclusion a persistence
# invariant rather than a fragmentary per-path concern.
_CRED_PATTERNS = [
    (_re.compile(r"ghp_[a-zA-Z0-9]{36}"), "ghp_***"),
    (_re.compile(r"AKIA[0-9A-Z]{16}"), "AKIA***"),
    (_re.compile(r"sk-[a-zA-Z0-9]{32,}"), "sk-***"),
    (
        _re.compile(r"(postgres(?:ql)?://[^:]+):[^@]+(@)"),
        r"\1:***\2",
    ),
    (_re.compile(r"(?i)(bearer\s+)[a-zA-Z0-9_\-\.]{30,}"), r"\1***"),
]


def redact_credentials(text: str) -> str:
    """Canonical credential redaction for the persistence boundary.

    High-confidence credential shapes (ghp_, AKIA, sk-, postgres URI
    passwords, bearer tokens) are replaced with redacted placeholders
    before any user-derived text is written to STATE, BOARD, LOG,
    recovery, or sealed segments (CORE § 1.1, T-1015, T-1101).
    """
    for pattern, repl in _CRED_PATTERNS:
        text = pattern.sub(repl, text)
    return text
