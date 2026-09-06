import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { DECRYPT_BATCH } from '@shared/security/decryptBatch';
import { logger } from '@shared/logging';
import { isLeadPlaceholderName, maskEmail } from '../domain/LeadContact';
import type { PatientListRow } from './PatientQueryRows';

/**
 * PatientLeadContactAttacher — a SEGUNDA PASSADA da listagem de pacientes.
 *
 * Extraído de `PatientQueryRepository` para manter aquele arquivo dentro do teto de 400 linhas
 * (mesmo molde de `PatientRelatedWriter`). Só mudou de arquivo: mesma ordem, mesmos lotes,
 * mesmos contadores, mesma linha de log.
 *
 * Responsabilidade única — e é a única parte da listagem que TOCA no KMS: decidir quais linhas
 * merecem descriptografia (as de nome placeholder) e devolver o contato já MASCARADO.
 */

/**
 * Segunda passada da listagem: desempata os cards que só dizem "Solicitante".
 *
 * O formulário público não colhe nome (`2026-07-27a#DEC-02`), então todo lead
 * chega com o mesmo placeholder e o Kanban vira N caixas idênticas. Aqui o
 * contato entra MASCARADO para desempatá-las — sob as condições do parecer
 * do lex de 30/08:
 *
 *  C2 — o corte é no servidor: só linha com placeholder é tocada. Ficha com
 *       nome real sai com `null`, e o ciphertext dela nunca vira texto.
 *  C4 — por consequência, o nº de chamadas ao KMS é EXATAMENTE o nº de linhas
 *       com placeholder — e ZERO numa página sem nenhuma. Este caminho de
 *       listagem não chamava o KMS antes; a conta é o controle positivo.
 *  C1 — a máscara é aplicada aqui, não no React: o valor cru não entra no
 *       payload, no devtools nem na gravação de sessão.
 *  C6 — nos leads preenchidos pelo familiar o paciente não tem e-mail
 *       (CreateLeadUseCase grava o contato no responsável); marcamos de quem
 *       é, para o card não atribuir contato de terceiro ao paciente.
 *
 * Falha de descriptografia não derruba a listagem: o card volta ao estado
 * anterior (só "Solicitante"), que é degradação, não perda de dado.
 */
export async function attachLeadContact(
  enc: KMSEncryptionService,
  rows: PatientListRow[],
  raw: Array<Record<string, unknown>>,
): Promise<void> {
  const pending = rows
    .map((row, idx) => ({ row, raw: raw[idx] }))
    .filter(({ row }) => isLeadPlaceholderName(row.firstName, row.lastName));

  if (pending.length === 0) return;

  // Contadores para o sinal do fim: sem eles, dado que deriva de forma faz TODOS
  // os cards perderem o contato em silêncio absoluto (blocker do gate, 31/08).
  let recusados = 0;
  let falhas = 0;
  // Sem esta 3ª coluna, um rename do alias do SQL zera TODOS os cards com
  // recusados=0 e falhas=0 — silêncio absoluto (aviso 1 do gate, 31/08).
  let semCifra = 0;

  // Lotes de DECRYPT_BATCH: `Promise.all` sobre a página inteira dispararia até
  // 500 chamadas simultâneas ao KMS (teto do adminPatientsListSchema). O padrão
  // e o número vêm de AdminWorkersMapController.ts:51, que já resolve isso.
  for (let inicio = 0; inicio < pending.length; inicio += DECRYPT_BATCH) {
  await Promise.all(
    pending.slice(inicio, inicio + DECRYPT_BATCH).map(async ({ row, raw: r }) => {
      // O e-mail do paciente manda; o do responsável é o fallback dos leads
      // preenchidos pelo familiar. Só UM dos dois é descriptografado.
      const own = (r.contactEmailEnc as string | null) ?? null;
      const responsible = (r.responsibleEmailEnc as string | null) ?? null;
      const cipher = own ?? responsible;
      if (cipher == null) { semCifra += 1; return; }

      try {
        const plain = await enc.decrypt(cipher);
        const masked = maskEmail(plain);
        if (masked == null) { recusados += 1; return; }
        row.leadContactEmailMasked = masked;
        row.leadContactIsResponsible = own == null;
      } catch {
        // Degrada o card, não a listagem — mas CONTA (ver o warn abaixo).
        falhas += 1;
      }
    }),
  );
  }

  // O que era silêncio absoluto vira sinal. Só CONTAGEM: a regra dura proíbe
  // PII em log e permite contar (o V5 do gate afirma exatamente isso).
  if (recusados > 0 || falhas > 0 || semCifra > 0) {
    logger.warn({
      msg: 'patient_lead_contact.degraded',
      pendentes: pending.length,
      recusadosPelaMascara: recusados,
      falhasDeKms: falhas,
      semCifra,
    });
  }
}
