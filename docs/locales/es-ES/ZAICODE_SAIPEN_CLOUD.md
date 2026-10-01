# ZAICODE: transporte en la nube de SAIPEN

Cómo este checkout y una sesión de Claude Code Cloud ejecutan un espacio de trabajo
SAIPEN con distinta localidad de ejecutor, y dónde está el límite entre ambos.

## La forma

```
  local machine                                  Claude Code Cloud
  ────────────                                   ─────────────────
  ZAICODE checkout                               ephemeral checkout
  branch saipen-live                             branch saipen-live
       │                                                │
       └────────── origin/saipen-live ─────────────────┘
                        (github.com/vacterro/zaicode)
```

Una rama transporta el estado del protocolo. No hay paso de merge, ni de rebase,
ni una segunda rama local que mantener sincronizada: el ejecutor que tenga un
checkpoint verificado lo confirma y lo sube, y el otro lado lo toma con un
fast-forward.

`master` es el historial previo al transporte y la rama publicada por defecto. El
transporte no la actualiza con force.

## Qué viaja y qué no

Un checkpoint de este repositorio transporta el estado del protocolo SAIPEN, el
lanzador raíz, el instalador, la documentación y estos scripts de transporte. Esa es
toda la capa de espacio de trabajo.

Transporta **ningún byte de producto**. `zcode/` es un repositorio Git aparte, listado
en `.saipen/source-nested-repos.json` y con gitignore en esta raíz
(`/zcode/`). El trabajo de producto necesita su propio clon de `vacterro/zaicode` en la rama
`zaicode`, y ese clon es un segundo objeto independiente con su propio historial.

La consecuencia es fácil de confundir: un `git status` limpio en esta raíz no dice
nada del trabajo de producto sin confirmar, y un fast-forward de `saipen-live` no dice
nada del código de producto. Comprueba `git -C zcode status` explícitamente.

## Mitad local

Dos scripts, ambos propiedad del repo, para que una máquina nueva los obtenga del
repositorio y no de la memoria:

| Archivo | Rol |
|------|------|
| `tools/saipen-cloud/Install-SaipenLiveSync.ps1` | valida, reconcilia la rama, instala e inicia el watcher, escribe la entrada de autoinicio, demuestra local == remoto |
| `tools/saipen-cloud/ZaicodeSaipenLiveWatcher.ps1` | el bucle: fetch, comparar, fast-forward o push, registro, pausa; después la pasada de producto y la autoupdate |
| `tools/saipen-cloud/Test-SaipenLiveSync.ps1` | round-trip desde un ejecutor independiente más prueba de recuperación en frío |
| `tools/saipen-cloud/Test-ProductSync.ps1` | pasada de producto y autoupdate contra repositorios Git desechables (sin red, sin remoto real) |

Instalación y reparación:

```
powershell.exe -File tools\saipen-cloud\Install-SaipenLiveSync.ps1
```

Es idempotente. El estado local de la máquina vive en `%APPDATA%\SAIPEN`:
`ZaicodeSaipenLiveWatcher.ps1` (una copia), `ZAICODE_cloud-sync.log` (rotado a
2 MB en `.log.1`), `ZAICODE_cloud-sync.lock` (instancia única),
`ZAICODE_cloud-sync.pid` y una entrada en la carpeta Inicio
`SAIPEN-ZAICODE-Cloud-Sync.cmd`.

El instalador rechaza un árbol sucio y nunca lo limpia. Si todas las rutas sucias son
estado canónico de SAIPEN bajo `.saipen/`, lo dice e imprime los comandos
exactos de checkpoint; eso es un estado de protocolo sin checkpoint, no un fallo
de transporte, y el instalador no lo commiteará a espaldas del protocolo.

## Comportamiento del watcher

| Situación | Movimiento |
|-----------|------|
| limpio, local es ancestro de remoto | `git merge --ff-only` |
| limpio, remoto es ancestro de local | `git push` |
| sucio | pausa; ni siquiera hace fetch |
| en otra rama | pausa |
| ambos avanzados, sin ancestro común | pausa, registra ambos commit ids, no fusiona nada |
| fetch o red falló | registra degradado, reintenta en el siguiente tick |
| hay un merge/rebase/cherry-pick en curso | pausa |

Nunca: force push, hard reset, stash, clean, checkout de una rama ajena,
commit ni parada por nombre de proceso. El instalador detiene un watcher solo por el
pid que registró en su propio fichero pid.

Un árbol sucio no cuesta nada, porque el watcher comprueba el estado sucio antes de
hacer fetch. Un checkout inactivo, por tanto, no hace ninguna llamada de red.

### Pasada de producto (T-90)

`zcode/` es su propio repositorio, así que la tabla anterior nunca mueve código
de producto. Después, el mismo tick gestiona el checkout de producto (`-ProductRepo`,
por defecto `<repo>\zcode`; rama `-ProductBranch`, por defecto `zaicode`). La
pasada de producto se ejecute haya estado sucio o no el árbol exterior. Solo hace pull.

| Situación | Movimiento |
|-----------|------|
| remoto por delante, ningún archivo entrante modificado aquí | `git merge --ff-only`; el trabajo de producto sin commitear se queda como está |
| remoto por delante, algún archivo entrante modificado aquí | RETENIDO: registra los archivos, no merges nada |
| local por delante | registra; **nunca subir** (el producto lo publica SAIPEN SHIP) |
| divergido | pausa, registra ambos ids, no merges nada |
| otra rama, una operación de git en curso, fetch fallido | pausa |
| sin checkout de `zcode/`, o `-NoProduct` | omitido |

git rechaza por sí mismo un fast-forward que sobrescribiría un cambio local, así
que la comprobación RETENIDO es una guarda anterior y más clara, no la única. Un
fast-forward del producto no reconstruye nada: para probar, ejecuta `pnpm bundle:zaicode` (o
la vista previa de desarrollo).

### Autoupdate (T-90)

El watcher se ejecuta como una copia bajo `%APPDATA%\SAIPEN`, así que un watcher más
nuevo del repositorio nunca se ejecutaba sin reinstalar. En modo bucle ahora
compara su propio archivo con la copia confirmada del repositorio en cada pasada.
Instala esa copia sobre sí mismo y se reinicia exactamente una vez, con los mismos
argumentos, solo cuando se cumple todo lo siguiente:

- los dos archivos son distintos;
- la copia del repositorio no tiene ediciones sin commitear;
- la copia del repositorio se analiza sin errores.

Una copia que no se analiza se rechaza y se registra, y el watcher en ejecución
sigue adelante.

Los watchers instalados antes de T-90 carecen de la pasada de producto y del
autoupdate. Reejecuta `Install-SaipenLiveSync.ps1` una vez en una máquina así; a partir de ahí, el
watcher se actualiza solo.

## Parte cloud

`CLAUDE.md` en la raíz es la regla de entrada y
`.claude/skills/saipen/SKILL.md` es el procedimiento de ejecución. La skill obtiene el kernel de
SAIPEN desde `github.com/vacterro/saipen` y lo ejecuta a través de la superficie de motor
declarada `tools/saipen.py`. El kernel está fijado por commit
(`3088eff`), nunca por etiqueta. La etiqueta `v8.0.1` es un kernel más antiguo con el mismo
`VERSION`; su `validate` muta el estado, y su validador rechaza este board.

`STATE.saipen_home` registra la ruta del kernel del último executor que hizo checkpoint.
En la nube, el primer `saipen continue` sobre el kernel `3088eff` lo converge al kernel
en ejecución como un único `DEC` registrado en el journal (E-1410). En la máquina
del operador el puntero llega muerto del mismo modo. Un kernel con convergencia
automática lo repara en `continue`; si no, ejecuta
`saipen rebind-home --auto`.

**Se observa el viaje de vuelta.** E-1562 (nube) convergió el puntero a `/home/user/zaicode/.claude/saipen-protocol`; E-1571 (máquina del operador) lo convergió de vuelta directamente a `V:/.../_SAIPEN`, automáticamente, sin ningún `rebind-home` manual. Ambas direcciones son la misma convergencia automática, así que espera un `saipen_home` `DEC` por cambio de localidad y trátalo como ruido esperado, no como un defecto. Sigue siendo ruido hasta que P1-2 (`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`) saque el puntero del estado versionado; no implementes P1-2 como efecto secundario de detectarlo. Nunca edites el puntero a mano.

`STATE.saipen_home` puede apuntar a un **checkout de desarrollo** del kernel más avanzado que el pin, no a un clon `3088eff` limpio: en la máquina del operador es la rama `accepted-debt-rebind` con trabajo sin confirmar. Un kernel que no está en el commit fijado no es incorrecto automáticamente, pero tampoco es una fuente clean-room, así que la regla de abajo sobre el contrato de voz se le aplica con toda su fuerza. Nunca hagas commit, stash, reset, checkout ni clean en un checkout de ese tipo; la única excepción permitida es restaurar de forma dirigida un solo archivo `saipen/STYLE.md`, y solo cuando el operador lo haya pedido.

### STYLE.md no es un ajuste local

`saipen/STYLE.md` debe ser **idéntico byte a byte al archivo del kernel fijado** en cada máquina, en cada copia, sin excepciones ni ediciones locales. En una máquina del operador hay más de una copia:

- el checkout del kernel en `STATE.saipen_home` (un clon de Git; en la máquina del operador, un checkout de desarrollo);
- `%LOCALAPPDATA%\saipen\scheduled-source\saipen\STYLE.md`, poblado por la tarea programada `saipen-inject` (`bootstrap/schedule-run.ps1`). **No es un
  repositorio de Git**, así que `git checkout` nunca podrá repararlo: la única vía es
  resincronizar a través del inyector o escribir directamente el contenido publicado.

El token `style_contract` en `.saipen/STATE.md` es un hash del texto de ese archivo (`tools/validate.py`,
`style_contract_token`: CRLF normalizado, excluida la línea `style_contract:`). Edita `reply_language` en
una copia y el token se mueve; la otra copia y la nube, que descargan el kernel
publicado, conservan el token publicado, y toda escritura de la CLI en el lado que no
coincide se rechaza con `style_contract ... does not match the installed STYLE.md marker`.
Ese es todo el fallo: el lado local escribe un estado que la nube no puede escribir.

**Cambiar el idioma de las respuestas es un commit del kernel más un repin**, nunca una
edición local. Cámbialo en el repositorio del kernel, publícalo, vuelve a fijar el commit
en SKILL.md y actualiza `STATE.style_contract` a través de `saipen recover`. Una edición local de
`STYLE.md` desincroniza todas las máquinas que no sean la que la hace.

Una trampa que conviene nombrar: el `bin/saipen` publicado es un shim ligado a una máquina
que tiene fijadas las rutas absolutas del intérprete y del checkout de un operador. Se ejecuta
en exactamente una máquina. La nube debe usar `python3 tools/saipen.py`.

Atajos: `cc` continúa el Work actual; `cc all <text>` ingiere el mensaje completo
como source/appends y continúa todos los Work elegibles. Ninguno pide confirmación
rutinaria.

## Clasificación de capacidades

**AVAILABLE_IN_CLOUD** — estado del protocolo y la capa de espacio de trabajo. Leer y
escribir `.saipen/`, el launcher (`tools/launcher/ZaicodeLauncher.cs`), el
instalador bajo `install/`, `docs/`, `CLAUDE.md`, `.claude/skills/` y los
scripts de transporte. Lectura, commit, push y fetch de Git en `saipen-live`. Cualquier
gate que sea una aserción de fichero, revisión de diff o comprobación de texto.

**LOCAL_WINDOWS_ONLY** — los gates que necesitan este equipo.

| Gate | Por qué |
|------|-----|
| `tools\launcher\build.cmd` | compila `ZaicodeLauncher.cs` con .NET Framework `csc`; sin Windows SDK en imagen cloud |
| E2E de Electron empaquetado (`zcode` desktop, Solo → queue → dispatch) | necesita sesión de escritorio y un perfil de proveedor sembrado |
| el 9router en vivo | un servicio de Windows en este equipo |
| recorrido interactivo de escritorio | una persona y una pantalla |
| los casos de runtime del watcher | el watcher solo se ejecuta en el equipo con el checkout |

Estos se registran como límites de aceptación solo locales. Nunca se
reportan como superados porque el diff pareciera correcto.

**SAFE_TO_DEFER** — la capa de producto. Una sesión en la nube puede clonar
`vacterro/zaicode` la rama `zaicode` y trabajar allí. El trabajo de la capa de espacio
de trabajo no exige trabajo de producto, pero sí exige el clon:
`.saipen/source-nested-repos.json` declara `zcode/` y sin él el
validador falla con `source freshness computation BLOCKED -- declared nested
repository is missing: 'zcode'`. Los gates de `pnpm` necesitan el pnpm 10.33.2 fijado
y un espacio de trabajo preparado. `pnpm bootstrap` en una imagen de la nube nueva es
la vía de entrada documentada, y el `package.json` del producto ya lo declara.

La nube solo puede verificar bytes de producto que estén en `origin/zaicode`. Un
delta de producto que existe solo en el checkout del operador (`zcode/`) es
invisible aquí, así que todos sus gates de producto quedan NOT RUN en la nube, sea
cual sea el gate. T-84 es el primer caso (E-1411): su corrección era solo local mientras
`origin/zaicode` aún llevaba el código previo.

**UNSAFE_TO_EMULATE** — cualquier cosa que haga pasar por verde un gate solo local.
No.stubbar la build del launcher, no simular una ejecución de app empaquetada, no
reproducir un resultado registrado de `pnpm verify:pre-push` como si se acabara de ejecutar, ni
convertir "el código parece correcto" en una línea PASS en `.saipen/LOG.md`.

**KNOWN_CLOUD_DIVERGENCE** — conformidad que depende de dónde vive el
checkout. En el kernel `3088eff` el validador de nube informa `closure-evidence`
FALLOS (T-47, T-62, T-76, T-78 en el momento de escribir) que la máquina
del operador no.

El kernel mueve cualquier evento LOG de más de 1024 bytes a un
sidecar `.saipen/recovery/log-detail/`. Al leer, restaura el sidecar solo
cuando la ruta absoluta del checkout coincide con la ruta desde la que se escribió. Un
veredicto VERIFY largo escrito en Windows es por tanto ilegible en la nube, y a la
inversa también.

El defecto está en el kernel y está registrado como P1-1 en
`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`. Hasta que llegue:

- cita el veredicto de la nube y clasifícalo como este límite, ticket a ticket
  (`SKILL.md` § 6 contiene la comprobación);
- nunca reescribas sidecars, no re-verifiques solo para poner en verde ni parchees la copia
  del kernel;
- mantén los eventos de LOG por debajo de 1024 bytes en ambos lados.

El mismo enlace a la ruta de la máquina también bloquea el trabajo. La línea base de deuda previa a BUILD
se captura la primera vez que un ticket entra en BUILD y se vuelve a comprobar en cada entrada
posterior. Por tanto, un ticket que entró en BUILD por primera vez en la máquina del operador no
puede entrar en BUILD en la nube: la transición se rechaza con
`DEBT_SNAPSHOT_FOREIGN_PROJECT`. T-84 es el caso registrado: DEBT-000079 se capturó en E-1377 y la transición se rechazó en E-1446. Deja esos tickets
en la máquina que capturó su línea base.

## Divergencia

Si local y remoto dejan de compartir un ancestro, el watcher se detiene. No
hace merge, rebase ni force. Ambos ids de commit van al log, la corrección se
hace `git log --left-right --cherry-pick <branch>...origin/<branch>` a mano y
el resultado se marca como checkpoint igual que cualquier otro cambio.

## La acción exacta en el lado de la nube

### Script de configuración del entorno (una vez, en los ajustes del entorno en la nube)

Menú del entorno en la nube en la barra de título de la sesión -> Edit -> Setup script. Se
ejecuta antes de cada sesión nueva, así que cada sesión arranca con el toolchain del producto
listo:

```bash
#!/usr/bin/env bash
# ZAICODE cloud toolchain: Node 24 + pnpm 10.33.2 (product gates),
# 9router 0.5.91 (real-router tests), mono mcs (launcher compile check).
set -u
NODE=v24.14.0
if ! command -v node >/dev/null || ! node -v | grep -q '^v24\.'; then
  curl -fsSL "https://nodejs.org/dist/$NODE/node-$NODE-linux-x64.tar.xz" | tar -xJ -C /opt
  ln -sf /opt/node-$NODE-linux-x64/bin/node /opt/node-$NODE-linux-x64/bin/npm /opt/node-$NODE-linux-x64/bin/npx /usr/local/bin/
fi
npm install -g pnpm@10.33.2 && ln -sf "$(npm prefix -g)/bin/pnpm" /usr/local/bin/pnpm
mkdir -p /opt/9router && cd /opt/9router && npm pack 9router@0.5.91 >/dev/null && tar -xzf 9router-0.5.91.tgz
(apt-get update -qq && apt-get install -y -qq mono-mcs) || echo "no mono-mcs: the launcher compile check is NOT RUN"
exit 0
```

### El prompt para cada sesión nueva

Inicia la sesión en el repositorio `vacterro/zaicode`, rama `saipen-live`, y
asegúrate de que el agente de la máquina del operador no esté escribiendo a la vez.
Sustituye la última línea por `cc all <new list>` para traspasar trabajo nuevo.

```
Read CLAUDE.md and .claude/skills/saipen/SKILL.md, then cold-recover SAIPEN
state from .saipen/ on branch saipen-live (STATE.md, BOARD.md, tail of LOG.md).
Chat memory is not state; docs/ZAICODE_SAIPEN_CLOUD.md is the transport contract.

Setup (skip what already exists):
- saipen = python3 .claude/saipen-protocol/tools/saipen.py --project-root <repo root>
  (fetch the kernel per SKILL.md if it is missing); run `saipen rebind-home --auto`
  when saipen_home points at another machine.
- Product clone: git clone -b zaicode https://github.com/vacterro/zaicode zcode
  (gitignored here), then `pnpm install` inside zcode (Node 24, pnpm 10.33.2).
- Real-router tests: export ZAICODE_ROUTER_PACKAGE=/opt/9router/package if it exists.

Rules:
- Fetch origin/saipen-live and origin/zaicode before every commit and every push.
  If the other side moved, merge; never rebase, reset or force. If .saipen/
  histories diverged: keep ours on saipen-live-cloud-<sha>, write both ids to
  .saipen/LOG.md, stop and ask me.
- Product gates in zcode: pnpm typecheck, pnpm lint (0 errors),
  pnpm run architecture:check -- --changed, pnpm test. A gate that cannot run
  here is NOT RUN with the reason; a failure blamed on the environment must be
  shown to fail the same without the change.
- I authorize publishing verified product commits to origin/zaicode and SAIPEN
  checkpoints to origin/saipen-live.
- Nothing is PASS until I test on Windows and say PASS. A finished ticket waits
  in VERIFY with .saipen/evidence/T-###-*.md: its commits and the exact manual
  test steps.
- One writer at a time: if LOG shows the local agent mid-work, stop and ask.

cc
```

En la máquina del operador el watcher hace fast-forward de `zcode` desde
`origin/zaicode`; `REBUILD.cmd` (o `REBUILD_fast.lnk`) lo compila, y el
siguiente arranque de ZAICODE cambia la compilación nueva.

<!-- source-digest: docs/ZAICODE_SAIPEN_CLOUD.md sha256:61273984b2a765f6 -->
