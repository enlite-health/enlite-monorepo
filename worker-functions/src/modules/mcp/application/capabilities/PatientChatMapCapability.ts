/**
 * PatientChatMapCapability
 *
 * A ponte de três pontas em massa: Postgres (`patientId`) ↔ ClickUp
 * (`clickupTaskId`) ↔ Periskope (os grupos de WhatsApp do paciente, POR PAPEL).
 *
 * POR QUE NÃO BASTA `db.query.readonly` (verificado, não suposto):
 *   1. Teto de linhas. `HARD_MAX_ROWS = 200` no ReadonlyDbQueryService, e a base
 *      tem 357 pacientes ativos hoje. Medido em produção em 08/08/2026: a query
 *      do mapa volta `truncated: true` com 200/357. Quem audita a base inteira
 *      numa rodada não consegue — teria que paginar na unha por OFFSET.
 *   2. Trava de PII. Em SQL livre, `SELECT * FROM patients` traz `first_name`,
 *      `phone_whatsapp` e `document_number`. Aqui a lista de colunas é fechada
 *      no repositório: não há como o payload vazar PII, mesmo sem querer.
 *   3. Direção reversa com contrato. `chatId` → paciente é a direção que a
 *      auditoria consome; vira um argumento estável em vez de SQL reescrito a
 *      cada consulta (e sem esquecer `deleted_at IS NULL`).
 *
 * `db.query.readonly` continua sendo o caminho certo para agregação ad-hoc — as
 * duas convivem. Esta é a leitura em massa, PII-safe, do mapa.
 *
 * Só leitura. Nunca escreve, e não fala com o Periskope.
 */

import { z } from 'zod';
import type {
  GetPatientChatMapUseCase,
  GetPatientChatMapResult,
} from '@modules/case';
import { GROUP_CHAT_ID_PATTERN, MAX_CHAT_MAP_LIMIT, PATIENT_CHAT_ROLE_VALUES } from '@modules/case';

const ArgsShape = {
  filter: z
    .enum(['linked', 'unlinked', 'all'])
    .optional()
    .describe(
      "Which patients to return. 'linked' (default) = has at least one WhatsApp group " +
        "linked, i.e. the map ready to cross-reference. 'unlinked' = the backfill work " +
        "queue. 'all' = everyone.",
    ),
  chatId: z
    .string()
    .regex(GROUP_CHAT_ID_PATTERN)
    .optional()
    .describe(
      'REVERSE lookup: given a Periskope group chat_id (…@g.us), return which patient ' +
        `it belongs to and in which role (${PATIENT_CHAT_ROLE_VALUES.join(' | ')}). ` +
        'Overrides filter/offset.',
    ),
  limit: z.number().int().min(1).max(MAX_CHAT_MAP_LIMIT).optional().describe('Page size (default 500, max 1000).'),
  offset: z.number().int().min(0).optional().describe('Rows to skip (default 0).'),
};
const ArgsSchema = z.object(ArgsShape).strip();

export class PatientChatMapCapability {
  static readonly NAME = 'patient.chat.map';
  static readonly DESCRIPTION =
    'Map patients to their WhatsApp group chat IDs (Periskope) and their ClickUp task id, ' +
    'in bulk — the join key for auditing daily reports. Returns patientId, clickupTaskId and ' +
    `chatIds: an object keyed by role (${PATIENT_CHAT_ROLE_VALUES.join(' | ')}); a role absent ` +
    'from the object means that group is not linked yet. Supports reverse lookup by chatId ' +
    '(which patient owns this group, and in which role) and filter=unlinked for the backfill ' +
    'queue. Identifiers only — never patient name, phone or document. Read-only.';
  static readonly INPUT_SHAPE = ArgsShape;

  constructor(private readonly useCase: GetPatientChatMapUseCase) {}

  async execute(args: unknown): Promise<GetPatientChatMapResult> {
    const parsed = ArgsSchema.parse(args ?? {});
    return this.useCase.execute(parsed);
  }
}
