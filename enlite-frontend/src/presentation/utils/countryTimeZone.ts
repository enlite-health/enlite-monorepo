/**
 * Fuso IANA por país de operação — fonte única (aba Admissão do painel e página pública de agendamento).
 * Sempre explícito: nunca o fuso do navegador.
 */
export const COUNTRY_TIME_ZONE: Readonly<Record<string, string>> = {
  AR: 'America/Argentina/Buenos_Aires',
  BR: 'America/Sao_Paulo',
  UY: 'America/Montevideo',
};
