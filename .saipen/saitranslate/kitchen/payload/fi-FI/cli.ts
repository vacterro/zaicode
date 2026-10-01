import type { ZCodeCopy } from "../types.js";

export const copy: ZCodeCopy = {
  locale: "fi-FI",
  cli: {
    errors: {
      localeUnsupported: (value) =>
        `Ei tuettu --locale-arvo: ${value}. Tuetut kielet: en-US, zh-CN, auto.`,
    },
    help: (version) => `zcode ${version}

Käyttö:
  zcode [command] [options]

Ilman komentoa zcode avaa koko näytön TUI:n.

Komennot:
  app-server Käynnistä ZCode Protocolin stdio-sovelluspalvelin
  commands   Luettele omat slash-komennot (\`commands list\`)
  doctor     Tarkista ajonaikaiset ja paketoinnin oletukset
  login [zai|bigmodel]  Kirjaudu selaimen kautta
  logout     Poista yhteiset Z.AI-kirjautumistiedot
  plugins    Hallitse liitännäisiä ja kauppapaikkoja (\`plugins list|install|uninstall|enable|disable|update|validate|marketplace ...\`; alias: plugin)
  skills     Luettele paikalliset taidot (\`skills list\`)
  tui        Avaa terminaalikäyttöliittymä
  version    Tulosta CLI-versio

Valinnat:
  -h, --help       Näytä ohje
  -v, --version    Näytä versio
  -p, --prompt <text>  Suorita yksi kehote avaamatta TUI:ta
  --memory-bench   Kun --prompt, ota automaattinen Memory-poiminta käyttöön ja odota ennen poistumista (vaatii Memoryn)
  --browser-use <mode> Ota Browser Use -taustajärjestelmä käyttöön (tuettu: headless)
  --surface <surface>  Esityspinta headless-kehotteille/app-serverille: terminal tai desktop
  --browser-executable <path> Chrome/Chromium-suoritettava tiedosto headless Browser Use -käyttöön
  --attach <path>  Liitä paikallinen tiedosto kohteeseen --prompt; toista useille tiedostoille
  --cwd <path>     Suorita komento annetusta hakemistosta
  --disallowed-tools, --disallowedTools <tools...>
    Poista kokonaiset työkalut vain tästä kehotteesta/TUI-ajosta; tallennetut asetukset eivät muutu.
    Työkalujen nimet pilkulla tai välilyönnin erotettuina, esim. "Bash Edit".
    "Bash(git *)" poistaa koko Bashin; komento-patternit eivät täsmää.
  --force-mcs      Pakota keskustelun aikainen järjestelmäprojektio Anthropic-palveluille
  --locale <locale>  Käyttöliittymän kieli: en-US, zh-CN tai auto
  --mode <mode>    Kehotteiden lupatila: build, edit, plan tai yolo (oletus: yolo kohteelle --prompt)
  --resume <sessionId>  Jatka tallennettua istuntoa sessionId:n perusteella (sess_...)
  --target <text>  Suorita tai aseta istunnon tavoite headless-tilassa
  --target-replace Korvaa --target:n asettama olemassa oleva istunnon tavoite
  -c, --continue        Jatka nykyisen hakemiston viimeisintä istuntoa
  --json           Tulosta koneenluettava JSON, kun tuettu
  --no-browser     Tulosta OAuth-URL avaamatta selaimen
  --no-color       Poista ANSI-värit käytöstä
  --verbose        Tulosta lisädiagnostiikkaa

Slash-komennot:
  /help [command]       Näytä slash-komennon ohje
  /login                Valitse Z.AI- tai BigModel-selainkirjautuminen
  /logout               Poista yhteiset Z.AI-kirjautumistiedot
  /compact [instructions]  Tiivistä nykyinen keskustelu
  /expert [status|resume|stop|<task>]  Suorita tai hallitse asiantuntijatyönkulkua
  /dwf [list|cancel|resume]  Luettele, peruuta tai jatka dynaamisia työnkulkuja
  /fork [latest|checkpointId]  Luo uusi istunto työtilan tarkistuspisteestä
  /mcp [list|status|connect|disconnect]  Näytä tai hallitse MCP-palvelimia
  /mode [mode]          Näytä tai vaihda lupatila: build, edit, plan tai yolo
  /model [id]           Näytä tai vaihda nykyisen istunnon malli
  /new                  Aloita uusi istunto TUI:ssa
  /resume [sessionId]   Jatka istuntoa sessionId:n perusteella; jätä pois saadaksesi uusimmat cwd:ssä
  /rewind [latest|checkpointId]  Näytä uusin tarkistuspiste tai palauta työtilan tiedostot
  /skill [name] [task]  Luettele taidot tai pakota seuraava kehote lataamaan yksi
  /goal [action]        Näytä tai aseta nykyisen istunnon tavoite
`,
  },
  tui: {
    copy: {
      copied: "Valittu teksti kopioitiin leikepöydälle.",
      failed: "Valittua tekstiä ei voitu kopioida.",
      unavailable: "Tekstin kopiointi leikepöydälle ei ole käytettävissä tässä terminaalissa.",
    },
    effort: {
      disabled: "pois käytöstä",
      enabled: "käytössä",
    },
    input: {
      activeStatusHint: "esc keskeyttää",
      busyPlaceholder: "Kirjoita asettaaksesi syötteen jonoon",
      placeholder: "Kirjoita kehote",
      queuedMore: (count) => `+ ${count} muuta jonossa`,
      queuedSubmitHint: "Lähetetty seuraavan työkalukutsun jälkeen.",
      queuedTitle: (count) => ` Jonossa (${count}) `,
      title: "Syöte",
      noHistorySource: "Syötteen historian lähdettä ei ole määritetty.",
      noPreviousInput: "Ei aiempia syötteitä tälle projektille.",
      restoredPreviousInput: "Aiempi syöte palautettiin.",
      restoredPreviousInputWithAttachments: (count) =>
        `Aiempi syöte palautettiin ${count} liitteen kanssa.`,
      restorePreviousInputFailed: "Aiempaa syötettä ei voitu palauttaa.",
      typePrompt: "Kirjoita kysymys ja paina Enter.",
    },
    loginRequired: {
      help: "Käytä /model nähdäksesi mallit tai /login liitääksesi Coding Plan -tilin.",
      message: "Ei malleja käytettävissä. Määritä palveluntarjoaja tai kirjaudu sisään /login:lla.",
      status: "Ei malleja käytettävissä. Määritä palveluntarjoaja tai kirjaudu sisään /login:lla.",
      title: "mallin määritys vaaditaan",
    },
    loginSetup: {
      emptyMessage: "Kirjautumisvaihtoehtoja ei ole.",
      help: "Valitse Up/Down-nuolilla, vahvista Enterillä.",
      options: {
        bigmodelApiKey: {
          inputPrimary: "Anna BigModel Coding Plan -API-avain",
          inputSecondary: "Liitä avain tähän. Se on piilotettu kirjoitettaessa.",
          primary: "BigModel Coding Plan -API-avain",
          secondary: "Liitä Coding Plan -API-avain manuaalisesti.",
        },
        bigmodelOauth: {
          pendingPrimary: "Odotetaan BigModel-valtuutusta",
          pendingSecondary:
            "Viimeistele kirjautuminen selaimessasi. Valtuutus tunnistetaan automaattisesti.",
          primary: "BigModel Coding Plan",
          secondary: "Avaa selainkirjautuminen; valtuutus tunnistetaan automaattisesti.",
        },
        zaiApiKey: {
          inputPrimary: "Anna Z.AI Coding Plan -API-avain",
          inputSecondary: "Liitä avain tähän. Se on piilotettu kirjoitettaessa.",
          primary: "Z.AI Coding Plan -API-avain",
          secondary: "Liitä Coding Plan -API-avain manuaalisesti.",
        },
        zaiOauth: {
          pendingPrimary: "Odotetaan Z.AI-valtuutusta",
          pendingSecondary:
            "Viimeistele kirjautuminen selaimessasi. Jatkun, kun valtuutus on valmis.",
          primary: "Z.AI Coding Plan",
          secondary: "Avaa selainkirjautuminen ja luo Coding Plan -API-avain.",
        },
      },
      pending: {
        cancelStatus: "Kirjautuminen peruutettu. Valitse asennustapa.",
        help: "Esc peruuttaa ja palaa asennusvalintoihin.",
        status: "Odotetaan selaimen valtuutusta...",
      },
      input: {
        cancelStatus: "API-avaimen syöttö peruutettu. Valitse asennustapa.",
        clearStatus: "API-avaimen syöttö tyhjennetty.",
        emptyStatus: "API-avain vaaditaan.",
        help: "Enter tallentaa avaimen. Esc palaa asennusvalintoihin.",
        placeholder: "Liitä API-avain",
        status: "Syötä API-avain, sitten paina Enter.",
        submitStatus: "Tallennetaan API-avainta...",
      },
      prompt: "Valitse kirjautumis- tai API-avainmenetelmä.",
      response: "Valitse, miten Coding Plan -palveluntarjoaja asennetaan.",
      title: "Asenna Coding Plan",
    },
    model: {
      requestFailed: (message) => `Mallipyyntö epäonnistui: ${message}`,
      responseReceived: "Mallin vastaus saatu.",
      responseReceivedWithTokens: (tokens) => `Mallin vastaus saatu. ${tokens} tokenia.`,
      retryScheduled: ({ attempt, delay, maxAttempts, reason }) =>
        `Yritetään mallipyyntöä uudelleen ${attempt}/${Math.max(1, maxAttempts - 1)} ${delay} kuluttua: ${reason}`,
      streamStalled: "Mallin suoratoisto jumiutui.",
    },
    sidebar: {
      subagents: {
        title: "Alialagentit",
        empty: "Ei vielä alialagenteja.",
        emptyOutput: "Ei vielä tulosta.",
        back: "← Pääkeskustelu",
        readonly: "Vain luku · Esc palaa",
        loading: "Ladataan alialagentin tulosta...",
        unavailable: "Alialagentin tulos ei saatavilla.",
        retry: "Yritä uudelleen",
        more: "Lataa lisää",
        pendingMain: "Pääkeskustelu tarvitsee syötettäsi — palaa vastaamaan",
        ended: (count) => `Päättyi (${count})`,
        status: {
          running: "käynnissä",
          waiting: "odottaa",
          blocked: "estetty",
          success: "valmis",
          failed: "epäonnistui",
          cancelled: "peruutettu",
          lost: "menetetty",
        },
      },
      api: {
        empty: "Ei vielä API-kutsuja.",
        model: "Malli",
        more: (count) => `+${count} lisää`,
        requests: "Pyynnöt",
        server: "Palvelin",
      },
      cache: {
        hit: "osuma",
        lastHit: "viimeisin osuma",
        lastMiss: "viimeisin ohitus",
        readWrite: ({ read, write }) => `${read} luku / ${write} kirjoitus`,
        total: "yhteensä",
      },
      context: {
        cache: "Välimuisti",
        cacheReadWrite: "Välimuisti L/K",
        inputOutput: "I/O",
        reason: "Syy",
        tokens: "Tokenit",
        used: "Käytetty",
        window: "Ikkuna",
      },
      modifiedFiles: {
        empty: "Ei tiedostomuutoksia vielä.",
        more: (count) => `+${count} lisää`,
      },
      mcp: {
        empty: "MCP-palvelimia ei ole määritetty.",
        loadFailed: "MCP:n tila ei ole saatavilla.",
        loading: "Ladataan MCP-tilaa...",
        more: (count) => `+${count} lisää`,
        servers: "Palvelimet",
        status: {
          connected: "yhteydessä",
          connecting: "yhdistetään",
          disabled: "poissa käytöstä",
          disconnected: "yhteys katkaistu",
          failed: "epäonnistui",
          untrusted: "epäluotettu",
        },
        summary: ({ connected, total }) => `${connected}/${total} yhteydessä`,
        tools: (count) => `${count} ${count === 1 ? "tool" : "tools"}`,
      },
      request: {
        complete: "valmis",
        error: "virhe",
        errorWithStatus: (statusCode) => `virhe ${statusCode}`,
        pending: "odottaa",
      },
      status: {
        last: "Viimeisin",
      },
      run: {
        draft: "Luonnos",
        draftChars: (count) => `${count} merkkiä`,
        draftEmpty: "tyhjä",
        messages: "Viestit",
        mode: "Tila",
        model: "Malli",
        provider: "Palveluntarjoaja",
        thought: "Ajatus",
        trace: "Jälki",
        turn: "Kierros",
        workspace: "Työtila",
      },
      sections: {
        apis: "APIt",
        context: "Konteksti",
        mcp: "MCP",
        modifiedFiles: "Muokatut tiedostot",
        run: "Suorita",
        status: "Tila",
        todos: "Tehtävälistat",
      },
      shellSubtitle: "OpenTUI-kuori",
      title: "Sivupalkki",
      todos: {
        empty: "Ei vielä tehtävälistoja.",
        more: (count) => `+${count} lisää`,
        progress: "Edistyminen",
      },
    },
    status: {
      compactFailed: "Kontekstin pakkaus epäonnistui.",
      compacted: "Keskustelu tiivistetty.",
      compacting: "Pakataan kontekstia...",
      interruptedStreamDiscarded: "Keskeytetyn mallin suoritus hylättiin.",
      modelCalling: "Kutsutaan mallia...",
      permissionRequested: (toolName) => `Lupa pyydetty: ${toolName}.`,
      permissionResolved: (toolName) => `Lupa ratkaistu: ${toolName}.`,
      ready: "Valmis.",
      recoveringStream: "Palautetaan keskeytettyä mallin suoritusta...",
      retryingStream: "Yritetään mallin suoritusta uudelleen...",
      sessionResumed: "Istunto jatkettu.",
      targetChanged: (action) => `Kohde ${action}.`,
      thinking: "Ajatellaan...",
      toolCompleted: (toolName) => `Työkalu ${toolName} valmis.`,
      toolFailed: (toolName) => `Työkalu ${toolName} epäonnistui.`,
      toolPending: (toolName) => `Työkalu ${toolName} odottaa.`,
      toolRunning: (toolName) => `Työkalu ${toolName} käynnissä.`,
      turnFailed: "Kierros epäonnistui.",
    },
    terminal: {
      requiresInteractive: "TUI vaatii vuorovaikutteisen päätteen.",
      starting: "Käynnistetään ZCode... Ctrl+C lopettaa",
    },
    transcript: {
      compact: {
        completed: "Konteksti pakattu",
        failed: "Kontekstin pakkaus epäonnistui",
        interrupted: "Kontekstin pakkaus keskeytetty",
        retry: (command) => `Ctrl-R yrittää uudelleen: ${command}`,
        retrying: ({ attempt, maxAttempts }) =>
          maxAttempts > 0
            ? `Yritetään kontekstin pakkausta uudelleen (${attempt}/${maxAttempts})`
            : "Yritetään kontekstin pakkausta uudelleen",
        skipped: "Konteksti on ajan tasalla; pakkausta ei tarvita",
        started: "Pakataan konteksti",
      },
      roles: {
        agent: "Agentti",
        system: "Järjestelmä",
        user: "Käyttäjä",
      },
      thought: {
        complete: "Ajatus",
        thinking: "Ajatellaan...",
      },
      title: "Tapahtumakirja",
      workflow: {
        actors: "toimijat:",
        actorRow: ({ name, status }) => `${name} - ${status}`,
        usage: ({ spentTokens }) => `käyttö: ${spentTokens} tokenia`,
        collapsed: ({ label, status, nodesSettled, nodesTotal }) =>
          `Työnkulku ${label} - ${status} (${nodesSettled}/${nodesTotal} vaihetta)`,
        error: (message) => `virhe: ${message}`,
        expandHint: "+ laajenna",
        collapseHint: "- supista",
        log: "loki:",
        nodes: ({ nodesSettled, nodesTotal }) => `${nodesSettled}/${nodesTotal} vaihetta valmistui`,
        result: (preview) => `tulos: ${preview}`,
        status: {
          completed: "valmis",
          errored: "virhe",
          pending: "odottaa",
          running: "käynnissä",
          stopped: "pysäytetty",
        },
        stopReason: {
          user: "sinä",
          model: "agentti",
          provider: "mallivirhe",
          interrupted: "prosessi päättyi",
          superseded: "korvattu korjatulla ajolla",
        },
        truncated: "(katkaistu - koko historia ajon lokikirjassa)",
        interruptedNotice: ({ label, runId }) =>
          `Työnkulku ${label} keskeytyi ja voidaan jatkaa: /dwf resume ${runId}`,
      },
    },
    selection: {
      defaultHelp: "Enter valitsee, Esc peruuttaa",
      disabled: (reason) => ` [poistettu käytöstä: ${reason}]`,
      filterLine: ({ filter, help }) =>
        `suodatin: ${filter || "-"} | ${help ?? "Enter valitsee, Esc peruuttaa"}`,
      noFilter: "-",
    },
    fileMention: {
      empty: "Ei osumia työtilan poluissa.",
      loading: "Ladataan työtilan polkuja...",
      row: ({ path, selected }) => `${selected ? ">" : " "} ${path}`,
      title: "Tiedostot",
    },
    slash: {
      title: "Komennot",
      row: ({ name, selected, summary }) => `${selected ? ">" : " "} /${name}  ${summary}`,
    },
  },
};
