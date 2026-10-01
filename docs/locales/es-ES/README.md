# ZAICODE

**v0.0.2**

<div align="center">
  <img src="https://raw.githubusercontent.com/vacterro/zaicode/zaicode/packages/ui/src/assets/zaicode-working.png" alt="ZAICODE" width="96" height="96" />
</div>
<p align="center">
  <img src="https://img.shields.io/badge/version-0.0.2-c9a227" alt="version 0.0.2" />
  <img src="https://img.shields.io/badge/platform-Windows-3b3527" alt="Windows" />
  <img src="https://img.shields.io/badge/license-Apache--2.0-3b3527" alt="Apache-2.0" />
</p>
<p align="center">
  ZAICODE · <a href="https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md">ZCode (简体中文)</a> · <a href="https://github.com/vacterro/zaicode/blob/zaicode/README.en.md">ZCode (English)</a>
</p>

<img width="1440" height="860" alt="ZAICODE hero — Do your best." src="../../screenshots/01-do-your-best.png" />

ZAICODE es un banco de trabajo para operar muchos agentes de programación con IA a la vez sobre
muchos proyectos, sin tener que vigilarlos. Es una compilación modificada de
[ZCode](https://github.com/zai-org/ZCode) (app de escritorio, interfaz en el navegador y
CLI de agentes) con una capa de producto encima: cada proyecto se gestiona con el
protocolo [SAIPEN](https://github.com/vacterro/saipen), el trabajo se inicia, se continúa
y se programa desde una sola ventana, y las CLI de suscripción que ya pagas
(Claude Code, Codex, Antigravity) se ejecutan como trabajadores acoplados junto a los agentes
integrados.

**0.0.1** es la primera instantánea etiquetada: una compilación personal, pensada primero para Windows y
usada a diario.

## Instalar con un clic

1. Descarga **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**.
2. Haz doble clic y pulsa **INSTALAR**.

Eso es todo. El instalador aporta lo que falte en el equipo (Git, Node.js, Python, como copias privadas: sin permisos de administrador), descarga ZAICODE, SAIPEN y SAIMAIL de GitHub, compila la app en el equipo y crea un acceso directo a ZAICODE en el escritorio. La primera
ejecución tarda 15-30 minutos; la ventana muestra cada paso.

Los modelos gratuitos funcionan de inmediato: ZAICODE arranca su propio router y rellena el grupo **SAIFREN**
con niveles gratuitos sin clave, así que una tarea escrita en Nueva tarea obtiene respuesta sin
clave, sin cuenta y sin configuración. Las suscripciones de Claude Code, Codex y Antigravity son
opcionales y puedes iniciar sesión cuando quieras.

**Una unidad, cuatro partes.** El espacio de trabajo (lanzador, instalador), la app, SAIPEN y
SAIMAIL son cuatro repositorios. Cada uno se actualiza por su cuenta: *Ajustes -> ZAICODE ->
Actualizaciones* muestra todas las partes, actualiza cada una a mano o de forma automática (se comprueba
unos minutos después del arranque y cada seis horas). Una nueva compilación de la app se prepara
mientras ZAICODE se ejecuta y arranca en el siguiente inicio; tus propias ediciones en un
clon nunca se sobrescriben.
Desde una terminal: `install\Update-ZAICODE.ps1 [-Component saipen] [-Check]`.
Autodiagnóstico: `install\Doctor.cmd`. Detalles: [docs/ZAICODE_INSTALL.md](ZAICODE_INSTALL.md).

## Recorrido por la interfaz

<table>
  <tr>
    <td width="50%" valign="top">
      <strong>SAIHOME</strong><br />
      The operator dashboard: quotas, health, projects, streaks, activity, and the live clock in one place.<br /><br />
      <img src="../../screenshots/02-saihome-dashboard.png" alt="SAIHOME dashboard" />
    </td>
    <td width="50%" valign="top">
      <strong>Agents &amp; tasks</strong><br />
      Create roles, inspect queues, and see what is idle, running, finished, or waiting for you.<br /><br />
      <img src="../../screenshots/03-agents-and-tasks.png" alt="Agents and tasks" />
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>Scheduler</strong><br />
      Arm quota-aware autonomous runs and recurring prompts across one project or a whole sidebar section.<br /><br />
      <img src="../../screenshots/04-scheduler.png" alt="Scheduler" />
    </td>
    <td width="50%" valign="top">
      <strong>Audits</strong><br />
      Run Quick 3 Waves audits, watch progress live, and jump straight to reports when something stops.<br /><br />
      <img src="../../screenshots/05-audits.png" alt="Audits" />
    </td>
  </tr>
  <tr>
    <td colspan="2" valign="top">
      <strong>Active session</strong><br />
      The full working view: transcript, branch, prompt composer, state inspector, board, and backlog at the same time.<br /><br />
      <img src="../../screenshots/06-active-session.png" alt="Active session" />
    </td>
  </tr>
</table>

## Qué añade a ZCode

- **Proyectos con una sesión MAIN.** Cada proyecto tiene una sesión MAIN (START,
  `/goal cc all`) y sesiones auxiliares (subSaipens: WIKI, TEST, AUDIT, …). La
  vista predeterminada de la barra lateral muestra la fila del proyecto como
  su MAIN; ▶ continúa MAIN en lugar de abrir otra sesión. CONTINUE ALL, DONE y
  CLEAR ALL DONE recorren todos los proyectos; una sesión cortada a mitad de
  turno muestra INTERRUPTED, nunca DONE.
- **Seguridad ante fallos.** Las sesiones que un proceso muerto cortó y los
  objetivos aún activos continúan solos tras reiniciar; los workers en ejecución
  arrancan de nuevo. Los agentes dentro de ZAICODE no pueden matar a ZAICODE
  por nombre de proceso.
- **Workers.** Las CLI de suscripción se ejecutan en terminales anclados a
  cualquier borde de la ventana (o en sus propias ventanas con imán). Las
  preguntas «¿Confías en esta carpeta?» del primer inicio se responden; un worker
  que alcanza su límite de uso se informa y, según la configuración, se cierra o
  se reinicia tras el reinicio de cuota.
- **Límites y reinicios.** Medidores de cuota por cuenta y por pool, un
  temporizador en la barra de título para el reinicio más cercano con la lista
  completa de próximos reinicios al pasar el ratón.
- **SCHEDULER.** Prompts que arrancan solos: a una hora, a diario, cada N
  minutos o cuando se rellena una ventana de cuota; en un proyecto o en toda una
  sección de la barra lateral, primero los peores proyectos (más bloqueados /
  tickets SAIPEN abiertos). Las condiciones pueden detener primero el trabajo
  provisional (sesiones de pool gratuito, workers más débiles), ejecutarse solo
  en proyectos inactivos o continuar solo sesiones marcadas. Los prompts no
  tienen límite práctico de longitud.
- **Enrutado.** Un 9router incluido (MIT) ofrece pools sin configuración: SAIFREN
  (niveles gratuitos sin clave) y SAIOPP (tus suscripciones).
- **SAIHOME, temporizadores, sonidos, resaltados.** Un panel de inicio de
  operador con estadísticas, temporizadores y alarmas estilo FastPrompter,
  sonidos por acción y una interfaz oscura dorada Win95, nítida a nivel de píxel.

## Compilación

Requisitos: Windows 10/11, Git, Node.js **24.14.0**, pnpm **10.33.2**
([mise.toml](https://github.com/vacterro/zaicode/blob/zaicode/mise.toml) es la fuente de verdad).

```bash
pnpm bootstrap
pnpm bundle:zaicode          # -> packages/desktop/dist/win-unpacked/ZAICODE.exe
```

La app empaquetada siempre arranca en modo ZAICODE. Mientras se ejecuta un
ZAICODE anterior, el bundler prepara la nueva compilación en `packages/desktop/dist-next`; el
launcher raíz (rama `master`, `tools/launcher`) la activa en el siguiente
inicio. La variante Verdana bitmap nítida que usa la interfaz no forma parte de
este repositorio; sin ella, la interfaz recurre a la Verdana del sistema.

Comprobaciones: `pnpm typecheck`, `pnpm lint` y las pruebas de ZAICODE, por ejemplo
`node --import tsx --test test/zaicode*.test.ts` desde `packages/ui`.

## Estructura del repositorio

| Rama        | Contenido                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `master`    | el espacio de trabajo canónico: launcher, instalador (`install/`), documentación del producto (`UI.md`, `docs/`), estado de SAIPEN y CHANGELOG |
| `zaicode`   | el código fuente canónico de la app: historial de ZCode upstream más la capa de producto ZAICODE usada para compilaciones y actualizaciones |

Las referencias heredadas o creadas por automatización aún pueden aparecer
temporalmente, pero no son ramas canónicas del producto. El trabajo nuevo del
espacio de trabajo va en `master`; el trabajo sobre el código de la app va
en `zaicode`.

El código de la app propiedad de ZAICODE vive sobre todo en `packages/ui/src/zaicode/`,
`packages/shared/src/zaicode-*.ts`, `packages/services/src/zaicode/` y
`packages/desktop/src/main/zaicode*.ts` de la rama `zaicode`. La documentación
del espacio de trabajo y las herramientas de launcher/update viven en `master`.

## Upstream y licencia

ZAICODE deriva de ZCode de Z.ai y se distribuye bajo la misma
[Licencia Apache 2.0](https://github.com/vacterro/zaicode/blob/zaicode/LICENSE); los avisos del upstream se conservan en
[NOTICE.md](https://github.com/vacterro/zaicode/blob/zaicode/NOTICE.md) y [THIRD-PARTY-NOTICES.md](https://github.com/vacterro/zaicode/blob/zaicode/THIRD-PARTY-NOTICES.md).
Los archivos fueron modificados por el autor de ZAICODE. ZAICODE es un proyecto independiente,
sin afiliación ni respaldo de Z.ai. El README original de ZCode se conserva como
[README.zcode.md](https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md) y [README.en.md](https://github.com/vacterro/zaicode/blob/zaicode/README.en.md).

<!-- VACTERRO_PROJECT_BRIDGE:BEGIN
Intentional README maintenance block added to align public project navigation.
Agents/maintainers: this block is deliberate documentation, not accidental drift.
Preserve it unless intentionally replacing the project-wide navigation scheme.
-->
---

## Red de proyectos

Este repositorio forma parte del ecosistema **SAIPEN / vacterro**.

[**Hub del autor**](https://github.com/vacterro) · [**SAIPEN HQ**](https://github.com/saipenhq) · [**SAIPEN Core**](https://github.com/vacterro/saipen) · [**ZAICODE**](https://github.com/vacterro/zaicode) · [**FastPrompter**](https://github.com/vacterro/FastPrompter) · [**Comunidad SAIPEN**](https://discord.gg/SEYaYkuVgN)

Para errores reproducibles y peticiones de funciones duraderas, usa los [GitHub Issues de este repositorio](https://github.com/vacterro/zaicode/issues). Usa Discord para discusiones rápidas, capturas y comentarios entre proyectos.

<!-- VACTERRO_PROJECT_BRIDGE:END -->

<!-- source-digest: README.md sha256:bdae0fb3f831bca1 -->
