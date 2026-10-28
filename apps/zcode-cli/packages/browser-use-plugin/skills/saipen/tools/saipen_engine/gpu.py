"""SAIGPU: the idle-GPU lane -- local compute that helps agents, never decides.

An agent host spends most of a SAIPEN run waiting on a frontier model or on
the declared test family, and a local GPU sits idle the whole time. This
module gives that GPU one bounded, useful job: a semantic RECALL index over
the project's own memory -- BOARD Work, KNOWLEDGE, FUTURE GATEs and LOG
decisions -- built by a local embedding model while the card is free, and
read in milliseconds when an agent needs it:

* ``saipen gpu recall <text>`` -- the nearest Work, decisions and knowledge
  for a question, so a cold agent orients from pointers instead of re-reading
  the tree;
* the echo advisory -- ``ticket add`` names existing Work that says nearly
  the same thing, the near-duplicate case T-1469's exact-echo rule cannot see;
* red-test triage (T-1481) -- after a declared-family run with red tests, the
  red sections are grouped by a mechanical signature (every id covered by
  construction) and a local chat model writes one hypothesis per group,
  ``saipen gpu triage`` or the side lane.

The rules are the telemetry rules (SRC-108): the lane is OBSERVED, it never
DEFINES truth.

* **Default OFF.** Nothing here runs until ``saipen gpu on`` (or
  ``SAIPEN_GPU=on``). ``SAIPEN_GPU=off`` in the process environment wins over
  everything, so a hermetic test or an operator can always silence it.
* **Advisory only.** Every answer is labelled ADVISORY. Nothing here writes
  STATE, BOARD, LOG, a receipt or evidence, and no gate consumes it. All of it
  lives under ``.saipen/cache/gpu/`` (git-ignored runtime cache); deleting the
  directory is a complete, safe reset -- the lane goes back to OFF.
* **Yields.** The lane works only while the card is idle: utilization under
  ``max_busy_percent`` and at least ``min_free_mib`` VRAM free, measured by
  ``nvidia-smi`` right before each batch. The model is loaded with a short
  ``keep_alive`` so VRAM is handed back within seconds of the last batch.
* **Bounded and incremental.** An index refresh embeds only texts whose digest
  changed, stops at its time budget, and writes atomically; a killed refresh
  loses at most the batch in flight.
* **Fails soft.** No GPU, no ``nvidia-smi``, no Ollama, no model: every entry
  point answers with a reason code and never raises into a caller.

The backend is Ollama's local HTTP API (``/api/embed``), standard library only.
The endpoint RECEIVES PROJECT TEXT -- BOARD, LOG decisions, KNOWLEDGE -- so an
``endpoint`` in ``config.json`` that is not on this machine sends that text
off it (T-1482); the default is 127.0.0.1.
"""

from __future__ import annotations

import base64
import contextlib
import hashlib
import json
import math
import os
import re
import struct
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

CACHE_REL = Path(".saipen") / "cache" / "gpu"
CONFIG_NAME = "config.json"
INDEX_NAME = "index.json"
ENV_SWITCH = "SAIPEN_GPU"
SCHEMA_VERSION = 1

DEFAULTS = {
    "enabled": False,
    "endpoint": "http://127.0.0.1:11434",
    "embed_model": "qwen3-embedding:0.6b",
    #: Matryoshka truncation: the first N dimensions, renormalized. 256 keeps
    #: an item near 1 KiB while recall on short protocol texts stays sharp.
    "dims": 256,
    "max_busy_percent": 60,
    "min_free_mib": 1024,
    "keep_alive": "30s",
    "batch": 16,
    #: Seconds the lane rests before re-measuring the card between batches.
    #: nvidia-smi reports utilization over the last sample window, so without
    #: the rest the lane measures its OWN previous batch and yields to itself.
    #: It doubles as the duty cycle that keeps the lane polite.
    "cooldown_s": 1.0,
    #: A desktop spikes the card for a moment (a video, a page); the lane
    #: waits this many cooldowns x5 for it to pass before giving up the run.
    "patience": 3,
    "echo_threshold": 0.80,
    #: T-1481 red-test triage: a local chat model, only while the card is idle
    #: AND this much VRAM is free (a 14B Q4 model wants ~9-10 GiB).
    "llm_model": "qwen3:14b",
    "llm_min_free_mib": 8000,
    "llm_timeout_s": 240,
}

#: Reason codes. One closed vocabulary; ``READY`` is the only one that works.
READY = "READY"
DISABLED = "DISABLED"
NO_GPU = "NO_GPU"
GPU_BUSY = "GPU_BUSY"
VRAM_LOW = "VRAM_LOW"
BACKEND_DOWN = "BACKEND_DOWN"
MODEL_MISSING = "MODEL_MISSING"

ADVISORY = "ADVISORY (local GPU recall; pointers, not evidence)"

#: What an agent asks with. qwen3-embedding is instruction-aware on the query
#: side only; documents are embedded bare.
QUERY_INSTRUCTION = (
    "Instruct: Given a SAIPEN task or question, retrieve the related Work "
    "tickets, recorded decisions and project knowledge\nQuery: "
)

MAX_ITEMS = 8000
MAX_TEXT = 1500
LOG_DECISIONS = 3000


# ---------------------------------------------------------------------------
# configuration


def cache_dir(root: Path | str) -> Path:
    return Path(root) / CACHE_REL


def load_config(root: Path | str) -> dict:
    config = dict(DEFAULTS)
    with contextlib.suppress(OSError, ValueError, TypeError):
        stored = json.loads((cache_dir(root) / CONFIG_NAME).read_text(encoding="utf-8"))
        if isinstance(stored, dict):
            config.update({k: v for k, v in stored.items() if k in DEFAULTS})
    return config


def switch(root: Path | str) -> tuple[bool, str]:
    """``(enabled, source)``; the process environment wins over the file."""
    env = os.environ.get(ENV_SWITCH, "").strip().lower()
    if env in ("0", "off", "false", "no"):
        return False, "env"
    if env in ("1", "on", "true", "yes"):
        return True, "env"
    config = load_config(root)
    if (cache_dir(root) / CONFIG_NAME).is_file():
        return bool(config.get("enabled")), "config"
    return False, "default"


def _write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, sort_keys=True), encoding="utf-8")
    os.replace(tmp, path)


def set_enabled(root: Path | str, enabled: bool, **overrides) -> dict:
    config = load_config(root)
    config.update({k: v for k, v in overrides.items() if k in DEFAULTS and v is not None})
    config["enabled"] = bool(enabled)
    _write_json(cache_dir(root) / CONFIG_NAME, config)
    return config


# ---------------------------------------------------------------------------
# probes (read-only, bounded, never raise)


def probe_gpu(timeout: float = 5.0) -> dict | None:
    """The first NVIDIA card as ``nvidia-smi`` sees it, or None."""
    try:
        out = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,utilization.gpu,memory.total,memory.used",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    for line in out.stdout.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) != 4:
            continue
        try:
            util, total, used = (int(float(p)) for p in parts[1:])
        except ValueError:
            continue
        return {
            "name": parts[0],
            "utilization_percent": util,
            "memory_total_mib": total,
            "memory_free_mib": max(total - used, 0),
        }
    return None


def _http(endpoint: str, path: str, payload: dict | None, timeout: float) -> dict:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        endpoint.rstrip("/") + path,
        data=data,
        headers={"Content-Type": "application/json"},
        method="GET" if payload is None else "POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def probe_backend(config: dict, timeout: float = 3.0) -> dict:
    """``{"up": bool, "models": [...]}`` for the configured Ollama endpoint."""
    try:
        tags = _http(config["endpoint"], "/api/tags", None, timeout)
    except (OSError, ValueError, urllib.error.URLError):
        return {"up": False, "models": []}
    names = sorted(str(m.get("name")) for m in tags.get("models") or [] if isinstance(m, dict))
    return {"up": True, "models": names}


def _model_present(model: str, names: list[str]) -> bool:
    wanted = model if ":" in model else model + ":latest"
    return wanted in names


def gate(
    root: Path | str,
    *,
    gpu_probe=None,
    backend_probe=None,
    need_enabled: bool = True,
    llm: bool = False,
) -> dict:
    """May the lane use the card RIGHT NOW? ``{"ok", "reason", ...}``.

    ``llm`` asks for the triage model instead of the embedding model: a
    different model to find and a far larger VRAM footprint to leave room for.
    """
    gpu_probe = gpu_probe or probe_gpu
    backend_probe = backend_probe or probe_backend
    config = load_config(root)
    model = config["llm_model"] if llm else config["embed_model"]
    need_mib = int(config["llm_min_free_mib"] if llm else config["min_free_mib"])
    enabled, source = switch(root)
    answer = {"ok": False, "enabled": enabled, "switch": source, "gpu": None, "backend": None}
    if need_enabled and not enabled:
        return {**answer, "reason": DISABLED}
    card = gpu_probe()
    answer["gpu"] = card
    if card is None:
        return {**answer, "reason": NO_GPU}
    backend = backend_probe(config)
    answer["backend"] = backend
    if not backend["up"]:
        return {**answer, "reason": BACKEND_DOWN}
    if not _model_present(model, backend["models"]):
        return {**answer, "reason": MODEL_MISSING}
    if card["utilization_percent"] > int(config["max_busy_percent"]):
        return {**answer, "reason": GPU_BUSY}
    loaded = model in _loaded_models(config)
    if card["memory_free_mib"] < need_mib and not loaded:
        return {**answer, "reason": VRAM_LOW}
    return {**answer, "ok": True, "reason": READY}


def _loaded_models(config: dict) -> set[str]:
    try:
        ps = _http(config["endpoint"], "/api/ps", None, 2.0)
    except (OSError, ValueError, urllib.error.URLError):
        return set()
    return {str(m.get("name")) for m in ps.get("models") or [] if isinstance(m, dict)}


# ---------------------------------------------------------------------------
# vectors


def _normalize(vector: list[float], dims: int) -> list[float]:
    head = [float(x) for x in vector[:dims]]
    norm = math.sqrt(sum(x * x for x in head)) or 1.0
    return [x / norm for x in head]


def _pack(vector: list[float]) -> str:
    return base64.b64encode(struct.pack(f"<{len(vector)}f", *vector)).decode("ascii")


def _unpack(blob: str) -> list[float]:
    raw = base64.b64decode(blob)
    return list(struct.unpack(f"<{len(raw) // 4}f", raw))


def embed_ollama(config: dict, texts: list[str], timeout: float = 120.0) -> list[list[float]]:
    reply = _http(
        config["endpoint"],
        "/api/embed",
        {"model": config["embed_model"], "input": texts, "keep_alive": config["keep_alive"]},
        timeout,
    )
    vectors = reply.get("embeddings")
    if not isinstance(vectors, list) or len(vectors) != len(texts):
        raise ValueError("embedding backend returned the wrong number of vectors")
    return [_normalize(v, int(config["dims"])) for v in vectors]


# ---------------------------------------------------------------------------
# the corpus: the project's own memory, read-only

_TICKET_RE = re.compile(r"^- \[(?P<mark>.)\] (?P<id>T-\d+) (?P<body>.*)$")
_SECTION_RE = re.compile(r"^## (?P<name>[A-Z]+)")
_DEC_RE = re.compile(r"^- .*?\[(?P<event>E-\d+)\].*?\] DEC: (?P<body>.+)$")


def _ticket_text(body: str) -> str:
    # The title and verify clause carry the meaning; ownership and timing
    # fields are noise for recall.
    kept = []
    for part in body.split(" | "):
        key = part.split(":", 1)[0].strip()
        if key in ("owner", "claim_time", "detail_ref", "needs", "verify_attempts"):
            continue
        kept.append(part)
    return " | ".join(kept)


def corpus(root: Path | str) -> dict[str, dict]:
    """``{key: {"kind", "ref", "text"}}``; bounded, deterministic."""
    root = Path(root)
    items: dict[str, dict] = {}

    def add(kind: str, ref: str, text: str) -> None:
        text = " ".join(text.split())[:MAX_TEXT]
        if text and len(items) < MAX_ITEMS:
            items[f"{kind}:{ref}"] = {"kind": kind, "ref": ref, "text": text}

    with contextlib.suppress(OSError):
        section = ""
        for line in (root / ".saipen" / "BOARD.md").read_text(encoding="utf-8-sig").splitlines():
            head = _SECTION_RE.match(line)
            if head:
                section = head["name"]
                continue
            match = _TICKET_RE.match(line)
            if match:
                add("work", match["id"], f"{match['id']} [{section}] {_ticket_text(match['body'])}")
    for folder, kind in (
        (root / "KNOWLEDGE", "knowledge"),
        (root / ".saipen" / "KNOWLEDGE", "knowledge"),
        (root / "future_gate", "future_gate"),
    ):
        if not folder.is_dir():
            continue
        for path in sorted(folder.rglob("*.md"))[:600]:
            with contextlib.suppress(OSError):
                text = path.read_text(encoding="utf-8", errors="replace")
                rel = path.relative_to(root).as_posix()
                for n, chunk in enumerate(_chunks(text)[:8]):
                    add(kind, f"{rel}#{n}", f"{path.stem}: {chunk}")
    with contextlib.suppress(OSError):
        lines = (root / ".saipen" / "LOG.md").read_text(encoding="utf-8-sig").splitlines()
        decisions = [m for m in map(_DEC_RE.match, lines) if m]
        for match in decisions[-LOG_DECISIONS:]:
            add("decision", match["event"], match["body"])
    return items


def _chunks(text: str) -> list[str]:
    """Split Markdown on headings, then cap each piece."""
    pieces, current = [], []
    for line in text.splitlines():
        if line.startswith("#") and current:
            pieces.append("\n".join(current))
            current = []
        current.append(line)
    if current:
        pieces.append("\n".join(current))
    return [p for p in (" ".join(p.split()) for p in pieces) if len(p) > 40]


def _digest(model: str, dims: int, text: str) -> str:
    return hashlib.sha256(f"{model}\0{dims}\0{text}".encode("utf-8")).hexdigest()[:24]


# ---------------------------------------------------------------------------
# the index


def load_index(root: Path | str) -> dict:
    try:
        index = json.loads((cache_dir(root) / INDEX_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        index = None
    if not isinstance(index, dict) or index.get("schema") != SCHEMA_VERSION:
        index = {"schema": SCHEMA_VERSION, "items": {}}
    if not isinstance(index.get("items"), dict):
        index["items"] = {}
    return index


def refresh_index(
    root: Path | str,
    *,
    budget_s: float = 60.0,
    embed=None,
    gate_check=None,
    clock=time.monotonic,
    sleep=time.sleep,
) -> dict:
    """Embed what changed, drop what vanished, stop at the budget.

    ``gate_check`` is re-asked before every batch, so a user who starts a game
    mid-refresh gets the card back after at most one batch.
    """
    config = load_config(root)
    embed = embed or (lambda texts: embed_ollama(config, texts))
    gate_check = gate_check or (lambda: gate(root))
    started = clock()
    model, dims = config["embed_model"], int(config["dims"])
    wanted = corpus(root)
    index = load_index(root)
    stored = index["items"]
    vanished = [k for k in stored if k not in wanted]
    for key in vanished:
        del stored[key]
    todo = []
    for key, item in wanted.items():
        digest = _digest(model, dims, item["text"])
        if stored.get(key, {}).get("digest") != digest:
            todo.append((key, item, digest))
    embedded, stop = 0, "COMPLETE"
    batch = max(int(config["batch"]), 1)
    for start in range(0, len(todo), batch):
        if clock() - started >= budget_s:
            stop = "BUDGET"
            break
        verdict = _idle_gate(
            gate_check,
            config,
            rested=start == 0,
            deadline=started + budget_s,
            clock=clock,
            sleep=sleep,
        )
        if not verdict.get("ok"):
            stop = verdict.get("reason") or "GATE"
            break
        chunk = todo[start : start + batch]
        try:
            vectors = embed([item["text"] for _key, item, _d in chunk])
        except (OSError, ValueError, urllib.error.URLError) as exc:
            stop = f"{BACKEND_DOWN}: {exc}"[:200]
            break
        for (key, item, digest), vector in zip(chunk, vectors):
            stored[key] = {
                "kind": item["kind"],
                "ref": item["ref"],
                "digest": digest,
                "preview": item["text"][:160],
                "vec": _pack(vector),
            }
        embedded += len(chunk)
        index.update({"model": model, "dims": dims, "updated_at": _utc()})
        _write_json(cache_dir(root) / INDEX_NAME, index)
    # T-1482: an idle pass (nothing embedded, nothing vanished, same model)
    # writes nothing; the side lane runs every two minutes.
    if embedded == 0 and (vanished or (index.get("model"), index.get("dims")) != (model, dims)):
        index.update({"model": model, "dims": dims})
        _write_json(cache_dir(root) / INDEX_NAME, index)
    return {
        "ok": stop == "COMPLETE",
        "code": "GPU_INDEX",
        "stop": stop,
        "embedded": embedded,
        "pending": max(len(todo) - embedded, 0),
        "indexed": len(stored),
        "seconds": round(clock() - started, 2),
    }


def _idle_gate(gate_check, config: dict, *, rested: bool, deadline: float, clock, sleep) -> dict:
    """Ask the gate after the lane's OWN load has drained, with patience.

    nvidia-smi reports utilization over its last sample window, so a gate
    asked right after a batch or a model call measures the lane itself and
    yields to it -- measured twice: the index at 480 of 1304 items, and the
    first triage run after ONE group (99 % busy, its own inference). The rest
    before asking is also the lane's duty cycle; patience rides out a
    desktop spike instead of abandoning the pass.
    """
    if not rested:
        sleep(float(config["cooldown_s"]))
    verdict = gate_check()
    waited = 0
    while verdict.get("reason") == GPU_BUSY and waited < int(config["patience"]):
        if clock() >= deadline:
            break
        waited += 1
        sleep(float(config["cooldown_s"]) * 5)
        verdict = gate_check()
    return verdict


def _utc() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def recall(
    root: Path | str,
    text: str,
    *,
    k: int = 5,
    kinds: tuple[str, ...] | None = None,
    embed=None,
    query_instruction: bool = True,
) -> dict:
    """The ``k`` nearest indexed items to ``text``. Advisory, never raises.

    OFF means off: with the switch down not even the one query embedding runs.
    """
    if not switch(root)[0]:
        return {"ok": False, "code": "GPU_RECALL", "reason": DISABLED, "hits": []}
    config = load_config(root)
    index = load_index(root)
    items = [item for item in index["items"].values() if kinds is None or item.get("kind") in kinds]
    if not items:
        return {"ok": False, "code": "GPU_RECALL", "reason": "EMPTY_INDEX", "hits": []}
    if index.get("model") != config["embed_model"] or int(index.get("dims") or 0) != int(
        config["dims"]
    ):
        return {"ok": False, "code": "GPU_RECALL", "reason": "INDEX_MODEL_MISMATCH", "hits": []}
    embed = embed or (lambda texts: embed_ollama(config, texts, timeout=30.0))
    query = (QUERY_INSTRUCTION if query_instruction else "") + " ".join(text.split())[:MAX_TEXT]
    try:
        (vector,) = embed([query])
    except (OSError, ValueError, urllib.error.URLError) as exc:
        return {
            "ok": False,
            "code": "GPU_RECALL",
            "reason": f"{BACKEND_DOWN}: {exc}"[:200],
            "hits": [],
        }
    scored = []
    for item in items:
        other = _unpack(item["vec"])
        scored.append((sum(a * b for a, b in zip(vector, other)), item))
    scored.sort(key=lambda pair: (-pair[0], pair[1]["kind"], pair[1]["ref"]))
    hits = [
        {
            "kind": item["kind"],
            "ref": item["ref"],
            "score": round(score, 4),
            "preview": item.get("preview", ""),
        }
        for score, item in scored[: max(int(k), 1)]
    ]
    return {"ok": True, "code": "GPU_RECALL", "advisory": ADVISORY, "hits": hits}


def echo_advisory(
    root: Path | str, text: str, *, exclude: str | None = None, embed=None
) -> list[dict]:
    """Existing Work that says nearly what ``text`` says. [] whenever the lane is off.

    Pure advisory for ``ticket add``: it never refuses, never delays by more
    than one local embedding call, and says nothing when disabled.
    """
    enabled, _source = switch(root)
    if not enabled:
        return []
    threshold = float(load_config(root)["echo_threshold"])
    answer = recall(root, text, k=3, kinds=("work",), embed=embed, query_instruction=False)
    return [
        hit for hit in answer.get("hits", []) if hit["score"] >= threshold and hit["ref"] != exclude
    ]


def status(root: Path | str, *, gpu_probe=None, backend_probe=None) -> dict:
    config = load_config(root)
    verdict = gate(root, gpu_probe=gpu_probe, backend_probe=backend_probe, need_enabled=False)
    index = load_index(root)
    kinds: dict[str, int] = {}
    for item in index["items"].values():
        kinds[item.get("kind", "?")] = kinds.get(item.get("kind", "?"), 0) + 1
    enabled, source = switch(root)
    return {
        "ok": True,
        "code": "GPU_STATUS",
        "enabled": enabled,
        "switch": source,
        "lane": verdict["reason"] if enabled else DISABLED,
        "hardware": verdict["reason"],
        "gpu": verdict["gpu"],
        "backend": verdict["backend"],
        "embed_model": config["embed_model"],
        "index": {
            "items": len(index["items"]),
            "by_kind": kinds,
            "updated_at": index.get("updated_at"),
        },
        "llm_model": config["llm_model"],
        "triage_pending": pending_triage(root) is not None,
        "advisory": ADVISORY,
    }


# ---------------------------------------------------------------------------
# red-test triage (T-1481): mechanical groups, local-LLM hypotheses
#
# The GROUPING is arithmetic, so every red id is covered by construction and a
# model can neither drop nor invent a test. The model only annotates a group
# with a hypothesis -- the part a frontier agent would otherwise spend its
# own context reading tracebacks to reach. The output is advisory like
# everything else here: a pointer where to look first, never a verdict.

RED_SECTIONS_REL = Path(".saipen") / "cache" / "core-unit"
TRIAGE_DIR = "triage"
TRIAGE_SYSTEM = (
    "You triage failing unit tests of the SAIPEN repository. You see ONE group "
    "of failures that share an exception signature. In at most two sentences, "
    "name the most probable root cause and where to look first. Use only file "
    "and function names that appear in the traceback. If the traceback is not "
    "enough, say what is missing instead of guessing."
)
_EXCEPTION_RE = re.compile(
    r"^(?P<type>(?:[A-Za-z_][\w]*\.)*[A-Za-z_]\w*(?:Error|Exception|Exit|Failure|Interrupt|Warning))"
    r"\b:?\s?(?P<message>.*)$"
)
_FRAME_RE = re.compile(r'^\s*File "(?P<file>[^"]+)", line \d+, in (?P<func>\S+)')
_STDLIB_MARKERS = ("\\lib\\", "/lib/python", "\\python3", "/unittest/", "\\unittest\\")


def red_signature(section: str) -> str:
    """The mechanical root-cause key of one red section.

    Final exception type, its message with numbers, quoted values and paths
    normalized, and the innermost frame outside the standard library.
    """
    exception, frame = "NO_EXCEPTION", "?"
    for line in section.splitlines():
        found = _FRAME_RE.match(line)
        if found and not any(m in found["file"].lower() for m in _STDLIB_MARKERS):
            name = Path(found["file"]).name
            # A test method's own name is not a cause: two tests of one module
            # failing the same way are one group. An engine frame is.
            frame = name if name.startswith("test_") else f"{name}:{found['func']}"
        raised = _EXCEPTION_RE.match(line.strip())
        if raised:
            message = raised["message"]
            message = re.sub(r"'[^']*'|\"[^\"]*\"", "'…'", message)
            message = re.sub(r"[A-Za-z]:[\\/][^\s,)]+|/[\w./-]+", "<path>", message)
            message = re.sub(r"\d+", "N", message)
            exception = f"{raised['type'].rsplit('.', 1)[-1]}: {message[:80]}".rstrip(": ")
    return f"{exception} @ {frame}"


def group_red(sections: dict) -> list[dict]:
    """Red ids grouped by signature, largest group first; covers every id."""
    groups: dict[str, list[str]] = {}
    for test_id in sorted(sections):
        groups.setdefault(red_signature(sections[test_id]), []).append(test_id)
    ordered = sorted(groups.items(), key=lambda pair: (-len(pair[1]), pair[0]))
    return [
        {"signature": signature, "ids": ids, "excerpt": sections[ids[0]][-1500:]}
        for signature, ids in ordered
    ]


def chat_ollama(config: dict, system: str, prompt: str) -> str:
    reply = _http(
        config["endpoint"],
        "/api/chat",
        {
            "model": config["llm_model"],
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            # qwen3 reasons out loud unless told not to; a hypothesis needs none.
            "think": False,
            "stream": False,
            "keep_alive": config["keep_alive"],
            "options": {"temperature": 0.2, "num_ctx": 8192},
        },
        float(config["llm_timeout_s"]),
    )
    text = str((reply.get("message") or {}).get("content") or "")
    return re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()


def pending_triage(root: Path | str) -> Path | None:
    """The newest cached red-section file that has no complete triage yet."""
    folder = Path(root) / RED_SECTIONS_REL
    if not folder.is_dir():
        return None
    for path in sorted(folder.glob("*.red.json"), key=lambda p: p.name, reverse=True):
        done = cache_dir(root) / TRIAGE_DIR / path.name.replace(".red.json", ".json")
        with contextlib.suppress(OSError, ValueError):
            if json.loads(done.read_text(encoding="utf-8")).get("complete"):
                continue
        return path
    return None


def triage(
    root: Path | str,
    *,
    red_file: Path | None = None,
    chat=None,
    gate_check=None,
    budget_s: float = 900.0,
    clock=time.monotonic,
    sleep=time.sleep,
) -> dict:
    """Annotate the newest untriaged red run, one group per model call.

    Resumable: groups already annotated are kept, so a run the user
    interrupted (GPU_BUSY) continues where it stopped on the next pass.
    """
    if not switch(root)[0]:
        return {"ok": False, "code": "GPU_TRIAGE", "stop": DISABLED}
    source = red_file or pending_triage(root)
    if source is None:
        return {"ok": True, "code": "GPU_TRIAGE", "stop": "NOTHING_PENDING"}
    config = load_config(root)
    chat = chat or (lambda system, prompt: chat_ollama(config, system, prompt))
    gate_check = gate_check or (lambda: gate(root, llm=True))
    started = clock()
    payload = json.loads(Path(source).read_text(encoding="utf-8"))
    sections = payload.get("sections") or {}
    out = cache_dir(root) / TRIAGE_DIR / Path(source).name.replace(".red.json", ".json")
    previous = {}
    with contextlib.suppress(OSError, ValueError):
        for group in json.loads(out.read_text(encoding="utf-8")).get("groups") or []:
            if group.get("hypothesis"):
                previous[group["signature"]] = group["hypothesis"]
    groups = group_red(sections)
    stop = "COMPLETE"
    asked = 0
    for group in groups:
        if group["signature"] in previous:
            group["hypothesis"] = previous[group["signature"]]
            continue
        if clock() - started >= budget_s:
            stop = "BUDGET"
            break
        verdict = _idle_gate(
            gate_check,
            config,
            rested=asked == 0,
            deadline=started + budget_s,
            clock=clock,
            sleep=sleep,
        )
        if not verdict.get("ok"):
            stop = verdict.get("reason") or "GATE"
            break
        prompt = (
            f"Signature: {group['signature']}\n"
            f"Failing tests ({len(group['ids'])}): {', '.join(group['ids'][:12])}\n"
            f"Traceback of the first:\n{group['excerpt']}"
        )
        asked += 1
        try:
            group["hypothesis"] = chat(TRIAGE_SYSTEM, prompt)[:600]
        except (OSError, ValueError, urllib.error.URLError) as exc:
            stop = f"{BACKEND_DOWN}: {exc}"[:200]
            break
    annotated = sum(1 for group in groups if group.get("hypothesis"))
    result = {
        "record": payload.get("record"),
        "advisory": ADVISORY,
        "model": config["llm_model"],
        "complete": annotated == len(groups),
        "covered_ids": sum(len(group["ids"]) for group in groups),
        "groups": [{k: v for k, v in group.items() if k != "excerpt"} for group in groups],
        "updated_at": _utc(),
    }
    _write_json(out, result)
    return {
        "ok": result["complete"],
        "code": "GPU_TRIAGE",
        "stop": stop,
        "file": out.relative_to(Path(root)).as_posix(),
        "groups": len(groups),
        "annotated": annotated,
        "covered_ids": result["covered_ids"],
    }


# ---------------------------------------------------------------------------
# the side lane: runs next to `worker.supervise`, dies with it


class SideLane:
    """A daemon thread that refreshes the index while the supervisor works.

    It shares nothing with the supervisor but the project root and holds no
    lock: it reads canonical files and writes only its own cache.
    """

    def __init__(
        self,
        root: Path | str,
        *,
        every: float = 120.0,
        budget_s: float = 60.0,
        refresh=None,
        triage_job=None,
    ):
        self.root = Path(root)
        self.every = every
        self.budget_s = budget_s
        self._refresh = refresh or (lambda: refresh_index(self.root, budget_s=self.budget_s))
        # T-1481: after the index, the heavier job -- one bounded triage pass
        # over a red declared-family run, when one is waiting.
        self._triage = triage_job or (lambda: triage(self.root, budget_s=self.budget_s * 5))
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="saipen-gpu-lane", daemon=True)
        self.runs = 0
        self.embedded = 0
        self.annotated = 0
        self.last: dict | None = None
        self.last_triage: dict | None = None

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.last = self._refresh()
            except Exception as exc:
                self.last = {"ok": False, "stop": f"ERROR: {type(exc).__name__}: {exc}"[:200]}
            self.runs += 1
            self.embedded += int((self.last or {}).get("embedded") or 0)
            if not self._stop.is_set():
                try:
                    self.last_triage = self._triage()
                except Exception as exc:
                    self.last_triage = {"stop": f"ERROR: {type(exc).__name__}: {exc}"[:200]}
                self.annotated += int((self.last_triage or {}).get("annotated") or 0)
            self._stop.wait(self.every)

    def start(self) -> "SideLane":
        self._thread.start()
        return self

    def stop(self, timeout: float = 5.0) -> dict:
        self._stop.set()
        self._thread.join(timeout)
        return self.summary()

    def summary(self) -> dict:
        return {
            "runs": self.runs,
            "embedded": self.embedded,
            "last_stop": (self.last or {}).get("stop"),
            "triage_annotated": self.annotated,
            "last_triage_stop": (self.last_triage or {}).get("stop"),
        }


def start_side_lane(root: Path | str, **kwargs) -> SideLane | None:
    """A running lane when the switch is ON, else None. Never raises."""
    try:
        enabled, _source = switch(root)
    except Exception:
        return None
    if not enabled:
        return None
    return SideLane(root, **kwargs).start()
