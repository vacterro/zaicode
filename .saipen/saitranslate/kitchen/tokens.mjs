/** Technical syntax and product identity are source tokens, not prose. */
export function technicalTokens(value) {
  return [...value.matchAll(/https?:\/\/[^\s)"<>]+|`[^`]+`|\b(?:ZAICODE|ZCode|SAIPEN|SAIMAIL|SAIFREN|SAIOPP|SAIRoute|SAIHOME|9router|ProTrail|Claude|Codex|GitHub|Antigravity|BigModel|Node\.js)\b/g)].map(match=>match[0]).sort();
}
export function suspiciousTranslation(source,value) {
  return value === '=' && source !== '=' || /^\{protected\d+\}$/.test(source) && value !== source || source.length > 50 && value.length < Math.max(4,source.length * 0.12);
}
