/**
 * Central secret redaction (spec section 14). Every log line and error string that
 * could contain credentials passes through redact().
 */
const PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g, // OpenAI-style
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic-style
  /\bAIza[0-9A-Za-z_-]{20,}/g, // Google API keys
  /\bxai-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /("?(?:api[_-]?key|authorization|password|secret|token)"?\s*[:=]\s*"?)([^"\s,}]{4,})/gi,
];

export function redact(input: string): string {
  let out = input;
  out = out.replace(PATTERNS[5]!, "$1[REDACTED]");
  out = out.replace(PATTERNS[6]!, "$1[REDACTED]");
  for (const p of PATTERNS.slice(0, 5)) out = out.replace(p, "[REDACTED]");
  return out;
}

export function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return `****${key.slice(-4)}`;
}
