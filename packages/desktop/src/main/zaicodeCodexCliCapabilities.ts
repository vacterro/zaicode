/** Only advertised options are sent to a worker, so older installations still launch. */
export function zaicodeCodexCliCapabilities(help: string) {
  const option = (name: string) => new RegExp(`^\\s*${name}(?:\\s|$)`, "m").test(help);
  return {
    noDaemon: option("--no-daemon"),
    hookTrustBypass: option("--dangerously-bypass-hook-trust"),
  };
}
