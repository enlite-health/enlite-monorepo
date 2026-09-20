/**
 * safeStorageErrorFields — campos SEGUROS pra log de erro de storage (GCS), sem o nome do objeto.
 *
 * Conserto da 3ª revisão do PR-4 (spec 018): vários chamadores de `PatientPhotoStorage`/
 * `PatientDocumentStorage` (que relançam o erro cru do `@google-cloud/storage` — ver
 * `PatientObjectStorageBase.delete`) logavam `{ err }` inteiro. Pino serializa `err.message`, e a
 * mensagem do `@google-cloud/storage` costuma trazer o NOME DO OBJETO (ex.: "No such object:
 * bucket/uuid.jpg") — objectPath nunca pode ir a log (lex-pr4-foto #6/#9). Mesmo critério já usado
 * em `PatientObjectStorageBase.delete` e `PatientPhotoOrphanRetryService.retryOne`, agora num único
 * helper reusado por todo caminho pós-commit destas duas classes (task 4.3h/4.8, item 3 da 3ª
 * revisão): `code`/`status` identificam a CLASSE do erro sem carregar o caminho; `name` é a classe
 * do erro (`Error`, `TypeError`, ...), nunca `message` nem `stack`.
 */
export function safeStorageErrorFields(err: unknown): { code: number | undefined; status: number | undefined; name: string } {
  return {
    code: (err as { code?: number } | null | undefined)?.code,
    status: (err as { response?: { status?: number } } | null | undefined)?.response?.status,
    name: err instanceof Error ? err.name : typeof err,
  };
}
