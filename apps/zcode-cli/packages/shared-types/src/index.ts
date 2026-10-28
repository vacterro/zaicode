export type JsonValue =
  | boolean
  | null
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type RunContext = {
  argv: string[];
  stderr: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
};

export type GlobalLocale = "auto" | "en-US" | "ru-RU" | "et-EE" | "uk-UA" | "ja-JP" | "ded" | "zh-CN" | "de-DE" | "fr-FR" | "es-ES" | "it-IT" | "pt-BR" | "nl-NL" | "pl-PL" | "sv-SE" | "da-DK" | "fi-FI" | "nb-NO" | "ko-KR" | "th-TH" | "vi-VN" | "ar-SA" | "he-IL" | "tr-TR" | "hi-IN" | "id-ID" | "el-GR" | "cs-CZ" | "ro-RO" | "hu-HU" | "bg-BG" | "sk-SK" | "hr-HR";
export type GlobalDetectedLocale = Exclude<GlobalLocale, "auto">;

/**
 * How a headless run reports itself.
 *
 * `text` prints the answer only. `json` prints one summary document after the
 * turn. `stream-json` additionally writes each session event as its own line
 * (NDJSON) while the turn runs, for callers that drive the CLI as a subprocess
 * and need progress — a bridge rendering a chat UI, for instance — rather than
 * only the finished answer.
 */
export type GlobalOutputFormat = "text" | "json" | "stream-json";

export type GlobalOptions = {
  browserExecutable?: string;
  browserUse?: "headless";
  detectedLocale?: GlobalDetectedLocale;
  force: boolean;
  json: boolean;
  locale?: GlobalLocale;
  memoryBench?: boolean;
  noColor: boolean;
  outputFormat?: GlobalOutputFormat;
  verbose: boolean;
};

export type RuntimeInfo = {
  arch: NodeJS.Architecture;
  cwd: string;
  execPath: string;
  node: string;
  platform: NodeJS.Platform;
  sea: boolean;
  versions: NodeJS.ProcessVersions;
};
