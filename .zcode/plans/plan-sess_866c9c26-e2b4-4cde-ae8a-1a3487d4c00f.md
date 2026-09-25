## Tulemus

Käivitan `saitranslate` täpselt rollina. UI-d ega translatsioonimootorit ei ehitata. Täielik 32-keele + Дед `ready` pakett on praegu valetamisvõimatu: produkti i18n toetab ainult `en-US` ja `zh-CN`; sisemist tõlkija runnerit pole; outer Git fingerprint ei näe muudetavat nested `zcode/` repositooriumi. Seega lõpeb käivitus ausalt `blocked` OUTBOXiga, mitte väljamõeldud `ready` paketiga.

## 1. Taga üks õige identiteet

- Muudan vaid selle käivituse käigus tekkinud generic template OUTBOX-i kujule `# OUTBOX`.
- Käitan `saipen sub clean saitranslate`, mis archiveerib generic STATE/BOARD/LOG/OUTBOX, eemaldab vale `.saipen/extensions/subs/saitranslate/` ja selle MANIFEST-rea.
- Loon rolli ainult canonical workspace’i: `.saipen/saitranslate/{STATE.md,BOARD.md,LOG.md,kitchen/OUTBOX.md}`.
- `STATE.agent = saitranslate`; `mode = read-only`; `role_revision` arvutatakse olemasolevast `.saipen/extensions/subs/saitranslate.md` failist. Core STATE/BOARD/LOG sellisel bootstrapil ei muutu.

## 2. Tõesta pinnad ja värskus

- Kontrollin täielikku source-surface loendit: `UI.md`, `docs/*.md`, nested README/user docs ning päris UI/CLI i18n allikad.
- Kontrollin locale union-e ja catalogue-e: praegu ainult `en-US` + `zh-CN`; 32 locale arhitektuuri ja 30 uut kataloogi puuduvad.
- Arvutan outer `source_head`, `source_tree_fingerprint`, `role_revision` olemasoleva `freshness.py` abil.
- Recordin blockerina: outer `.gitignore` ignoreerib `/zcode/`, mistõttu outer freshness ei hõlma nested UI/doc muutusi; pelgad explicit read-set hashes ei tõesta uute või kustutatud nested failide muutust.

## 3. Kirjuta canonical blocked handoff

`.saipen/saitranslate/kitchen/OUTBOX.md` saab ühe `SAIT-001` kirje:

- `status: blocked`
- `producer: saitranslate`
- täpsed current source/role bindings
- `coverage`: kõik leitud docs- ja UI-pinnad ning reaalselt olemasolevad locale-id
- `payload`: core payload puudub; blocker-only handoff, mitte collectable translation bundle
- `verified: BLOCKED -- ...` koos lühikeste tõenditega
- `instructions`: lisada nested-source freshness-side, otsustada/ehitada 32-locale UI arhitektuur, siis käivitada uuesti translation ja alles seejärel `eee`

README-digeste, kataloogide või UI-localesid ei fabritseerita. `READY/*.json` ei looda, sest `eee` ei tohi blokeeritud või mittetäielikku tulemust integreerida.

## 4. Sulge töö ausalt

- Valideerin OUTBOX-i olemasoleva closed parseriga ning namespace testiga.
- Blockin Core ticketi `T-47` täpse blockeriga; Core STATE `next_action` osutab samale recovery-punktile.
- Ei muuda ZAICODE UI-d, outer tracked produkte ega nested `zcode/` source-trees.

## Kootus

Pole uut UI nuput, uut translatsioonidepset ega teist paralleelarhitektuuri. Engine bootstrap-patchi tehakse alles korduva `ee`/bare-role kasutuse korral; käesolev command saab selle ühe kanonikalise runtime’i ja ausa blocked tõendiga kinni.