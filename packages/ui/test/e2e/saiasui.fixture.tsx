import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { SaiasuiHost } from "../../src/zaicode/saiasui/SaiasuiHost.js";
import { SaiasuiSettings } from "../../src/zaicode/saiasui/SaiasuiSettings.js";
import { useSaiasui } from "../../src/zaicode/saiasui/saiasuiStore.js";
import { ZCodeIntlProvider } from "../../src/i18n/IntlProvider.js";
import "../../src/styles.css";
import {
  findZaicodePalette,
  paletteCssVariables,
  ZAICODE_CRISP_CSS,
} from "../../src/zaicode/zaicodePalettes.js";

for (const [name, value] of Object.entries(
  paletteCssVariables(findZaicodePalette("goldendefault")!),
)) {
  document.documentElement.style.setProperty(name, value);
}
document.documentElement.classList.add("zaicode-crisp", "zaicode-no-motion", "zaicode-no-dim");
const crispStyle = document.createElement("style");
crispStyle.textContent = ZAICODE_CRISP_CSS;
document.head.append(crispStyle);

/** Real game components, isolated from task services and the operator's profile. */
function Fixture() {
  const [draft, setDraft] = useState(true);
  const [text, setText] = useState("preserved draft");
  Object.assign(window, {
    saiTest: { setDraft, configure: useSaiasui.getState().configure, applyPreset: useSaiasui.getState().applyPreset },
  });
  return (
    <div className="text-foreground">
      <aside
        style={{ position: "fixed", inset: "0 auto 0 0", width: 128 }}
        className="border-r border-border bg-card p-2"
      >
        <button onClick={() => setDraft(!draft)}>Switch route</button>
      </aside>
      <main
        data-session-id={draft ? "draft" : "session"}
        style={{ position: "fixed", inset: "0 0 0 128px" }}
        className="bg-background"
      >
        {draft ? <SaiasuiHost /> : null}
        <div style={{ position: "absolute", left: 80, top: 160 }} data-v4-draft-greeting>
          New task · Do your best.
        </div>
        <div
          data-testid="v4-composer"
          style={{ position: "absolute", left: 80, bottom: 80 }}
          className="border border-border bg-card p-2"
        >
          <textarea
            aria-label="Draft"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <button type="button">Send</button>
        </div>
      </main>
      <div hidden>
        <SaiasuiSettings />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ZCodeIntlProvider>
      <Fixture />
    </ZCodeIntlProvider>
  </StrictMode>,
);
