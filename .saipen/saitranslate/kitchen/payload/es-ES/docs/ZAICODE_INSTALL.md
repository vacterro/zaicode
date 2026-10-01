# Instalar ZAICODE

ZAICODE son tres proyectos que funcionan como uno: la app ZAICODE, SAIPEN (el
protocolo que mantiene el trabajo de los agentes en camino) y SAIMAIL (el
correo que los agentes usan para contarse cosas). Instalarlos a mano significa tres clones,
un toolchain de Node.js, un entorno de Python y una compilación. El instalador lo hace todo:
Ejecutalo, espera y ya tienes un acceso directo a ZAICODE en el escritorio.

## Un clic

- **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**:
  descarga, haz doble clic, pulsa **INSTALL**. La ventana (dorado sobre fondo oscuro, el
  banner de SAIPEN) muestra cada paso mientras se ejecuta, el tiempo transcurrido y el log
  bajo demanda; al final **START ZAICODE**, o **TRY AGAIN** / **Autotroubleshoot**
  / **Open log** cuando un paso no terminó. Si apunta a una carpeta ZAICODE existente, el botón dice **UPDATE**: la misma ejecución actualiza y repara. El
  exe lleva los scripts de instalación y no necesita nada al lado; lo compila
  `install\setup\build.cmd` (el compilador de .NET Framework que tiene todo Windows 10/11).
- `install\Setup-ZAICODE.cmd` (doble clic): la misma instalación en consola.
- Desde cero, en PowerShell:

  ```powershell
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/vacterro/zaicode/master/install/Install-ZAICODE.ps1)))
  ```

Opciones de instalación: `ZAICODE-Setup.exe -InstallDir D:\ZAICODE` (carpeta predefinida),
`/auto` (empieza de inmediato), `/quiet` (sin ventana: el instalador de consola, el código de salida
= resultado). La primera ejecución compila la app en esta máquina, lo que tarda;
las siguientes solo actualizan y reparan.

## Modelos gratuitos, nada que configurar

La app incluye su propio 9router. En una máquina sin él, ZAICODE lo ejecuta de
forma privada (modo aislado, puerto 20138), rellena **SAIFREN** con los planes
gratuitos sin clave y pone `SAIRoute / SAIFREN` como modelo de las tareas nuevas, así
que la primera tarea escrita en Nueva tarea obtiene respuesta: sin clave, sin
cuenta, sin ajustes. Los inicios de sesión de Claude Code, Codex y Antigravity
son opcionales; un inicio de sesión no configurado en la máquina aparece como
«opcional, inicia sesión cuando quieras», no como un elemento «te necesita».
Prueba: `node packages/desktop/scripts/verify-zaicode-free.cjs <ZAICODE.exe>`
inicia la app empaquetada con un perfil vacío (su propio HOME, APPDATA y
LOCALAPPDATA) y solo pasa cuando el router está aislado, SAIFREN responde a su
sonda de primer token y una tarea en Nueva tarea obtiene respuesta.

## Actualizaciones: cuatro partes, un ZAICODE

El espacio de trabajo (lanzador, instalador), la app, SAIPEN y SAIMAIL son
cuatro clones. Cada uno se actualiza por su cuenta: **Ajustes -> ZAICODE ->
Actualizaciones** los lista con su versión y commit, actualiza uno a uno o todos,
y tiene un interruptor «automático» por parte (activado por defecto en un ZAICODE
instalado, desactivado en una copia de desarrollo). ZAICODE comprueba unos minutos
después del arranque y luego cada seis horas. Tras una actualización cada parte
recibe lo que necesita: la app sus dependencias (cuando `pnpm-lock.yaml` cambió) y una
compilación nueva (preparada mientras ZAICODE se ejecuta, iniciada en el siguiente
arranque), SAIPEN su lanzador, SAIMAIL su instalación `.venv`, el espacio de
trabajo un nuevo lanzador raíz. Un clon en otra rama, con commits locales o con
cambios que la actualización sobrescribiría se informa y se deja exactamente como
está.

```powershell
.\install\Update-ZAICODE.ps1                          # everything
.\install\Update-ZAICODE.ps1 -Component saipen        # one part (or "app,saimail")
.\install\Update-ZAICODE.ps1 -Check                   # what is new, change nothing
.\install\Update-ZAICODE.ps1 -Check -Json             # the same for a program
```

## Qué hace

El instalador son las comprobaciones de Autotroubleshoot ejecutadas con «repair»
en una carpeta vacía, en este orden. Cada paso es idempotente, así que volver a
ejecutarlo actualiza la instalación y arregla lo que se rompió.

| Comprobación | Reparación |
| ---- | ---- |
| Git, Node.js 24, Python 3.11+ | usa la copia de la máquina cuando encaja; si no, una copia privada en `.tools\` (MinGit de Git for Windows, Node.js 24.14.0 de nodejs.org, Python de su paquete NuGet). Sin derechos de administrador. |
| pnpm | el pnpm 10.33.2 fijado en `.tools\pnpm10` |
| Espacio de trabajo de ZAICODE | clon de `vacterro/zaicode` rama `master` (código del lanzador, instalador, documentación; la memoria `.saipen/` del desarrollador se excluye; rama `workspace` hasta 2026-09-27) |
| Código fuente de la app de ZAICODE | clon de la rama `zaicode` en `zcode\` |
| SAIPEN | clon de `vacterro/saipen` en `saipen\`; su `bin\saipen.cmd` se escribe para este clon y este Python |
| SAIMAIL | clon de `vacterro/saimail` en `saimail\`, instalado en `.venv\` |
| saimail-local | cliente de línea de comandos de SAIMAIL, que usan los paneles de SAIMAIL de ZAICODE (incluido desde SAIMAIL `0.0.2a3`; la comprobación `saimail-cli` informa OK) |
| paquete 9router | `9router` desde npm en `.tools\router`, empaquetado para que SAIFREN funcione sin configuración (WARN si npm no puede acceder) |
| Dependencias de la app | `pnpm install --frozen-lockfile` (de nuevo cuando `pnpm-lock.yaml` cambia) |
| Compilación de la app | `pnpm bundle:zaicode`; mientras ZAICODE se ejecuta, la nueva compilación se prepara y se intercambia en el siguiente arranque |
| Intercambio de compilación preparada | limpia una `win-unpacked.previous` que dejó un fallo de intercambio por ruta larga e intercambia una compilación en espera mientras ZAICODE está cerrado |
| Lanzador raíz | `tools\launcher\build.cmd` -> `ZAICODE.exe` |
| Accesos directos | Escritorio y menú Inicio `ZAICODE` -> `ZAICODE.exe` |
| Inicios de sesión de Claude / Codex | solo se informa: cada inicio de sesión `~\.claude*` / `~\.codex*` es su propio motor en ZAICODE (A1, A2, C1, ...); un inicio de sesión te necesita, en el navegador |

El lanzador raíz apunta ZAICODE al SAIPEN instalado (`saipen\`) y pone
`.tools\` y `.venv\Scripts` al principio del PATH de la app, para que la app, sus
agentes y sus workers usen las copias instaladas.

## Varias suscripciones

Cada inicio de sesión de Claude Code o Codex vive en su propio home: `~\.claude`,
`~\.claude-account2`, ... y `~\.codex`, `~\.codex-account2`, ... ZAICODE los
encuentra todos. Para preparar más en la instalación:

```powershell
.\install\Install-ZAICODE.ps1 -AddClaudeAccounts 1 -AddCodexAccounts 2
```

El instalador crea los homes e imprime el comando exacto de inicio de sesión para cada
uno (`$env:CODEX_HOME = '...'; codex login`). Lo mismo en ZAICODE: Configuración ->
Engines & limits -> añadir otro inicio de sesión.

## Autodiagnóstico

```powershell
.\install\ZAICODE-Doctor.ps1            # check only; exit 1 while something fails
.\install\ZAICODE-Doctor.ps1 -Repair    # check and repair (install\Doctor.cmd)
.\install\ZAICODE-Doctor.ps1 -Json      # results as JSON
.\install\ZAICODE-Doctor.ps1 -Repair -Only app,launcher
```

Estado por comprobación: OK, FIXED (roto, reparado), WARN (funciona, pero falta algo
opcional), INFO (te necesita: un inicio de sesión), FAIL. Logs en
`install\logs\`; el resumen de la última instalación es `install\install-report.json`.
En la app, Router -> Autodiagnóstico repara el router y los pools en marcha.

## Opciones

| Parámetro | Predeterminado | |
| ---- | ---- | ---- |
| `-InstallDir` | `%USERPROFILE%\ZAICODE` | dónde va todo |
| `-ShortcutDir` | Desktop | dónde va el acceso directo de ZAICODE |
| `-NoStartMenu`, `-NoShortcut` | | omite esos accesos directos |
| `-PortableTools` | | Git / Node.js / Python privados aunque el equipo ya los tenga |
| `-Launch` | | inicia ZAICODE al terminar |
| `-ZaicodeRepo`, `-SaipenRepo`, `-SaimailRepo` | los repos de GitHub | otra fuente (un fork, una ruta de clonación local) |

## Prueba

`install\tests\Test-ZaicodeInstall.ps1 -InstallDir <dir> -ShortcutDir <dir> -Smoke`
comprueba una instalación limpia, siembra fallos (acceso directo y lanzador borrados, lanzador de
SAIPEN apuntando a un Python inexistente, venv de SAIMAIL borrado, node_modules
registrado para otro lockfile, una carpeta de build residual más profunda que MAX_PATH),
verifica que el doctor informa y repara cada uno, luego arranca el destino del acceso
directo con un perfil aislado y detiene exactamente el árbol de procesos que inició.

`install\tests\Test-ZaicodeUpdate.ps1` construye cuatro repos desechables en
disco y una instalación de sus clones, luego demuestra que una comprobación no cambia nada,
que una sola pieza se actualiza sola con su seguimiento (lanzador de SAIPEN, lanzador
raíz), que los cambios locales solapados y los commits locales se conservan, y que un
nombre de pieza desconocido se rechaza. Sin red.

<!-- source-digest: docs/ZAICODE_INSTALL.md sha256:7ff9a25bab155f2c -->
