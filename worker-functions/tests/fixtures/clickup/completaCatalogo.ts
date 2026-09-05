/**
 * completaCatalogo — o antídoto para a lista de catálogo escrita à mão em cada suíte.
 *
 * ── O problema que este arquivo resolve, e ele já aconteceu 3 vezes ─────────
 * O preflight da 1.11 exige que TODO campo de `PATIENT_CATALOG_FIELDS` exista no catálogo,
 * senão o mapper lança e não escreve nada — comportamento correto e desejado. Só que **seis**
 * suítes montam o catálogo à mão. Toda vez que um campo entra na lista do mapper, as seis
 * quebram de uma vez, por CONTAGEM e não por defeito:
 *
 *   - task 1.12, ao declarar `Equipo Tratante Multidisciplinario` (o 8º);
 *   - task 3.2, ao declarar `Cobertura Verificada` (o 9º) — 34 testes vermelhos;
 *   - e vai acontecer de novo na Fase 4, que declara mais quatro.
 *
 * É o F20/F49/F51 desta casa: duas listas escritas à mão divergem em silêncio. Aqui a
 * divergência é barulhenta (o preflight lança), o que é sorte — mas o custo é remendar seis
 * arquivos a cada campo novo, e alguém eventualmente remenda errado.
 *
 * ── O que ele faz ───────────────────────────────────────────────────────────
 * Recebe o catálogo que a suíte montou e **acrescenta um stub** para cada campo declarado que
 * estiver faltando. O que a suíte definiu é preservado byte a byte — o helper só preenche
 * buraco, nunca sobrescreve. Assim cada suíte continua controlando os campos que ela de fato
 * testa, e para de se importar com os que existem só para o preflight passar.
 *
 * ⚠️ O stub tem UMA opção, de propósito. Catálogo vazio faria `resolveDropdown` devolver
 * `null` para todo valor, e um teste que espere leitura bem-sucedida falharia por um motivo
 * que não é o dele.
 */

import { PATIENT_CATALOG_FIELDS } from '../../../src/modules/integration/infrastructure/clickup/ClickUpPatientMapper';
import { normalizeExpectation } from '../../../src/modules/integration/infrastructure/clickup/helpers/dropdownCatalogGuard';

interface CampoDoCatalogo {
  id: string;
  name: string;
  type: string;
  type_config?: { options?: Array<{ id: string; name?: string; label?: string; orderindex: number }> };
}

/**
 * ⚠️ **`exceto` não é conveniência — é o que impede o helper de destruir o teste.** Suítes que
 * provam o preflight APAGAM um campo de propósito e esperam que o mapper lance. Sem `exceto`, o
 * helper repõe justamente esse campo, o preflight passa, e o teste fica verde sobre o oposto do
 * que ele afirma — um falso-verde criado pela ferramenta que existia para evitar falso-vermelho.
 * Medido: a 1ª versão deste arquivo derrubou 3 testes da 1.11 exatamente assim.
 *
 * @param campos o que a suíte montou à mão
 * @param opts.exceto campos que a suíte remove DE PROPÓSITO; o helper não os repõe
 * @param opts.tipoPadrao tipo do stub. `drop_down` serve ao preflight de todos os campos hoje;
 *        uma suíte que precise do campo como `labels` deve declará-lo ela mesma.
 */
export function completaCatalogo(
  campos: readonly CampoDoCatalogo[],
  opts: { exceto?: readonly (string | null | undefined)[]; tipoPadrao?: 'drop_down' | 'labels' } = {},
): CampoDoCatalogo[] {
  const tipoPadrao = opts.tipoPadrao ?? 'drop_down';
  const omitidos = new Set((opts.exceto ?? []).filter((x): x is string => typeof x === 'string'));
  const jaTem = new Set(campos.map(c => c.name));
  const completo = [...campos];
  let n = 0;
  for (const esperado of PATIENT_CATALOG_FIELDS) {
    const { field } = normalizeExpectation(esperado);
    if (jaTem.has(field) || omitidos.has(field)) continue;
    n += 1;
    completo.push({
      id: `stub-${n}`,
      name: field,
      type: tipoPadrao,
      type_config: { options: [{ id: `stub-${n}-0`, name: 'STUB', label: 'STUB', orderindex: 0 }] },
    });
  }
  return completo;
}
