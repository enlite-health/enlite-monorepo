/**
 * matchProfile — spec 096 (DD-1, DD-11): perfil de match do prestador para a home (`view=home`).
 *
 * Régua do match real (`MatchmakingHardFilterQuery` + `ProfessionSpecification`), em funções PURAS para o teste ler o mesmo
 * texto que roda. Horário e profissão são fragmentos de SQL (`matchProfileSql`); sexo é TS (`passesSex`) porque o sexo do
 * prestador é cifrado (KMS) e nunca entra em SQL nem em log.
 *
 * - horário: todo dia do horário efetivo da vaga está em `worker_availability.day_of_week` do prestador. Só por DIA (como o
 *   match). Prestador SEM disponibilidade declarada não é filtrado (anti-exclusão, igual ao match); vaga sem horário passa.
 * - profissão: `COALESCE(workers.occupation, workers.profession)` ∈ profissões efetivas da vaga. Vaga com lista vazia passa
 *   (vazio ≠ ausência: divergência declarada do match, que joga `'[]' ? occ` como falso).
 *
 * CADASTRO COMPLETO (decisão do Gabriel, 19/11): a home só mostra mapa e vagas quando o prestador tem TUDO o que o perfil de
 * match precisa — endereço (zona viva), profissão, sexo e disponibilidade. `missingProfileItems` diz o que falta; com qualquer
 * item faltando a lista nem é consultada (as funções acima seguem puras e testáveis por ramo).
 */
import { normalizeSexValue } from '@shared/utils/normalizeSexValue';
import { vacancyEffectiveRequiredProfessionsSql, vacancyEffectiveScheduleSql } from '@shared/sql/vacancyEffectiveFieldsSql';

export interface MatchProfile {
  /** `true` = o prestador declarou disponibilidade: o horário filtra. */
  hasAvailability: boolean;
  /** `COALESCE(occupation, profession)` do prestador; `null` = não filtra por profissão. */
  occupation: string | null;
}

export interface MatchProfileApplied {
  schedule: boolean;
  profession: boolean;
  sex: boolean;
}

export function profileApplied(profile: MatchProfile): MatchProfileApplied {
  return { schedule: profile.hasAvailability, profession: profile.occupation !== null, sex: true };
}

/** O que a home exige do cadastro para mostrar mapa e vagas (ordem = ordem em que a tela pede). */
export type MissingProfileItem = 'address' | 'profession' | 'sex' | 'availability';
export const MISSING_PROFILE_ITEMS = ['address', 'profession', 'sex', 'availability'] as const;

/** Estado do cadastro, sem nenhum dado clínico nem o valor do sexo: só "tem / não tem". */
export interface ProfileCompleteness {
  hasAddress: boolean;
  hasProfession: boolean;
  hasSex: boolean;
  hasAvailability: boolean;
}

/** Itens que faltam para a home mostrar mapa e vagas; `[]` = cadastro completo. */
export function missingProfileItems(c: ProfileCompleteness): MissingProfileItem[] {
  const missing: MissingProfileItem[] = [];
  if (!c.hasAddress) missing.push('address');
  if (!c.hasProfession) missing.push('profession');
  if (!c.hasSex) missing.push('sex');
  if (!c.hasAvailability) missing.push('availability');
  return missing;
}

/**
 * Fragmento `AND ...` (ou '') para o WHERE do reader. `workerParam` e `occupationParam` são placeholders ($n) já
 * numerados pelo chamador; `jp` é o alias da vaga (com `vacancyEffectiveJoinSql` no FROM).
 */
export function matchProfileSql(
  profile: MatchProfile,
  opts: { jp: string; workerParam: string; occupationParam: string },
): string {
  const parts: string[] = [];
  if (profile.hasAvailability) {
    parts.push(
      `AND NOT EXISTS (
           SELECT 1
           FROM jsonb_to_recordset(COALESCE(${vacancyEffectiveScheduleSql(opts.jp)}, '[]'::jsonb)) AS vd("dayOfWeek" int)
           WHERE NOT EXISTS (
             SELECT 1 FROM worker_availability wa
             WHERE wa.worker_id = ${opts.workerParam} AND wa.day_of_week = vd."dayOfWeek"
           )
         )`,
    );
  }
  if (profile.occupation !== null) {
    const profs = vacancyEffectiveRequiredProfessionsSql(opts.jp);
    parts.push(`AND (cardinality(${profs}) = 0 OR ${opts.occupationParam}::text = ANY(${profs}))`);
  }
  return parts.length === 0 ? '' : `\n         ${parts.join('\n         ')}`;
}

function sexCode(value: string | null | undefined): 'M' | 'F' | null {
  const canonical = normalizeSexValue(value);
  if (canonical === 'MALE') return 'M';
  if (canonical === 'FEMALE') return 'F';
  return null;
}

/**
 * Sexo (conservador, como `runHardFilter`): vaga BOTH/nula passa; vaga M/F exige prestador com sexo cadastrado E igual;
 * prestador sem sexo é excluído quando a vaga restringe.
 */
export function passesSex(requiredSex: string | null | undefined, workerSex: string | null | undefined): boolean {
  const required = sexCode(requiredSex);
  if (!required) return true;
  return sexCode(workerSex) === required;
}
