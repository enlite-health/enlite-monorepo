/**
 * C5 — gate POR COLUNA no `GET /api/admin/workers/export`.
 *
 * `worker:export` autoriza exportar. Ela NÃO autoriza exportar o dossiê: as
 * colunas de dossiê exigem `worker_pii:read` **cumulativa** — as duas células,
 * não uma ou outra. Sem isso, dar `worker:export` a quem precisa de uma planilha
 * de contatos entrega DNI, nascimento, endereço, raça, religião e orientação
 * sexual de todo o cadastro, num arquivo que sai do sistema (D168).
 *
 * ── Quais colunas, e por que estas ──────────────────────────────────────────
 * A C5 nomeia cinco: `race`, `religion`, `sexual_orientation`, `document_number`,
 * `birth_date`. A lista aqui tem SEIS, e a sexta é `address_line`.
 *
 * ⚠️ A sexta é escolha minha, e o critério é não deixar o portão pela metade: a
 * D168 define o nível `worker_pii` como *"DNI, nascimento, **endereço**, fotos,
 * raça, religião, orientação sexual"*. Fechar cinco dos seis itens da MESMA
 * definição e deixar o endereço aberto seria um gate que parece fechado. O gate
 * é a definição da D168, não uma lista escrita à mão — é assim que ele não
 * envelhece errado.
 *
 * ⚖️ NÃO estão aqui, e é decisão pendente do Gabriel, não esquecimento:
 *   · `document_type` — o TIPO do documento sem o número. A D168 não o nomeia.
 *   · `postal_code` — mais grosso que endereço e mais fino que cidade.
 *   · `first_name`/`last_name`/`phone`/`whatsapp_phone`/`email` — são
 *     `worker_contact:read`, não dossiê. Gatear contato NO EXPORT muda o que a
 *     planilha serve para fazer, e a C5 não pede. Vai para lista.
 */

import type { WorkerExportColumnKey } from './workerExportColumns';

/** As colunas de DOSSIÊ — nível `worker_pii:read` da D168. */
export const COLUNAS_DE_DOSSIE: ReadonlySet<WorkerExportColumnKey> = new Set<WorkerExportColumnKey>([
  'document_number',
  'birth_date',
  'address_line',
  'race',
  'religion',
  'sexual_orientation',
]);

export const CELL_WORKER_PII_READ = 'worker_pii:read';

export interface ColunasDecididas {
  /** O que o ator PODE exportar, na ordem em que pediu. */
  permitidas: WorkerExportColumnKey[];
  /** O que foi tirado por falta de célula — nunca some em silêncio. */
  negadas: WorkerExportColumnKey[];
}

/**
 * Decide quais colunas saem.
 *
 * ⚠️ `cells === null` NÃO é "nenhuma célula": é "o engine não decidiu nesta
 * request" (família fora de `PERMISSION_ENFORCED_ROUTES`, principal de serviço,
 * engine desligado). Devolve o que a rota já devolvia — D113. `[]` é ator
 * conhecido e sem célula, e aí o dossiê cai.
 */
export function decidirColunas(
  cells: string[] | null,
  pedidas: readonly WorkerExportColumnKey[],
): ColunasDecididas {
  if (cells === null || cells.includes(CELL_WORKER_PII_READ)) {
    return { permitidas: [...pedidas], negadas: [] };
  }

  const permitidas: WorkerExportColumnKey[] = [];
  const negadas: WorkerExportColumnKey[] = [];
  for (const c of pedidas) {
    (COLUNAS_DE_DOSSIE.has(c) ? negadas : permitidas).push(c);
  }
  return { permitidas, negadas };
}
