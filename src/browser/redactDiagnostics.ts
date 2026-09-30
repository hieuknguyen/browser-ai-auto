/** Conservative default cleanup; session-specific secrets are removed first. */
export function redactDiagnostics(value: string, redact?: (value: string) => string): string {
  return (redact ? redact(value) : value)
    .replace(/\bBearer\s+[a-zA-Z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:token|access_token|api_key|key|secret|password|authorization|code)=)[^&\s"'<>]*/gi, '$1[REDACTED]')
    .replace(/(\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|authorization)\b["']?\s*[:=]\s*["']?)[^\s,;"'}]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[REDACTED]@');
}
