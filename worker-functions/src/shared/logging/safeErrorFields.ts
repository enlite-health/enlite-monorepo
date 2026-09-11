/**
 * Campos de erro SEGUROS para log estruturado — nunca `message` nem `stack`.
 *
 * Por quê: mensagens de erro do `pg` carregam VALOR interpolado (ex.:
 * `invalid input syntax for type uuid: "<valor>"`), e alguns repositórios desta
 * casa interpolam código de dispositivo/cobertura/chat id na própria mensagem.
 * Como o dado clínico e pessoal do paciente passa por essas colunas, logar
 * `message`/`stack` cru é logar PII/dado clínico — proibido pela regra dura do
 * projeto ("Nunca logar PII"; "texto clínico NUNCA entra em log").
 *
 * `code` é o SQLSTATE quando o erro vem do driver `pg` (mesmo padrão já usado
 * em `PatientSourceLabelRejectionRecorder.fallbackRecord`). `errorName` é a
 * classe do erro (`Error`, `TypeError`, ...) — o suficiente para o operador
 * distinguir bug de dado torto sem expor o valor.
 */
export function safeErrorFields(err: unknown): { errorName: string; code: string | null } {
  return {
    errorName: err instanceof Error ? err.name : typeof err,
    code: (err as { code?: string } | null | undefined)?.code ?? null,
  };
}
