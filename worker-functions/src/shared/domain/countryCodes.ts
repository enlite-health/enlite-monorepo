/**
 * src/shared/domain/countryCodes.ts
 *
 * FONTE ÚNICA das jurisdições suportadas pelo sistema (D108 — multi-jurisdição
 * BR+AR). Tudo que precisa da lista — enum zod de rota pública, config de
 * admissão por país, GUC `app.user_country` da RLS — deriva DAQUI.
 *
 * Por que fonte única e não "duas listas iguais": a lista existia em dois
 * lugares (`modules/matching/domain/admissionCountries.ts`, que já se declarava
 * single source, e `shared/database/requestDbSession.ts`). Duas tuplas literais
 * com o mesmo conteúdo passam no `tsc` e nos testes até o dia em que a terceira
 * jurisdição entra em uma e não na outra — e aí o país é aceito na borda e
 * recusado (ou pior, aceito sem policy) no banco. Os dois módulos agora
 * RE-EXPORTAM daqui, preservando os nomes públicos que os callers já usam.
 *
 * Manter em sincronia com o CHECK do banco (`valid_patient_country`, migrations
 * 069/252) e com os grupos de escopo de país (migrations 268-272).
 */

/** Jurisdições suportadas. Ordem é a de adoção (AR primeiro, BR na D108). */
export const COUNTRY_CODES = ['AR', 'BR'] as const;

export type CountryCode = (typeof COUNTRY_CODES)[number];

/** Type guard para `country` vindo de query/body/claim (entrada não confiável). */
export function isCountryCode(value: unknown): value is CountryCode {
  return typeof value === 'string' && (COUNTRY_CODES as readonly string[]).includes(value);
}
