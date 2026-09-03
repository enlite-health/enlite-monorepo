/**
 * PhoneMatch — spec 014, US-D3/lex D3.1 (D3.1 medido em produção 03/09: 5 de 37 pacientes com
 * telefone têm no campo o telefone de um responsável — decrypt KMS em memória, só a contagem).
 *
 * Antes do rename "Teléfono del Responsable" → "WhatsApp del paciente", o backend expõe se o
 * `phone_whatsapp` do paciente COINCIDE com o telefone de algum responsável — pelos ÚLTIMOS 8
 * DÍGITOS (absorve prefixo de país/DDD divergente entre os dois cadastros). Nunca loga o número
 * — só o booleano (e, no detalhe, o nome do responsável, já decriptado pelo mesmo request).
 */

function last8Digits(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 8) return null; // curto demais pra comparar com confiança
  return digits.slice(-8);
}

/** true quando `patientPhone` coincide (últimos 8 dígitos) com QUALQUER telefone em `responsiblePhones`. */
export function phoneMatchesResponsible(
  patientPhone: string | null | undefined,
  responsiblePhones: Array<string | null | undefined>,
): boolean {
  const patientLast8 = last8Digits(patientPhone);
  if (patientLast8 === null) return false;
  return responsiblePhones.some((rp) => last8Digits(rp) === patientLast8);
}
