/**
 * PatientSourceLabelCeiling — o TETO de rótulos crus por (paciente, campo), e o erro que ele
 * produz.
 *
 * Extraído de `PatientSourceLabelRepository` para manter aquele arquivo dentro do teto de 400
 * linhas do `CLAUDE.md` (o mesmo teto que o `PatientRelatedWriter` cita). Nenhum número, nenhum
 * campo e nenhuma mensagem mudou — só o endereço.
 *
 * O repositório continua re-exportando tudo daqui: nenhum chamador precisou trocar de import.
 */

/** O teto. Espelha o CHECK `patient_source_labels_ceiling_3` da migration 304. */
/**
 * Teto PADRÃO de rótulos crus por (paciente, campo). D166/D-C, sobre segmento clínico.
 *
 * ⚠️ Não é mais o único: a migration 306 deu teto **5** a `Tipo de Dispositivo`, igual à
 * cardinalidade do catálogo dele — com isso truncar vira impossível em vez de administrado
 * (C-E′ do parecer do `lex`). Use `tetoDoCampo()`, nunca esta constante direto.
 */
export const PATIENT_SOURCE_LABEL_CEILING = 3;

/**
 * Tetos por campo que FOGEM do padrão. Espelha o `CHECK` da migration 306.
 *
 * ⚠️ **Duas constantes escritas à mão divergem em silêncio** — é o F20/F49/F51 desta casa, e já
 * mordeu 4× nesta change. Por isso existe um teste que LÊ a migration e compara com este mapa:
 * `tests/unit/__tests__/clickup-4.2-teto-por-campo.test.ts`. Se você mudar um lado sem o outro,
 * ele fica vermelho — o banco recusaria a escrita e o TypeScript acharia que podia.
 */
export const PATIENT_SOURCE_LABEL_CEILING_POR_CAMPO: Readonly<Record<string, number | null>> = {
  // `null` = SEM teto. Ver migration 309: o limite deste campo é a FK de
  // `patient_device_types` para `device_types`, que se ajusta sozinha quando o catálogo muda.
  // A versão anterior punha `5` aqui, espelhando a cardinalidade do catálogo — e o catálogo
  // virou editável sem deploy no mesmo dia, o que tornava o 5 uma mentira no 6º tipo criado.
  'Tipo de Dispositivo': null,
};

/**
 * O teto que vale para um campo. `null` = sem teto.
 *
 * ⚠️ É esta função que o código deve consultar, nunca a constante direto — o teto deixou de ser
 * único quando `Tipo de Dispositivo` saiu da regra.
 */
export function tetoDoCampo(fieldName: string): number | null {
  return fieldName in PATIENT_SOURCE_LABEL_CEILING_POR_CAMPO
    ? PATIENT_SOURCE_LABEL_CEILING_POR_CAMPO[fieldName]
    : PATIENT_SOURCE_LABEL_CEILING;
}

/** Erro de recusa por teto no caminho de APPEND (`appendForField`). */
export class PatientSourceLabelCeilingError extends Error {
  constructor(
    readonly fieldName: string,
    readonly stored: number,
    readonly ceiling: number,
  ) {
    // Sem paciente e sem rótulo na mensagem — ela vai para log (C1).
    super(`[PatientSourceLabelRepository] ceiling reached for field "${fieldName}": ${stored}/${ceiling}`);
    this.name = 'PatientSourceLabelCeilingError';
  }
}
