"""Publish the verified inline producer through SAIPEN's fenced staging API."""
from pathlib import Path
import json
import sys

root = Path(__file__).resolve().parents[3]
kernel_home = json.loads('"V:/___VAC/__K/__CODE/_AI_STUFF_AGENTIC/_SAIPEN"')
sys.path.insert(0, str(Path(kernel_home) / "tools"))
from freshness import compute_source_identity
from saipen_engine.producer import ProducerEpoch, ProducerPackage, StagingGeneration, producer_namespace, read_set_from, write_set_before
from saipen_engine.subs import current_local_role_revision

kitchen = Path(__file__).parent
verification = json.loads((kitchen / "payload-verification.json").read_text(encoding="utf-8"))
if verification["status"] != "PASS":
    raise RuntimeError("producer verification did not pass")
payload = {}
for directory, prefix in [("integration", "zcode/"), ("integration-workspace", "")]:
    manifest = json.loads((kitchen / directory / "manifest.json").read_text(encoding="utf-8"))
    for entry in manifest["files"]:
        payload[prefix + entry["file"]] = (kitchen / directory / entry["file"]).read_bytes()
payload["zcode/specs/locale-expansion.md"] = (root / "zcode/specs/locale-expansion.md").read_bytes()
reads = set(payload) | {
    "README.md", "docs/ZAICODE_INSTALL.md", "docs/ZAICODE_SAIPEN_CLOUD.md",
    "zcode/packages/ui/src/i18n/locales/en-US.ts", "zcode/packages/ui/src/i18n/locales/zh-CN.ts",
    "zcode/packages/ui/src/i18n/locales/saiasui.ts", "zcode/apps/zcode-cli/packages/i18n/src/locales/en-US.ts",
    "zcode/packages/ui/src/lib/builtinSkillI18n.ts", "zcode/packages/shared/src/desktopMenu.ts",
}
namespace = producer_namespace(root, "saitranslate")
epoch = ProducerEpoch.claim(namespace)
identity = compute_source_identity(root)
revision = current_local_role_revision(root, "saitranslate")
generation = StagingGeneration(namespace, "saitranslate").begin()
package = ProducerPackage(
    producer="saitranslate", role_revision=revision,
    base_source_head=identity.source_head, base_source_tree_fingerprint=identity.source_tree_fingerprint,
    base_discovery_model=identity.discovery_model,
    scope="Complete 32-language and DED UI, CLI, native-menu, auxiliary and user-document catalogs with locale selection/persistence integration",
    read_set=read_set_from(root, sorted(reads)), write_set=write_set_before(root, sorted(payload)), epoch=epoch,
)
for name, data in payload.items():
    generation.add_payload(name, data)
generation.set_package(package)
result = generation.publish()
if not result.get("ok"):
    raise RuntimeError(json.dumps(result))
(kitchen / "published-package.json").write_text(json.dumps({**result, "package_identity": package.package_identity, "source_head": identity.source_head, "source_tree_fingerprint": identity.source_tree_fingerprint, "role_revision": revision, "files": len(payload)}, indent=2) + "\n", encoding="utf-8")
(kitchen / "OUTBOX.md").write_text(f"""# OUTBOX

## SAIT-001: complete locale catalogs and integration
- **status:** ready
- **summary:** Complete 32 languages and DED: 5875 runtime UI keys, 199 CLI strings, 50 native-menu and 30 auxiliary strings, and 110 user-document paragraphs per translated locale. Core-owned EN/RU/ET/DED and producer-owned other locales retain their provenance.
- **producer:** saitranslate
- **source_head:** {identity.source_head}
- **source_tree_fingerprint:** {identity.source_tree_fingerprint}
- **role_revision:** {revision}
- **coverage:** UI, CLI/TUI, native menus, platform labels and builtin skill descriptions; README.md, docs/ZAICODE_INSTALL.md and docs/ZAICODE_SAIPEN_CLOUD.md; en-US, ru-RU, et-EE, uk-UA, ja-JP, ded, zh-CN, de-DE, fr-FR, es-ES, it-IT, pt-BR, nl-NL, pl-PL, sv-SE, da-DK, fi-FI, nb-NO, ko-KR, th-TH, vi-VN, ar-SA, he-IL, tr-TR, hi-IN, id-ID, el-GR, cs-CZ, ro-RO, hu-HU, bg-BG, sk-SK, hr-HR. English and hand-maintained Chinese catalogs remain source-owned; translated docs include 32 locale sets and the three required README mirrors.
- **payload:** READY/{package.package_identity}.json; kitchen/integration/manifest.json and kitchen/integration-workspace/manifest.json enumerate {len(payload)} exact targets with before/after hashes. kitchen/payload-verification.json records the producer checks.
- **instructions:** Collect with saipen collect saitranslate. Core must run product typecheck, lint, architecture and tests, build affected CLI packages and the Windows app, then verify representative locale switching/persistence/RTL and runtime queue dispatch before REVIEW/SHIP. Main files remain unchanged until collection.
- **verified:** PASS -- audit.mjs checked every key, placeholder and protected technical token; verify-payload.mjs checked all 33 runtime key sets, staged hashes and 95 TypeScript syntax trees. Commands and code blocks are opaque source tokens. Documentation received bounded second-model prose checks and Core Estonian semantic correction; this does not claim human native-language review or Core runtime acceptance.
""", encoding="utf-8")
print(json.dumps({"status": "READY", "package_identity": package.package_identity, "files": len(payload)}))
