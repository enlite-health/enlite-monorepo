/**
 * pgUniqueViolationConflict — o mapeamento do `23505` (unique_violation) do Postgres para HTTP 409
 * que antes vivia duplicado em `AdminPatientAddressesController` e `AdminPatientsController`: as
 * duas rotas de escrita de endereço de paciente perdem a corrida contra o mesmo índice único
 * parcial (`patient_addresses_one_default_per_patient`) e respondem 409 com o texto idêntico
 * "Concurrent update — try again" — cada uma checando `err.code` no próprio `catch`.
 *
 * Só reconhece `23505`; qualquer outro código (ou erro sem `code`) devolve `null` e o chamador
 * segue para o tratamento genérico (`reportError` + 500) — nunca mascara um erro real.
 *
 * `message` é parâmetro, não hardcode: os dois sites de hoje usam o mesmo texto, mas o helper não
 * decide a mensagem — quem chama decide, e cada resposta continua byte a byte igual à de antes.
 */
export function pgUniqueViolationConflict(
  err: unknown,
  message: string,
): { success: false; error: string } | null {
  const code = (err as { code?: string } | null)?.code;
  if (code !== '23505') return null;
  return { success: false, error: message };
}
