interface CustomAboutDialogHtmlInput {
  applicationName: string;
  appVersion: string;
  copyright: string;
  optimizationLine: string;
  versionLabel: string;
  okButtonLabel: string;
  /**
   * SRC-114: the About box used to draw the upstream vendor's mark whatever build
   * it was, which told the user of a rebrand that the thing on their disk belongs
   * to somebody else. This is the ZAICODE logo inlined as a data URI (the window
   * is sandboxed with `img-src data:`), or undefined when it is unavailable -- in
   * which case the caller has already decided what the fallback is.
   */
  logoDataUri?: string;
  /** One line saying what the program is, not just which version of it. */
  tagline?: string;
  /** Where the source lives. A rebrand nobody can find the source of is a dead end. */
  repository?: string;
  /** Immutable runtime/build facts, including explicit source skew. */
  identityLines?: string[];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function createCustomAboutDialogHtml(input: CustomAboutDialogHtmlInput): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
    />
    <title>${escapeHtml(input.applicationName)}</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
        --startup-page-bg: #f4f4f5;
        --about-primary: #0a0a0a;
        --about-primary-foreground: #fafafa;
        --about-primary-active: color-mix(in oklab, var(--about-primary) 80%, transparent);
      }

      * {
        box-sizing: border-box;
      }

      html,
      body {
        width: 100%;
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: var(--startup-page-bg);
      }

      body {
        display: grid;
        place-items: center;
        padding: 0;
        user-select: none;
      }

      .about-window {
        width: 100%;
        max-width: 256px;
        height: 308px;
        display: grid;
        place-items: stretch;
        padding: 0;
        background: transparent;
      }

      .about-card {
        width: 100%;
        height: 100%;
        padding: 22px 15px 14px;
        display: flex;
        flex-direction: column;
        border: 0;
        border-radius: 0;
        background: transparent;
        color: #1d1d1f;
        box-shadow: none;
        -webkit-app-region: drag;
      }

      .content {
        width: 100%;
        max-width: 222px;
        margin: 0 auto;
        flex: 1;
        min-height: 0;
      }

      .app-icon {
        width: 52px;
        height: 52px;
        display: flex;
        align-items: center;
        justify-content: center;
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 12px;
        background: linear-gradient(180deg, #000000 0%, #151718 100%);
        color: #ffffff;
        box-shadow: 0 10px 13px -3px rgb(0 0 0 / 0.2), 0 4px 5px -3px rgb(0 0 0 / 0.2);
      }

      .app-logo {
        width: 30px;
        height: auto;
        display: block;
      }

      /* The logo arrives as a PNG of unknown aspect ratio, so it is fitted into a
         square instead of being allowed to stretch the card. */
      .app-logo-img {
        width: 32px;
        height: 32px;
        display: block;
        object-fit: contain;
        border-radius: 6px;
      }

      .tagline {
        margin: 6px 0 0;
        font-size: 12px;
        line-height: 1.25;
        color: #5b5b60;
      }

      .title {
        margin: 20px 0 0;
        font-size: 13.5px;
        line-height: 1.18;
        font-weight: 700;
        letter-spacing: 0;
      }

      .meta {
        margin-top: 18px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        font-size: 13px;
        line-height: 1.2;
        font-weight: 400;
        letter-spacing: 0;
        color: #303033;
      }

      .repository {
        font-size: 12px;
        color: #5b5b60;
        word-break: break-all;
      }


      .runtime-identity {
        font-size: 10px;
        line-height: 1.3;
        overflow-wrap: anywhere;
        user-select: text;
        -webkit-app-region: no-drag;
      }
      body.has-runtime-identity .about-window { height: 100%; }
      body.has-runtime-identity .content { overflow-y: auto; }

      .ok-button {
        width: 100%;
        height: 36px;
        border: 0;
        border-radius: 18px;
        background: var(--about-primary);
        color: var(--about-primary-foreground);
        font: inherit;
        font-size: 13px;
        font-weight: 500;
        letter-spacing: 0;
        outline: none;
        cursor: default;
        -webkit-app-region: no-drag;
      }

      .ok-button:active {
        background: var(--about-primary-active);
      }

      @media (prefers-color-scheme: dark) {
        :root {
          --startup-page-bg: #171717;
          --about-primary: #fafafa;
          --about-primary-foreground: #0a0a0a;
          --about-primary-active: color-mix(in oklab, var(--about-primary) 80%, transparent);
        }

        .about-card {
          color: #e8e8e8;
        }

        .meta {
          color: #e2e2e2;
        }

        .tagline,
        .repository {
          color: #a1a1a6;
        }
      }
      /* ZAICODE diagnostics share the Golden Default palette, not the upstream About theme. */
      body.has-runtime-identity {
        --background: #1A1810; --surface: #332E22; --surfaceRaised: #3D372A;
        --borderDark: #100E08; --bevelLight: #75663D;
        --textPrimary: #D4C89A; --textSecondary: #9C9371;
        background: var(--background); color: var(--textPrimary);
      }
      body.has-runtime-identity * {
        font-family: Verdana, sans-serif !important;
        -webkit-font-smoothing: none !important;
        text-rendering: optimizeSpeed !important;
        border-radius: 0 !important; box-shadow: none !important;
      }
      body.has-runtime-identity .about-card {
        padding: 12px; background: var(--surfaceRaised); color: var(--textPrimary);
        border: 2px solid;
        border-color: var(--bevelLight) var(--borderDark) var(--borderDark) var(--bevelLight);
      }
      body.has-runtime-identity .title { margin-top: 8px; font-size: 14px; }
      body.has-runtime-identity .meta { margin-top: 8px; gap: 8px; font-size: 12px; color: var(--textPrimary); }
      body.has-runtime-identity .tagline, body.has-runtime-identity .repository { color: var(--textSecondary); }
      body.has-runtime-identity .app-icon { background: var(--surface); border: 0; }
      body.has-runtime-identity .ok-button {
        background: var(--surface); color: var(--textPrimary); font-size: 12px;
        border: 2px solid;
        border-color: var(--bevelLight) var(--borderDark) var(--borderDark) var(--bevelLight);
      }
      body.has-runtime-identity .ok-button:focus-visible { outline: 1px dotted var(--textPrimary); outline-offset: -4px; }
      body.has-runtime-identity .ok-button:active { border-color: var(--borderDark) var(--bevelLight) var(--bevelLight) var(--borderDark); }

    </style>
  </head>
  <body${input.identityLines?.length ? ' class="has-runtime-identity"' : ""}>
    <main class="about-window" aria-label="${escapeHtml(input.applicationName)} About Window">
      <section class="about-card" role="dialog" aria-modal="true" aria-labelledby="about-title">
        <div class="content">
          <div class="app-icon" aria-hidden="true">
            ${
              input.logoDataUri
                ? // Not escaped: built by the caller from a local file's bytes, so it is
                  // base64 and cannot contain a quote or a closing tag.
                  `<img class="app-logo-img" src="${input.logoDataUri}" alt="" />`
                : `<svg
              xmlns="http://www.w3.org/2000/svg"
              width="118"
              height="100"
              fill="none"
              viewBox="0 0 256 218"
              class="app-logo"
              focusable="false"
            >
              <path
                fill="currentColor"
                d="M134.4 0.130152L116.48 25.6022C113.665 29.5699 109.054 32.0019 104.064 32.0019H6.3999V0C6.3999 0.130149 134.4 0.130152 134.4 0.130152Z"
              />
              <path fill="currentColor" d="M256 0.130127L102.401 217.732H0L153.599 0.130127H256Z" />
              <path
                fill="currentColor"
                d="M121.601 217.732L139.65 192.134C142.465 188.166 147.076 185.734 152.067 185.734H249.604V217.736H121.601V217.732Z"
              />
            </svg>`
            }
          </div>
          <h1 id="about-title" class="title">
            ${escapeHtml(input.applicationName)}<br />
            ${escapeHtml(input.versionLabel)} ${escapeHtml(input.appVersion)}
          </h1>
          ${input.tagline ? `<p class="tagline">${escapeHtml(input.tagline)}</p>` : ""}
          <div class="meta">
            ${input.optimizationLine ? `<div>${escapeHtml(input.optimizationLine)}</div>` : ""}
            <div>${escapeHtml(input.copyright)}</div>
            ${input.repository ? `<div class="repository">${escapeHtml(input.repository)}</div>` : ""}
            ${input.identityLines?.length ? `<div class="runtime-identity">${input.identityLines.map((line) => `<div>${escapeHtml(line)}</div>`).join("")}</div>` : ""}
          </div>
        </div>
        <div class="spacer"></div>
        <button class="ok-button" type="button" autofocus>${escapeHtml(input.okButtonLabel)}</button>
      </section>
    </main>
    <script>
      const closeWindow = () => window.close();
      document.querySelector(".ok-button")?.addEventListener("click", closeWindow);
      window.addEventListener("keydown", (event) => {
        if (event.key === "Escape" || event.key === "Enter") {
          closeWindow();
        }
      });
    </script>
  </body>
</html>`;
}
