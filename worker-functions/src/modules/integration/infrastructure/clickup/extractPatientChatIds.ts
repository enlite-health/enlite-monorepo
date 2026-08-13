import { isGroupChatId } from '@modules/case';
import type { PatientChatIdMap } from '@modules/case';
import type { ClickUpTask } from './ClickUpTask';

/**
 * Os campos de grupo de WhatsApp da lista "Estado de Pacientes" e o papel do
 * catálogo (`patient_chat_roles`) que cada um alimenta. "Chat ID Equipo" é o
 * grupo do equipo tratante = prestadores. Não existe campo de obra social no
 * ClickUp (o papel HEALTH_PLAN só é alimentável pela plataforma).
 *
 * Mapeamento em código, por nome exato do campo — a mesma convenção de todos
 * os outros campos do ClickUpPatientMapper. Teto conhecido: renomear o campo
 * no ClickUp silencia o espelho (ausente ≡ vazio). Aceito porque este caminho
 * é da TRANSIÇÃO — quando a admissão fechar, o dado nasce na plataforma e
 * este sync se aposenta (Planning 12/08, 02:10:13).
 */
const CHAT_ID_FIELD_TO_ROLE: Record<string, string> = {
  'Chat ID Familia': 'FAMILY',
  'Chat ID Equipo':  'PROVIDERS',
};

export interface InvalidChatIdField {
  role: string;
  /**
   * ⚠️ Pode ser PII (um `@c.us` é literalmente um telefone; texto livre pode
   * ter nome). Fica no retorno para o chamador DECIDIR — nunca vai para log.
   */
  value: string;
  /** Categoria segura para logar no lugar do valor. */
  kind: 'direct_chat' | 'malformed';
}

export interface PatientChatIdsExtraction {
  /** Papel -> chat_id válido (`@g.us`). Papel sem valor no ClickUp fica FORA. */
  chatIds: PatientChatIdMap;
  /** Valores presentes mas fora do formato de grupo. */
  invalid: InvalidChatIdField[];
}

/**
 * Extracts the WhatsApp group chat ids from the ClickUp task, keyed by
 * platform role. Values that are present but not a valid Periskope GROUP id
 * (`@g.us`, see PatientChatId.isGroupChatId) are returned in `invalid` instead
 * — border-of-import validation, so a typo in ClickUp can never reach the
 * write path and take down the whole patient sync.
 */
export function extractPatientChatIds(task: ClickUpTask): PatientChatIdsExtraction {
  const chatIds: PatientChatIdMap = {};
  const invalid: InvalidChatIdField[] = [];

  for (const [fieldName, role] of Object.entries(CHAT_ID_FIELD_TO_ROLE)) {
    const raw = task.custom_fields.find(f => f.name === fieldName)?.value;
    if (typeof raw !== 'string') continue;
    const value = raw.trim();
    if (!value) continue;
    if (isGroupChatId(value)) {
      chatIds[role] = value;
    } else {
      invalid.push({
        role,
        value,
        kind: value.endsWith('@c.us') ? 'direct_chat' : 'malformed',
      });
    }
  }

  return { chatIds, invalid };
}
