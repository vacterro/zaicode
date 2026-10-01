# ZAICODE

<div align="center">
  <img src="https://raw.githubusercontent.com/vacterro/zaicode/zaicode/packages/ui/src/assets/zaicode-working.png" alt="ZAICODE" width="96" height="96" />
</div>
<p align="center">
  <img src="https://img.shields.io/badge/version-0.0.1-c9a227" alt="version 0.0.1" />
  <img src="https://img.shields.io/badge/platform-Windows-3b3527" alt="Windows" />
  <img src="https://img.shields.io/badge/license-Apache--2.0-3b3527" alt="Apache-2.0" />
</p>
<p align="center">
  ZAICODE · <a href="https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md">ZCode (简体中文)</a> · <a href="https://github.com/vacterro/zaicode/blob/zaicode/README.en.md">ZCode (English)</a>
</p>

<img width="1440" height="860" alt="ZAICODE hero — Do your best." src="docs/screenshots/01-do-your-best.png" />

ZAICODE é uma bancada de trabalho do operador para rodar vários agentes de codificação com IA ao mesmo tempo, em vários projetos, sem precisar fiscalizá-los. É uma build modificada do
[ZCode](https://github.com/zai-org/ZCode) (app desktop, UI no navegador e
CLI de agentes) com uma camada de produto por cima: todo projeto é conduzido pelo
protocolo [SAIPEN](https://github.com/vacterro/saipen), o trabalho é iniciado, retomado
e agendado a partir de uma única janela, e as CLIs de assinatura que você já paga
(Claude Code, Codex, Antigravity) rodam como workers acoplados ao lado dos agentes
do app.

**0.0.1** é o primeiro snapshot marcado: uma build pessoal, focada em Windows, usada
no dia a dia.

## Instalação em um clique

1. Baixe **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**.
2. Dê dois cliques nele e pressione **INSTALAR**.

Só isso. O instalador traz o que a máquina não tem (Git, Node.js, Python, como cópias
privadas: sem direitos de administrador), busca ZAICODE, SAIPEN e SAIMAIL no GitHub,
compila o app na máquina e cria um atalho do ZAICODE na área de trabalho. A primeira
execução leva 15-30 minutos; a janela mostra cada passo.

Modelos gratuitos funcionam de imediato: o ZAICODE sobe o próprio router e preenche o pool **SAIFREN**
com planos gratuitos sem chave, então uma tarefa digitada em Nova tarefa recebe resposta sem
chave, sem conta e sem configuração. Assinaturas do Claude Code, Codex e Antigravity são
opcionais e podem ser ativadas a qualquer momento.

**Um todo, quatro partes.** O workspace (launcher, installer), o app, SAIPEN e
SAIMAIL são quatro repositórios. Cada um se atualiza sozinho: *Configurações -> ZAICODE ->
Atualizações* mostra todas as partes e atualiza cada uma manualmente ou automaticamente
(verificado poucos minutos após o início e a cada seis horas). Uma nova build do app é
preparada enquanto o ZAICODE roda e entra em vigor na próxima inicialização; suas próprias edições em
um clone nunca são sobrescritas.
Pelo terminal: `install\Update-ZAICODE.ps1 [-Component saipen] [-Check]`.
Autotroubleshoot: `install\Doctor.cmd`. Detalhes: [docs/ZAICODE_INSTALL.md](docs/ZAICODE_INSTALL.md).

## Tour pela interface

<table>
  <tr>
    <td width="50%" valign="top">
      <strong>SAIHOME</strong><br />
      The operator dashboard: quotas, health, projects, streaks, activity, and the live clock in one place.<br /><br />
      <img src="docs/screenshots/02-saihome-dashboard.png" alt="SAIHOME dashboard" />
    </td>
    <td width="50%" valign="top">
      <strong>Agents &amp; tasks</strong><br />
      Create roles, inspect queues, and see what is idle, running, finished, or waiting for you.<br /><br />
      <img src="docs/screenshots/03-agents-and-tasks.png" alt="Agents and tasks" />
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>Scheduler</strong><br />
      Arm quota-aware autonomous runs and recurring prompts across one project or a whole sidebar section.<br /><br />
      <img src="docs/screenshots/04-scheduler.png" alt="Scheduler" />
    </td>
    <td width="50%" valign="top">
      <strong>Audits</strong><br />
      Run Quick 3 Waves audits, watch progress live, and jump straight to reports when something stops.<br /><br />
      <img src="docs/screenshots/05-audits.png" alt="Audits" />
    </td>
  </tr>
  <tr>
    <td colspan="2" valign="top">
      <strong>Active session</strong><br />
      The full working view: transcript, branch, prompt composer, state inspector, board, and backlog at the same time.<br /><br />
      <img src="docs/screenshots/06-active-session.png" alt="Active session" />
    </td>
  </tr>
</table>

## O que ele acrescenta ao ZCode

- **Projetos com uma sessão MAIN.** Cada projeto tem uma sessão MAIN (START,
  `/goal cc all`) e sessões auxiliares (subSaipens: WIKI, TEST, AUDIT, …). A
  visão padrão da barra lateral mostra a linha do projeto como sua MAIN; ▶
  continua a MAIN em vez de abrir outra sessão. CONTINUAR TUDO, CONCLUÍDO e
  LIMPAR TUDO CONCLUÍDO varrem todos os projetos; uma sessão cortada no meio
  de um turno mostra INTERROMPIDO, nunca CONCLUÍDO.
- **Segurança contra falhas.** Sessões interrompidas por um processo morto e
  metas ainda ativas continuam sozinhas após reiniciar; workers em execução
  reiniciam. Agentes dentro do ZAICODE não conseguem matar o ZAICODE pelo nome
  do processo.
- **Workers.** CLIs de assinatura rodam em terminais encaixados em qualquer
  borda da janela (ou em janelas próprias com encaixe). Perguntas de primeira
  execução "Confiar nesta pasta?" são respondidas; um worker que atinge seu
  limite de uso é reportado e, por configuração, fechado ou reiniciado após o
  reset.
- **Limites e resets.** Medidores de cota por conta e pool, um timer na barra
  de título para o reset mais próximo com a lista completa dos próximos resets
  ao passar o mouse.
- **SCHEDULER.** Prompts que se iniciam sozinhos: em um horário, diariamente, a
  cada N minutos ou quando uma janela de cota se reabastece; em um projeto ou
  em toda uma seção da barra lateral, piores projetos primeiro (mais
  bloqueados / tickets SAIPEN abertos). Condições podem interromper primeiro
  trabalhos temporários (sessões de pool grátis, workers mais fracos), rodar
  só em projetos ociosos ou continuar só sessões marcadas. Prompts não têm
  limite prático de tamanho.
- **Roteamento.** Um 9router incluído (MIT) dá pools sem configuração: SAIFREN
  (tiers grátis sem chave) e SAIOPP (suas assinaturas).
- **SAIHOME, timers, sons, destaques.** Uma home de operador com estatísticas,
  timers e alarmes no estilo FastPrompter, sons por ação e uma interface
  Win95 dark golden, pixel-crisp."

## Compilação

Requisitos: Windows 10/11, Git, Node.js **24.14.0**, pnpm **10.33.2**
([mise.toml](https://github.com/vacterro/zaicode/blob/zaicode/mise.toml) é a fonte oficial).

```bash
pnpm bootstrap
pnpm bundle:zaicode          # -> packages/desktop/dist/win-unpacked/ZAICODE.exe
```

O app empacotado sempre inicia no modo ZAICODE. Enquanto um ZAICODE mais
antigo roda, o bundler prepara o novo build em `packages/desktop/dist-next`; o launcher na raiz
(branch `master`, `tools/launcher`) o substitui na inicialização seguinte.
A variante bitmap nítida do Verdana usada pela UI não faz parte deste repositório;
sem ela a interface cai para o Verdana do sistema.

Verificações: `pnpm typecheck`, `pnpm lint` e os testes do ZAICODE, por exemplo
`node --import tsx --test test/zaicode*.test.ts` a partir de `packages/ui`.

## Layout do repositório

| Branch      | Conteúdo                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| `master`    | o workspace canônico: launcher, instalador (`install/`), docs do produto (`UI.md`, `docs/`), estado do SAIPEN e CHANGELOG |
| `zaicode`   | o código canônico do app: histórico do ZCode upstream mais a camada de produto ZAICODE usada nos builds e atualizações |

Refs legadas ou criadas por automação ainda podem aparecer temporariamente, mas
não são branches de produto canônicas. Trabalho novo de workspace pertence a
`master`; trabalho no código do app pertence a `zaicode`.

O código de app do ZAICODE vive principalmente em `packages/ui/src/zaicode/`,
`packages/shared/src/zaicode-*.ts`, `packages/services/src/zaicode/` e
`packages/desktop/src/main/zaicode*.ts` na branch `zaicode`. A documentação do workspace e as
ferramentas do launcher/update vivem em `master`.

## Upstream e licença

ZAICODE deriva do ZCode, da Z.ai, e é distribuído sob a mesma
[Licença Apache 2.0](https://github.com/vacterro/zaicode/blob/zaicode/LICENSE); os avisos do upstream ficam em
[NOTICE.md](https://github.com/vacterro/zaicode/blob/zaicode/NOTICE.md) e [THIRD-PARTY-NOTICES.md](https://github.com/vacterro/zaicode/blob/zaicode/THIRD-PARTY-NOTICES.md).
Os arquivos foram modificados pelo autor do ZAICODE. O ZAICODE é um projeto
independente, sem afiliação nem endosso da Z.ai. O README original do ZCode
ficou em [README.zcode.md](https://github.com/vacterro/zaicode/blob/zaicode/README.zcode.md) e [README.en.md](https://github.com/vacterro/zaicode/blob/zaicode/README.en.md).

<!-- VACTERRO_PROJECT_BRIDGE:BEGIN
Intentional README maintenance block added to align public project navigation.
Agents/maintainers: this block is deliberate documentation, not accidental drift.
Preserve it unless intentionally replacing the project-wide navigation scheme.
-->
---

## Rede de projetos

Este repositório faz parte do ecossistema mais amplo **SAIPEN / vacterro**.

[**Hub do autor**](https://github.com/vacterro) · [**SAIPEN HQ**](https://github.com/saipenhq) · [**SAIPEN Core**](https://github.com/vacterro/saipen) · [**ZAICODE**](https://github.com/vacterro/zaicode) · [**FastPrompter**](https://github.com/vacterro/FastPrompter) · [**Comunidade SAIPEN**](https://discord.gg/SEYaYkuVgN)

Para bugs reproduzíveis e pedidos de recursos consistentes, use as
[GitHub Issues deste repositório](https://github.com/vacterro/zaicode/issues). Use o Discord para
discussão rápida, capturas de tela e retorno entre projetos.

<!-- VACTERRO_PROJECT_BRIDGE:END -->

<!-- source-digest: README.md sha256:bdae0fb3f831bca1 -->
