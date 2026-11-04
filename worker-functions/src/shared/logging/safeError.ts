/**
 * Error SEM PII para o `reportError`. Erros do `pg` carregam VALOR na mensagem (`invalid input syntax for type uuid: "x"`)
 * e no `detail` ("Key (email)=(x@y.com) ..."), e o serializador do logger escreve `message`, `stack` e propriedades.
 * Regra: erro com `code` (driver pg) vira só `code` + `constraint`; erro sem `code` (nosso) mantém a 1ª linha da mensagem.
 * A stack é reconstruída: cabeçalho seguro + só os frames `    at ...` (o cabeçalho original repete a mensagem).
 */
export function toSafeError(err: unknown): Error {
  const e = err as { name?: string; message?: string; stack?: string; code?: string; constraint?: string };
  const message = e?.code
    ? ['db error', `code=${e.code}`, e.constraint ? `constraint=${e.constraint}` : null].filter(Boolean).join(' ')
    : String(e?.message ?? err).split('\n')[0];
  const safe = new Error(message);
  safe.name = e?.name ?? 'Error';
  if (e?.stack) {
    const frames = e.stack.split('\n').filter((l) => /^\s+at /.test(l));
    safe.stack = [`${safe.name}: ${message}`, ...frames].join('\n');
  }
  return safe;
}
