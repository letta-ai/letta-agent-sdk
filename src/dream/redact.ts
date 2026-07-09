/** Remove credential-shaped values before transcripts become run artifacts. */
export function redactSensitiveText(text: string): string {
  return text
    .replace(
      /(LETTA_API_KEY\s*[=:]\s*)[^\s"'\\]+/gi,
      "$1[REDACTED_LETTA_API_KEY]",
    )
    .replace(/sk-let-[A-Za-z0-9_+=/-]+/g, "[REDACTED_LETTA_API_KEY]");
}
