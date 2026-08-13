import { PatientChatIdsRepository, type ChatIdConflict } from '../infrastructure/PatientChatIdsRepository';
import { PatientChatRolesRepository } from '../infrastructure/PatientChatRolesRepository';
import type { PatientChatIdMap, PatientChatIdWriteMap } from '../domain/PatientChatId';
import { isExclusiveChatRole, toRoleCatalog } from '../domain/PatientChatRole';

/** O paciente pedido não existe (ou está soft-deleted). */
export class PatientChatIdsNotFoundError extends Error {
  constructor(patientId: string) {
    super(`Patient not found: ${patientId}`);
    this.name = 'PatientChatIdsNotFoundError';
  }
}

/** Um dos chat_ids já está preso a outro paciente, num papel exclusivo. */
export class ChatIdAlreadyLinkedError extends Error {
  constructor(public readonly conflicts: ChatIdConflict[]) {
    super(`Chat id already linked to another patient: ${conflicts.map(c => c.chatId).join(', ')}`);
    this.name = 'ChatIdAlreadyLinkedError';
  }
}

/**
 * O `chat_id` pedido já é DESTE MESMO paciente, só que preso a um papel que o
 * body não tocou.
 *
 * `findLinkedElsewhere` só enxerga OUTROS pacientes (`c.patient_id <> $1`) —
 * então mover um grupo de um papel para outro, ou reaproveitar um chat_id que
 * já é seu em outro papel, passava batido pela checagem e ia direto para
 * `applyChatIds`. Lá o INSERT bate em `patient_chat_ids_one_role_per_chat`
 * (UNIQUE `patient_id, chat_id`) → 23505 → o catch-all do controller dizia
 * "já vinculado a OUTRO paciente" — mensagem FALSA (é o mesmo paciente) e sem
 * pista de como resolver (achado de review, 11/08).
 */
export class ChatIdOwnedBySamePatientRoleError extends Error {
  constructor(
    public readonly conflicts: { chatId: string; requestedRole: string; currentRole: string }[],
  ) {
    super(
      `Chat id already linked to this same patient under a different role: ` +
        conflicts.map(c => `${c.chatId} is ${c.currentRole}, requested for ${c.requestedRole}`).join('; '),
    );
    this.name = 'ChatIdOwnedBySamePatientRoleError';
  }
}

/**
 * O body trouxe papel que não existe no catálogo, ou que está desativado.
 *
 * Erro separado do 400 genérico de schema porque a causa é outra: o formato
 * está certo, o vocabulário é que não confere — e quem opera precisa saber que
 * o caminho é a tela de administração de papéis, não corrigir o texto.
 */
export class UnknownChatRoleError extends Error {
  constructor(public readonly roles: string[]) {
    super(`Unknown or inactive chat role(s): ${roles.join(', ')}`);
    this.name = 'UnknownChatRoleError';
  }
}

/**
 * PatientChatIdsService — grava os grupos de WhatsApp do paciente, por papel.
 *
 * Os papéis válidos e a exclusividade de cada um vêm do CATÁLOGO
 * (`patient_chat_roles`, migration 262), não de código. Ver
 * `domain/PatientChatRole.isExclusiveChatRole` — o ponto único da decisão.
 *
 * A trava de unicidade tem duas metades, e as duas são necessárias:
 *
 *   - NO BANCO: índice único parcial `idx_patient_chat_ids_exclusive_chat`
 *     (`WHERE is_exclusive`) — o mesmo grupo não entra duas vezes entre os
 *     papéis exclusivos, de nenhum paciente. É a metade dura: nem um script nem
 *     um psql à mão furam.
 *   - AQUI: a mesma regra, antes de bater na constraint, para devolver 409 com
 *     a LISTA DE CONFLITOS em vez de um erro de banco opaco — e para cobrir o
 *     caso misto (papel compartilhável tentando tomar um grupo que já é de um
 *     papel exclusivo alheio), que o índice parcial sozinho não vê.
 *
 * Ceiling honesto (ponytail): entre a leitura e a escrita há uma janela em que
 * duas gravações simultâneas passariam pela checagem daqui. O índice do banco
 * segura o caso exclusivo×exclusivo (vira 23505 → 409 no controller); o caso
 * misto perderia a corrida. Não vale um lock de tabela — é uma tela de admin
 * operada por uma pessoa por vez, e a próxima leitura mostra o resultado.
 */
export class PatientChatIdsService {
  private readonly repo: PatientChatIdsRepository;
  private readonly rolesRepo: PatientChatRolesRepository;

  constructor(repo?: PatientChatIdsRepository, rolesRepo?: PatientChatRolesRepository) {
    this.repo = repo ?? new PatientChatIdsRepository();
    this.rolesRepo = rolesRepo ?? new PatientChatRolesRepository();
  }

  async update(patientId: string, changes: PatientChatIdWriteMap): Promise<PatientChatIdMap> {
    const patient = await this.repo.findById(patientId);
    if (!patient) throw new PatientChatIdsNotFoundError(patientId);

    // Uma leitura só do catálogo, usada tanto para validar quanto para gravar:
    // ler duas vezes abriria uma janela em que a validação e a escrita
    // enxergariam políticas diferentes.
    const catalog = toRoleCatalog(await this.rolesRepo.listActive());

    const unknown = Object.keys(changes).filter(role => !catalog.has(role));
    if (unknown.length > 0) throw new UnknownChatRoleError(unknown);

    const wanted = Object.entries(changes).filter(
      (entry): entry is [string, string] => entry[1] !== null,
    );

    // Mesmo paciente, chat_id já usado num papel FORA do payload — não é
    // colisão com estranho, é MOVER um grupo sem dizer. `findLinkedElsewhere`
    // não vê isto (só olha outros pacientes); sem detectar aqui, o INSERT bate
    // na constraint patient_chat_ids_one_role_per_chat e o erro que sobe é
    // FALSO ("outro paciente"). Um papel presente no BODY (mesmo que como
    // `null`) não conta como conflito — é a forma explícita de "mover".
    const ownConflicts = wanted
      .map(([role, chatId]) => {
        const currentRole = Object.entries(patient.chatIds).find(
          ([r, c]) => c === chatId && r !== role,
        )?.[0];
        return currentRole && !(currentRole in changes)
          ? { chatId, requestedRole: role, currentRole }
          : null;
      })
      .filter((c): c is { chatId: string; requestedRole: string; currentRole: string } => c !== null);

    if (ownConflicts.length > 0) throw new ChatIdOwnedBySamePatientRoleError(ownConflicts);

    if (wanted.length > 0) {
      const linked = await this.repo.findLinkedElsewhere(patientId);
      const conflicts = linked.filter(taken =>
        wanted.some(
          ([role, chatId]) =>
            chatId === taken.chatId &&
            // Basta UM dos dois lados ser exclusivo para o vínculo ser proibido:
            // um grupo compartilhável (o do plano de saúde, que nasce assim
            // porque são 27 pagadores para 236 pacientes) ainda assim não pode
            // ser a família de alguém.
            (taken.exclusive || isExclusiveChatRole(catalog, role)),
        ),
      );
      if (conflicts.length > 0) throw new ChatIdAlreadyLinkedError(conflicts);
    }

    return this.repo.applyChatIds(patientId, changes, catalog);
  }

  /**
   * Espelha no Postgres os grupos que o ClickUp traz para este paciente.
   *
   * Semântica própria de SYNC, diferente do `update` da tela:
   *   - Só recebe papéis PREENCHIDOS no ClickUp — campo vazio lá NUNCA
   *     desvincula aqui (a plataforma pode ter vinculado pela tela um papel que
   *     o ClickUp nem conhece, e o sync não pode apagar o que não é dele).
   *     Exceção deliberada: quando um grupo pedido já é DESTE paciente sob
   *     OUTRO papel que o ClickUp não está pedindo, isso é o operador MOVENDO
   *     o grupo de campo — o sync emite o `null` explícito do papel antigo
   *     (a forma de "mover" que o `update` exige), senão o movimento ficaria
   *     preso em ChatIdOwnedBySamePatientRoleError para sempre.
   *   - Papel cujo valor já é o atual vira `unchanged` SEM tocar o banco: o
   *     reconcile varre a base inteira, e regravar centenas de vínculos por
   *     ciclo destruiria o significado de `updated_at`.
   *   - Conflito NÃO estoura: o chamador é o sync do paciente, e um grupo em
   *     disputa não pode derrubar a atualização do resto da ficha. A gravação
   *     tenta primeiro o mapa inteiro (swap de papéis é atômico — o
   *     `applyChatIds` solta a linha reescrita antes de inserir); se falhar por
   *     conflito com mais de um papel em jogo, tenta papel a papel para salvar
   *     os que não conflitam, e devolve os perdedores em `skipped` com motivo.
   */
  async syncFromClickUp(patientId: string, wanted: PatientChatIdMap): Promise<ChatIdSyncOutcome> {
    const allSkipped = (reason: string): ChatIdSyncOutcome => ({
      applied: [],
      unchanged: [],
      skipped: Object.entries(wanted).map(([role, chatId]) => ({ role, chatId, reason })),
    });

    const patient = await this.repo.findById(patientId);
    if (!patient) return allSkipped('patient_not_found');

    const unchanged: string[] = [];
    const diff: PatientChatIdWriteMap = {};
    for (const [role, chatId] of Object.entries(wanted)) {
      if (patient.chatIds[role] === chatId) {
        unchanged.push(role);
        continue;
      }
      diff[role] = chatId;
      // Grupo mudando de campo no ClickUp → move explícito (ver docblock).
      const currentRole = Object.entries(patient.chatIds).find(
        ([r, c]) => c === chatId && r !== role,
      )?.[0];
      if (currentRole && !(currentRole in wanted)) diff[currentRole] = null;
    }
    if (Object.keys(diff).length === 0) {
      return { applied: [], unchanged, skipped: [] };
    }

    const appliedRolesOf = (map: PatientChatIdWriteMap): string[] =>
      Object.keys(map).filter(role => map[role] !== null);

    try {
      await this.update(patientId, diff);
      return { applied: appliedRolesOf(diff), unchanged, skipped: [] };
    } catch (err) {
      if (err instanceof PatientChatIdsNotFoundError) return allSkipped('patient_not_found');
      if (!isChatIdSyncConflict(err)) throw err;
      // Um papel só: papel-a-papel repetiria a MESMA chamada que acabou de
      // falhar — registra o perdedor e sai.
      if (appliedRolesOf(diff).length === 1) {
        const [role] = appliedRolesOf(diff);
        return {
          applied: [],
          unchanged,
          skipped: [{ role, chatId: diff[role] as string, reason: syncConflictReason(err) }],
        };
      }
    }

    // O mapa inteiro conflitou. Papel a papel: salva os que passam sozinhos.
    const applied: string[] = [];
    const skipped: SkippedChatId[] = [];
    for (const role of appliedRolesOf(diff)) {
      const chatId = diff[role] as string;
      try {
        await this.update(patientId, { [role]: chatId });
        applied.push(role);
      } catch (err) {
        if (err instanceof PatientChatIdsNotFoundError) {
          skipped.push({ role, chatId, reason: 'patient_not_found' });
          continue;
        }
        if (!isChatIdSyncConflict(err)) throw err;
        skipped.push({ role, chatId, reason: syncConflictReason(err) });
      }
    }
    return { applied, unchanged, skipped };
  }
}

/** Um papel que o sync NÃO gravou, e por quê. */
export interface SkippedChatId {
  role: string;
  chatId: string;
  reason: string;
}

/** O que aconteceu com cada papel pedido num `syncFromClickUp`. */
export interface ChatIdSyncOutcome {
  applied: string[];
  unchanged: string[];
  skipped: SkippedChatId[];
}

/**
 * Conflitos ESPERADOS no sync — viram `skipped` com motivo. Entram aqui os
 * três erros tipados do serviço E o 23505 cru do Postgres: as travas de
 * unicidade do banco são a instância que REALMENTE arbitra (mesma leitura que
 * o AdminPatientChatIdsController faz para devolver 409), e um paciente com
 * dado em disputa não pode virar "falha de infraestrutura" em loop no
 * reconcile. Qualquer outro erro (banco fora, bug) sobe: engoli-lo
 * transformaria falha real em "sincronizado".
 */
function isChatIdSyncConflict(err: unknown): boolean {
  return (
    err instanceof ChatIdAlreadyLinkedError ||
    err instanceof ChatIdOwnedBySamePatientRoleError ||
    err instanceof UnknownChatRoleError ||
    isUniqueViolation(err)
  );
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

function syncConflictReason(err: unknown): string {
  return isUniqueViolation(err) ? 'unique_violation' : (err as Error).name;
}
