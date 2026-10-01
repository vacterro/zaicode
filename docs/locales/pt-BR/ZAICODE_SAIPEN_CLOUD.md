# Transporte na nuvem do ZAICODE SAIPEN

Como este checkout e uma sessão do Claude Code Cloud executam um mesmo workspace SAIPEN com executor em localidades diferentes, e onde fica a fronteira entre eles.

## A forma

```
  local machine                                  Claude Code Cloud
  ────────────                                   ─────────────────
  ZAICODE checkout                               ephemeral checkout
  branch saipen-live                             branch saipen-live
       │                                                │
       └────────── origin/saipen-live ─────────────────┘
                        (github.com/vacterro/zaicode)
```

Uma branch carrega o estado do protocolo. Não há etapa de merge, nem de rebase,
nem uma segunda branch local para manter em sincronia: o executor que tiver um
checkpoint verificado faz commit e push, e o outro lado o recebe com
fast-forward.

`master` é o histórico pré-transporte e a branch padrão publicada. Ela
não sofre force-update pelo transporte.

## O que viaja e o que não viaja

Um checkpoint neste repositório carrega o estado do protocolo SAIPEN, o
launcher da raiz, o instalador, a documentação e estes scripts de transporte.
Essa é toda a camada de workspace.

Ele não carrega **nenhum byte de produto**. `zcode/` é um repositório Git
separado, listado em `.saipen/source-nested-repos.json` e com gitignore nesta raiz
(`/zcode/`). Trabalho de produto precisa de seu próprio clone de `vacterro/zaicode`
na branch `zaicode`, e esse clone é um segundo objeto independente, com
histórico próprio.

A consequência é fácil de errar: um `git status` limpo nesta raiz não diz
nada sobre trabalho de produto não commitado, e um fast-forward de `saipen-live`
não diz nada sobre código de produto. Verifique `git -C zcode status` explicitamente.

## Metade local

Dois scripts, ambos pertencentes ao repo, para que uma máquina nova os obtenha
do repositório em vez de da memória:

| Arquivo | Papel |
|------|------|
| `tools/saipen-cloud/Install-SaipenLiveSync.ps1` | valida, reconcilia o branch, instala e inicia o watcher, grava a entrada de autostart, prova local == remoto |
| `tools/saipen-cloud/ZaicodeSaipenLiveWatcher.ps1` | o loop: fetch, comparação, fast-forward ou push, log, pausa; depois a passagem de produto e a autoatualização |
| `tools/saipen-cloud/Test-SaipenLiveSync.ps1` | ida e volta a partir de um executor independente mais prova de recuperação a frio |
| `tools/saipen-cloud/Test-ProductSync.ps1` | passagem de produto e autoatualização contra repositórios Git descartáveis (sem rede, sem remoto real) |

Instalar e reparar:

```
powershell.exe -File tools\saipen-cloud\Install-SaipenLiveSync.ps1
```

É idempotente. O estado local da máquina fica em `%APPDATA%\SAIPEN`:
`ZaicodeSaipenLiveWatcher.ps1` (uma cópia), `ZAICODE_cloud-sync.log` (rotacionado em
2 MB para `.log.1`), `ZAICODE_cloud-sync.lock` (instância única),
`ZAICODE_cloud-sync.pid` e uma entrada na pasta Startup
`SAIPEN-ZAICODE-Cloud-Sync.cmd`.

O instalador recusa uma árvore suja e nunca a limpa. Se todo caminho sujo for
estado canônico do SAIPEN sob `.saipen/`, ele avisa e imprime os comandos
exatos de checkpoint; isso é um estado de protocolo sem checkpoint, não uma
falha de transporte, e o instalador não fará commit disso pelas costas do
protocolo.

## Comportamento do watcher

| Situação | Movimento |
|-----------|------|
| limpa, local é ancestral do remoto | `git merge --ff-only` |
| limpa, remoto é ancestral do local | `git push` |
| suja | pausa; nem faz fetch |
| em outro branch | pausa |
| ambas avançaram, sem ancestral comum | pausa, registra os dois ids de commit, não faz merge de nada |
| fetch ou rede falhou | registra degradado, tenta de novo no próximo tick |
| um merge/rebase/cherry-pick em andamento | pausa |

Nunca: force push, hard reset, stash, clean, checkout de um branch estrangeiro,
commit, ou parada por nome de processo. O instalador para um watcher apenas pelo
pid que gravou no próprio arquivo de pid.

Uma árvore suja não custa nada, porque o watcher verifica a sujeira antes
do fetch. Um checkout ocioso, portanto, não faz nenhuma chamada de rede.

### Passagem de produto (T-90)

`zcode/` é seu próprio repositório, então a tabela acima nunca move código de
produto. Depois dela, o mesmo tick cuida do checkout de produto (`-ProductRepo`,
padrão `<repo>\zcode`; branch `-ProductBranch`, padrão `zaicode`). A
passagem de produto roda com a árvore externa suja ou não. Ela só faz pull.

| Situação | Ação |
|-----------|------|
| remoto à frente, nenhum arquivo recebido está sujo aqui | `git merge --ff-only`; trabalho de produto não commitado fica como está |
| remoto à frente, um arquivo recebido está sujo aqui | RETIDO: registre os arquivos; não mescle nada |
| local à frente | registre; **nunca enviado** (produto é publicado por SAIPEN SHIP) |
| divergido | pause; registre os dois ids; não mescle nada |
| outro branch, op do git em andamento, fetch falhou | pause |
| sem checkout de `zcode/`, ou `-NoProduct` | ignorado |

o git recusa sozinho um fast-forward que sobrescreveria uma alteração local, então
a verificação RETIDO é uma guarda anterior e mais clara, não a única. Um
fast-forward de produto não reconstrói nada: para testar, rode `pnpm bundle:zaicode`
(ou a prévia de dev).

### Autoatualização (T-90)

O watcher roda como cópia sob `%APPDATA%\SAIPEN`, então um watcher mais novo no
repositório nunca roda sem reinstalação. No modo loop, ele compara
o próprio arquivo com a cópia commitada do repositório a cada passada. Instala
essa cópia sobre si mesmo e reinicia exatamente uma vez, com os mesmos
argumentos, só quando tudo isso vale:

- os dois arquivos diferem;
- a cópia do repositório não tem edições não commitadas;
- a cópia do repositório faz parse sem erros.

Uma cópia que não faz parse é recusada e registrada; o watcher em
execução continua.

Watchers instalados antes do T-90 não têm nem a passada de produto nem a
autoatualização. Rode `Install-SaipenLiveSync.ps1` uma vez numa máquina assim; depois,
o watcher se atualiza sozinho.

## Metade na nuvem

`CLAUDE.md` na raiz é a regra de entrada e
`.claude/skills/saipen/SKILL.md` é o procedimento de execução. A skill busca
o kernel SAIPEN de `github.com/vacterro/saipen` e o executa pela
superfície de engine declarada `tools/saipen.py`. O kernel é fixado por commit
(`3088eff`), nunca por tag. A tag `v8.0.1` é um kernel mais antigo com o mesmo
`VERSION`; o `validate` dele muta estado, e o validador dele rejeita este board.

`STATE.saipen_home` registra o caminho do kernel do executor que fez
checkpoint por último. Na nuvem, o primeiro `saipen continue` no kernel `3088eff` converge
o ponteiro para o kernel em execução como um único `DEC` registrado em journal
(E-1410). Na máquina do operador o ponteiro chega morto do mesmo jeito. Kernel
com convergência automática repara isso em `continue`; caso contrário, rode
`saipen rebind-home --auto`.

**A viagem de volta é observada.** E-1562 (nuvem) convergiu o ponteiro para
`/home/user/zaicode/.claude/saipen-protocol`; E-1571 (máquina do operador)
convergiu de volta direto para `V:/.../_SAIPEN`, automaticamente, sem
`rebind-home` manual. Os dois sentidos são a mesma convergência automática, então espere
um `saipen_home` `DEC` por troca de localidade e trate como ruído esperado
em vez de defeito. Continua sendo ruído até P1-2
(`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`) mover o ponteiro para fora do estado
versionado; não implemente P1-2 como efeito colateral de notar isso. Nunca edite manualmente
o ponteiro.

`STATE.saipen_home` pode apontar para um **checkout de desenvolvimento** do kernel que está à frente
do pin, e não para um clone limpo de `3088eff` — na máquina do operador é o
branch `accepted-debt-rebind` com trabalho não commitado. Um kernel fora do commit fixado não é automaticamente errado, mas também
não é uma fonte clean-room, então a regra abaixo sobre o contrato de voz se aplica a ele com
força total. Nunca faça commit, stash, reset, checkout nem clean em
um checkout desse tipo; a única exceção permitida é o restore pontual de um único arquivo
de `saipen/STYLE.md`, e somente quando o operador pedir.

### STYLE.md não é uma configuração local

`saipen/STYLE.md` deve ser **byte-idêntico ao arquivo do kernel fixado** em
cada máquina, em cada cópia, sem exceções e sem edições locais. Na máquina do operador há mais de uma cópia:

- o checkout do kernel em `STATE.saipen_home` (um clone do Git, na máquina do
  operador um checkout de desenvolvimento);
- `%LOCALAPPDATA%\saipen\scheduled-source\saipen\STYLE.md`, populado pela
  tarefa agendada `saipen-inject` (`bootstrap/schedule-run.ps1`). **Não
  é um repositório Git**, então `git checkout` nunca pode repará-lo — um novo sync pelo
  injetor, ou a escrita direta do conteúdo publicado, é o único caminho.

O token `style_contract` em `.saipen/STATE.md` é um hash do texto desse arquivo
(`tools/validate.py`, `style_contract_token`: CRLF normalizado, a
linha `style_contract:` excluída). Edite `reply_language` em uma cópia e o
token muda; a outra cópia e a nuvem, que buscam o kernel publicado,
mantêm o token publicado, e toda escrita de CLI no lado divergente é
recusada com `style_contract ... does not match the installed STYLE.md marker`.
Essa é a falha completa: o lado local escreve estado que a nuvem não pode escrever.

**Mudar o idioma da resposta é um commit no kernel mais um repin**, nunca uma edição
local. Mude no repositório do kernel, publique, refixe o commit em
SKILL.md e atualize `STATE.style_contract` através de `saipen recover`. Uma edição
local em `STYLE.md` dessincroniza toda máquina que não seja a que está fazendo a alteração.

Uma armadilha que vale nomear: o `bin/saipen` publicado é um shim vinculado à máquina, que
tem em código fixo o interpretador absoluto e os caminhos de checkout de um operador específico. Ele roda em
exatamente uma máquina. A nuvem deve usar `python3 tools/saipen.py`.

Atalhos: `cc` continua o Work atual; `cc all <text>` ingere a mensagem
inteira como source/appends e continua todo Work elegível. Nenhum dos dois pede confirmação
de rotina.

## Classificação de capability

**AVAILABLE_IN_CLOUD** — estado do protocolo e da camada de workspace. Leitura e
escrita de `.saipen/`, o launcher (`tools/launcher/ZaicodeLauncher.cs`), o
instalador em `install/`, `docs/`, `CLAUDE.md`, `.claude/skills/` e os
scripts de transporte. Leitura, commit, push e fetch do Git em `saipen-live`. Qualquer
gate que seja asserção de arquivo, revisão de diff ou verificação de texto.

**LOCAL_WINDOWS_ONLY** — os gates que exigem esta máquina.

| Gate | Por quê |
|------|-----|
| `tools\launcher\build.cmd` | compila `ZaicodeLauncher.cs` com o .NET Framework `csc`; sem Windows SDK na imagem em nuvem |
| E2E do Electron empacotado (`zcode` desktop, Solo → fila → dispatch) | exige sessão de desktop e um perfil de provedor semeado |
| o 9router em execução | um serviço Windows nesta máquina |
| clique interativo no desktop | uma pessoa e uma tela |
| os próprios casos de runtime do watcher | o watcher só roda na máquina que tem o checkout |

Esses são registrados como limites de aceitação locais. Nunca são
reportados como aprovados só porque o diff parecia correto.

**SAFE_TO_DEFER** — a camada de produto. Uma sessão em nuvem pode clonar
o branch `vacterro/zaicode` `zaicode` e trabalhar ali. Trabalho na camada de
workspace não exige trabalho de produto, mas exige o clone:
`.saipen/source-nested-repos.json` declara `zcode/`, e sem ele o
validador falha com `source freshness computation BLOCKED -- declared nested
repository is missing: 'zcode'`. Os gates `pnpm` precisam do pnpm 10.33.2
fixado e de um workspace pronto. `pnpm bootstrap` em uma imagem nova em nuvem é a
forma documentada de entrar, e o `package.json` do produto já o declara.

A nuvem só pode verificar bytes de produto que estão em `origin/zaicode`. Um
delta de produto que existe apenas no checkout `zcode/` do operador é
invisível aqui, então todo gate de produto dele é NOT RUN na nuvem, seja qual
for o gate. T-84 é o primeiro caso (E-1411): sua correção era local-only enquanto
`origin/zaicode` ainda carregava o código pré-correção.

**UNSAFE_TO_EMULATE** — tudo que faria um gate local parecer verde.
Não faça stub do build do launcher, não falsifique uma execução do app
empacotado, não reproduza um resultado gravado de
`pnpm verify:pre-push` como se tivesse acabado de rodar, nem converta "o código
parece correto" em uma linha PASS em `.saipen/LOG.md`.

**KNOWN_CLOUD_DIVERGENCE** — conformidade que depende de onde o checkout
está. No kernel `3088eff`, o validador em nuvem reporta FAILs de `closure-evidence`
(T-47, T-62, T-76, T-78 no momento da escrita) que a máquina
do operador não reporta.

O kernel move qualquer evento LOG acima de 1024 bytes para
um sidecar `.saipen/recovery/log-detail/`. Na leitura, restaura o sidecar somente
quando o caminho absoluto do checkout é igual ao caminho de onde foi escrito.
Um veredito VERIFY longo escrito no Windows é, portanto, ilegível na nuvem, e
o inverso também vale.

O defeito está no kernel e está registrado como P1-1 em
`docs/HANDOFF_SAIPEN_CROSS_PLATFORM.md`. Até lá:

- cite o veredito da nuvem e classifique-o como este limite, ticket por ticket
  (`SKILL.md` § 6 tem a verificação);
- nunca reescreva sidecars, re-verifique só para ficar verde, nem aplique patch na
  cópia do kernel;
- mantenha eventos LOG abaixo de 1024 bytes nos dois lados.

O mesmo binding de caminho de máquina também bloqueia o trabalho. A baseline de
dívida pré-BUILD é capturada na primeira vez que um ticket entra em BUILD e
reverificada a cada entrada posterior. Um ticket que entrou em BUILD pela
primeira vez na máquina do operador, portanto, não pode entrar em BUILD na nuvem:
a transição é recusada com `DEBT_SNAPSHOT_FOREIGN_PROJECT`. T-84 é o caso registrado: DEBT-000079
foi capturada em E-1377 e a transição recusada em E-1446. Deixe esse ticket com
a máquina que capturou a baseline.

## Divergência

Se o local e o remoto deixarem de compartilhar um ancestral, o watcher para.
Ele não faz merge, rebase nem force. Os dois commit ids vão para o log, a
correção é feita `git log --left-right --cherry-pick <branch>...origin/<branch>` à mão, e o
resultado é salvo como checkpoint como qualquer outra mudança.

## A ação exata do lado da nuvem

### Script de setup do ambiente (uma vez, nas configurações do ambiente na nuvem)

Menu do ambiente na nuvem na barra de título da sessão -> Editar -> Script
de setup. Ele roda antes de cada nova sessão, então toda sessão começa com o
toolchain do produto pronto:

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

### O prompt para cada nova sessão

Inicie a sessão no repositório `vacterro/zaicode`, branch `saipen-live`, e
garanta que o agente da máquina do operador não esteja escrevendo ao mesmo
tempo. Substitua a última linha por `cc all <new list>` para entregar trabalho novo.

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

Na máquina do operador o watcher faz fast-forward de `zcode` a partir
de `origin/zaicode`; `REBUILD.cmd` (ou `REBUILD_fast.lnk`) compila, e a
próxima inicialização do ZAICODE instala o novo build.

<!-- source-digest: docs/ZAICODE_SAIPEN_CLOUD.md sha256:61273984b2a765f6 -->
