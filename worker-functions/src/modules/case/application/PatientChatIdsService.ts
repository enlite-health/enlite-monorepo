import { PatientChatIdsRepository, type ChatIdConflict } from '../infrastructure/PatientChatIdsRepository';
import type { PatientChatIds } from '../domain/PatientChatId';

/** O paciente pedido não existe (ou está soft-deleted). */
export class PatientChatIdsNotFoundError extends Error {
  constructor(patientId: string) {
    super(`Patient not found: ${patientId}`);
    this.name = 'PatientChatIdsNotFoundError';
  }
}

/** Um dos chat_ids já está preso a outro paciente. */
export class ChatIdAlreadyLinkedError extends Error {
  constructor(public readonly conflicts: ChatIdConflict[]) {
    super(`Chat id already linked to another patient: ${conflicts.map(c => c.chatId).join(', ')}`);
    this.name = 'ChatIdAlreadyLinkedError';
  }
}

/**
 * PatientChatIdsService — grava os dois chat IDs de grupo do paciente.
 *
 * A trava de unicidade tem duas metades, e as duas são necessárias:
 *
 *   - MESMO PAPEL entre pacientes (A.family == B.family): coberta por índice
 *     único parcial no banco (migration 260). É a metade dura — nem um script
 *     nem um psql à mão furam.
 *   - PAPEL CRUZADO (A.family == B.providers): Postgres não tem índice único
 *     cross-column, então é validada AQUI, com 409 e a lista de conflitos.
 *     Ceiling honesto: duas gravações simultâneas em papéis cruzados ainda
 *     passariam pela janela entre a leitura e o UPDATE. Não vale um lock de
 *     tabela — a operação é uma pessoa por vez numa tela de admin, e o efeito
 *     de perder a corrida é um vínculo duplicado que a próxima leitura mostra.
 *     Upgrade path: tabela `patient_chat_links(chat_id PK, ...)`.
 */
export class PatientChatIdsService {
  private readonly repo: PatientChatIdsRepository;

  constructor(repo?: PatientChatIdsRepository) {
    this.repo = repo ?? new PatientChatIdsRepository();
  }

  async update(patientId: string, chatIds: PatientChatIds): Promise<PatientChatIds> {
    const patient = await this.repo.findById(patientId);
    if (!patient) throw new PatientChatIdsNotFoundError(patientId);

    const wanted = [chatIds.familyChatId, chatIds.providersChatId].filter(
      (v): v is string => v !== null,
    );

    if (wanted.length > 0) {
      const linked = await this.repo.findLinkedElsewhere(patientId);
      const conflicts = linked.filter(c => wanted.includes(c.chatId));
      if (conflicts.length > 0) throw new ChatIdAlreadyLinkedError(conflicts);
    }

    const updated = await this.repo.updateChatIds(patientId, chatIds);
    if (!updated) throw new PatientChatIdsNotFoundError(patientId);

    return chatIds;
  }
}
