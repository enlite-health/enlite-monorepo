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
 *   (vazio ≠ ausência: divergência declarada do match, que joga `'[]' ? occ` como falso). Prestador sem profissão não é
 *   filtrado e `applied.profession` diz isso (decisão do executor, ver LISTA do PR).
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
