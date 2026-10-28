interface DesktopTelemetryFetchSource {
  // Electron's net.fetch takes string | Request (no URL), unlike the DOM fetch this
  // wrapper exposes; normalise URL -> string at the call so `net` is assignable here.
  fetch: (input: string | Request, init?: RequestInit) => Promise<Response>;
}

export function createDesktopTelemetryFetch(source: DesktopTelemetryFetchSource): typeof fetch {
  return (input, init) => source.fetch(input instanceof URL ? input.href : input, init);
}
