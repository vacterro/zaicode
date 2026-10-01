# Instalando o ZAICODE

O ZAICODE são três projetos que funcionam como um: o app ZAICODE, o SAIPEN
(o protocolo que mantém o trabalho dos agentes em dia) e o SAIMAIL (o
correio que os agentes usam para se avisar). Instalar na mão significa três
clones, um toolchain Node.js, um ambiente Python e um build. O instalador faz
tudo isso: execute, espere e um atalho do ZAICODE aparece na área de trabalho.

## Um clique

- **[ZAICODE-Setup.exe](https://github.com/vacterro/zaicode/raw/master/install/ZAICODE-Setup.exe)**:
  baixe, dê dois cliques, pressione **INSTALAR**. A janela (dourado sobre
  escuro, a faixa SAIPEN) mostra cada etapa em execução, o tempo decorrido e
  o log sob demanda; no fim, **INICIAR ZAICODE**, ou **TENTAR NOVAMENTE** /
  **Autotroubleshoot** / **Abrir log** quando alguma etapa não terminou.
  Apontado para uma pasta ZAICODE existente, o botão exibe **ATUALIZAR**: a
  mesma execução atualiza e repara. O exe traz os scripts de instalação e
  não precisa de nada ao lado; é compilado por `install\setup\build.cmd` (o compilador
  .NET Framework que todo Windows 10/11 tem).
- `install\Setup-ZAICODE.cmd` (dois cliques): a mesma instalação em um console.
- Do zero, no PowerShell:

  ```powershell
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/vacterro/zaicode/master/install/Install-ZAICODE.ps1)))
  ```

Opções de instalação: `ZAICODE-Setup.exe -InstallDir D:\ZAICODE` (pasta predefinida),
`/auto` (começa já), `/quiet` (sem janela: o instalador de console, código de saída
= resultado). A primeira execução compila o app nesta máquina, o que leva um tempo;
execuções seguintes apenas atualizam e reparam.

## Modelos gratuitos, nada a configurar

O app traz o próprio 9router. Em uma máquina sem ele, o ZAICODE o executa
privadamente (modo isolado, porta 20138), preenche o **SAIFREN** com camadas
gratuitas sem chave e torna `SAIRoute / SAIFREN` o modelo das novas tarefas, para que a
primeira tarefa digitada em Nova tarefa receba resposta: sem chave, sem conta,
sem configuração. Logins do Claude Code, Codex e Antigravity são opcionais; um
login nunca configurado na máquina aparece como "opcional, entre a qualquer
hora", não como item "precisa de você".
Prova: `node packages/desktop/scripts/verify-zaicode-free.cjs <ZAICODE.exe>`
inicia o app empacotado em um perfil vazio (seu próprio HOME, APPDATA e
LOCALAPPDATA) e só passa quando o router está isolado, o SAIFREN responde à
sondagem do primeiro token e uma tarefa em Nova tarefa recebe resposta.

## Atualizações: quatro partes, um ZAICODE

O workspace (launcher, instalador), o app, o SAIPEN e o SAIMAIL são quatro
clones. Cada um se atualiza sozinho: **Configurações -> ZAICODE -> Atualizações**
 lista os quatro com versão e commit, atualiza um manualmente ou todos, e tem um
interruptor "por si só" por parte (ligado por padrão num ZAICODE instalado,
desligado num checkout de desenvolvedor). O ZAICODE verifica alguns minutos após
o início e depois a cada seis horas. Após uma atualização, cada parte recebe o
que precisa: o app, suas dependências (quando `pnpm-lock.yaml` mudou) e uma nova
compilação (preparada enquanto o ZAICODE roda, iniciada na próxima
inicialização), o SAIPEN seu launcher, o SAIMAIL sua instalação `.venv`, o
workspace um novo launcher raiz. Um clone em outro branch, com commits locais ou
com edições que a atualização sobrescreveria é reportado e fica exatamente como
está.

```powershell
.\install\Update-ZAICODE.ps1                          # everything
.\install\Update-ZAICODE.ps1 -Component saipen        # one part (or "app,saimail")
.\install\Update-ZAICODE.ps1 -Check                   # what is new, change nothing
.\install\Update-ZAICODE.ps1 -Check -Json             # the same for a program
```

## O que faz

O instalador são as verificações do Autotroubleshoot executadas com "repair" em
uma pasta vazia, nesta ordem. Cada passo é idempotente, então rodar de novo
atualiza a instalação e conserta o que quebrou.

| Verificação | Reparo |
| ---- | ---- |
| Git, Node.js 24, Python 3.11+ | usa a cópia da máquina quando serve; senão uma cópia privada em `.tools\` (MinGit do Git for Windows, Node.js 24.14.0 do nodejs.org, Python do pacote NuGet dele). Sem direitos de administrador. |
| pnpm | o pnpm 10.33.2 fixado em `.tools\pnpm10` |
| Workspace do ZAICODE | clone do branch `vacterro/zaicode` `master` (fonte do launcher, instalador, docs; a memória do desenvolvedor `.saipen/` fica de fora; branch `workspace` até 2026-09-27) |
| Fonte do app ZAICODE | clone do branch `zaicode` em `zcode\` |
| SAIPEN | clone de `vacterro/saipen` em `saipen\`; seu `bin\saipen.cmd` é escrito para este clone e este Python |
| SAIMAIL | clone de `vacterro/saimail` em `saimail\`, instalado em `.venv\` |
| saimail-local | cliente de linha de comando do SAIMAIL, usado pelos painéis de SAIMAIL do ZAICODE (disponível desde SAIMAIL `0.0.2a3`; a verificação `saimail-cli` reporta OK) |
| Pacote 9router | `9router` do npm em `.tools\router`, empacotado para o SAIFREN funcionar sem configuração (WARN se o npm não conseguir acessar) |
| Dependências do app | `pnpm install --frozen-lockfile` (de novo quando `pnpm-lock.yaml` mudar) |
| Compilação do app | `pnpm bundle:zaicode`; enquanto o ZAICODE roda a nova compilação é preparada e trocada na próxima inicialização |
| Troca da compilação preparada | limpa um `win-unpacked.previous` deixado por uma falha de troca com caminho longo e encaixa uma compilação aguardando enquanto o ZAICODE está fechado |
| Launcher raiz | `tools\launcher\build.cmd` -> `ZAICODE.exe` |
| Atalhos | `ZAICODE` da Área de Trabalho e do menu Iniciar -> `ZAICODE.exe` |
| Logins do Claude / Codex | apenas reportados: cada login `~\.claude*` / `~\.codex*` é seu próprio motor no ZAICODE (A1, A2, C1, ...); um login exige você, no navegador |

O launcher raiz aponta o ZAICODE para o SAIPEN instalado (`saipen\`) e coloca
`.tools\` e `.venv\Scripts` no topo do PATH do app, para que o app, seus agentes
e seus workers usem as cópias instaladas.

## Várias assinaturas

Cada login do Claude Code ou Codex tem seu próprio home: `~\.claude`,
`~\.claude-account2`, ... e `~\.codex`, `~\.codex-account2`, ... O ZAICODE encontra
todos. Para preparar mais na instalação:

```powershell
.\install\Install-ZAICODE.ps1 -AddClaudeAccounts 1 -AddCodexAccounts 2
```

O instalador cria os homes e imprime o comando de login exato de cada
um (`$env:CODEX_HOME = '...'; codex login`). O mesmo dentro do ZAICODE: Configurações ->
Engines & limits -> adicionar outro login.

## Autodiagnóstico

```powershell
.\install\ZAICODE-Doctor.ps1            # check only; exit 1 while something fails
.\install\ZAICODE-Doctor.ps1 -Repair    # check and repair (install\Doctor.cmd)
.\install\ZAICODE-Doctor.ps1 -Json      # results as JSON
.\install\ZAICODE-Doctor.ps1 -Repair -Only app,launcher
```

Status por verificação: OK, FIXED (estava quebrado, reparado), WARN (funciona, mas falta
algo opcional), INFO (precisa de você: um login), FAIL. Logs em
`install\logs\`; o resumo da última instalação é `install\install-report.json`.
No app, Router -> Autotroubleshoot repara o router em execução e os pools.

## Opções

| Parâmetro | Padrão | |
| ---- | ---- | ---- |
| `-InstallDir` | `%USERPROFILE%\ZAICODE` | onde tudo é instalado |
| `-ShortcutDir` | Desktop | onde vai o atalho do ZAICODE |
| `-NoStartMenu`, `-NoShortcut` | | pula esses atalhos |
| `-PortableTools` | | Git / Node.js / Python próprios mesmo quando a máquina já tem |
| `-Launch` | | inicia o ZAICODE ao terminar |
| `-ZaicodeRepo`, `-SaipenRepo`, `-SaimailRepo` | os repositórios do GitHub | outra origem (um fork, um caminho de clone local) |

## Comprovação

`install\tests\Test-ZaicodeInstall.ps1 -InstallDir <dir> -ShortcutDir <dir> -Smoke`
verifica uma instalação nova, semeia falhas (atalho e lançador apagados, lançador do
SAIPEN apontando para um Python inexistente, venv do SAIMAIL apagado, node_modules
registrado para outro lockfile, uma pasta de build remanescente mais profunda que MAX_PATH),
confirma que o doctor relata e repara cada uma, então inicia o alvo do atalho com
um perfil isolado e encerra exatamente a árvore de processos que ele iniciou.

`install\tests\Test-ZaicodeUpdate.ps1` cria quatro repositórios descartáveis em
disco e uma instalação dos clones deles, então comprova que uma verificação não muda nada,
que um componente é atualizado sozinho junto com seu dependente (lançador do SAIPEN, lançador
raiz), que edições locais sobrepostas e commits locais são preservados, e que um nome
de componente desconhecido é recusado. Sem rede.

<!-- source-digest: docs/ZAICODE_INSTALL.md sha256:7ff9a25bab155f2c -->
