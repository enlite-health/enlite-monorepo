/**
 * SyncPatientFromClickUpTaskUseCase
 *
 * Processes a single ClickUp task and upserts the corresponding patient record.
 *
 * 11/09/2026 — o webhook e o reconciliador automáticos foram removidos (decisão do Gabriel:
 * a plataforma é a fonte, sem sync automático). O ÚNICO chamador vivo hoje é o script manual
 * de carga pontual (`scripts/import-patients-from-clickup.ts`).
 *
 * Does NOT fetch from the ClickUp API — the caller is responsible for fetching
 * and passing in an already-retrieved ClickUpTask.
 */

import * as functions from 'firebase-functions';
import { reportError, safeErrorFields } from '@shared/logging';
import type { ClickUpTask } from '../infrastructure/clickup/ClickUpTask';
import type { ClickUpPatientMapper } from '../infrastructure/clickup/ClickUpPatientMapper';
import { PATOLOGIA_FIELD_NAME } from '../infrastructure/clickup/ClickUpPatientMapper';
import type { CatalogRead } from '../infrastructure/clickup/helpers/resolveCatalogValue';
import { extractPatientChatIds } from '../infrastructure/clickup/extractPatientChatIds';
import type { PatientService } from '../../case/application/PatientService';
import { PatientChatIdsService } from '../../case/application/PatientChatIdsService';
import type { PatientSourceLabelRepository } from '@modules/case';
import type { PatientInsuranceVerifiedRepository, PatientDeviceTypeRepository } from '@modules/case';
import type { ClickUpDiagnosisMapper } from '@modules/diagnosis/infrastructure/clickup/ClickUpDiagnosisMapper';

// ── Result types ──────────────────────────────────────────────────────────────

export type SyncPatientResult =
  | { kind: 'CREATED'; patientId: string; flagged: boolean; taskId: string; patientName: string }
  | { kind: 'UPDATED'; patientId: string; flagged: boolean; taskId: string; patientName: string }
  | { kind: 'CASE_NUMBER_CONFLICT'; patientId: string; taskId: string; caseNumber: number | null; patientName: string }
  | { kind: 'SKIPPED_SUBTASK'; taskId: string }
  | { kind: 'SKIPPED_NO_PATIENT_NAME'; taskId: string }
  | { kind: 'SKIPPED_MAPPER_NULL'; taskId: string }
  | { kind: 'ERROR'; taskId: string; error: Error };

export interface SyncPatientDeps {
  mapper: ClickUpPatientMapper;
  patientService: PatientService;
  /**
   * Espelha os campos "Chat ID Familia"/"Chat ID Equipo" do ClickUp em
   * `patient_chat_ids` (task 86ak04ygu). Opcional só para injeção em teste —
   * quando ausente, o use case constrói o real. O passo inteiro fica atrás de
   * PATIENT_CHAT_IDS_CLICKUP_SYNC_ENABLED.
   */
  chatIdsService?: PatientChatIdsService;
  /**
   * Task 2.3 — onde o rótulo CRU é persistido, ao lado do derivado (D-B).
   *
   * OBRIGATÓRIA de propósito. Opcional, ela seria a fiação que ninguém liga: o sync seguiria
   * verde, o derivado seguiria gravado e o cru seguiria perdido — exatamente o estado que
   * esta fase existe para fechar, agora com uma coluna vazia para dar a impressão contrária.
   * Sendo obrigatória, o compilador força CADA ponto de construção a decidir, o que é
   * arquitetura em vez de instrução.
   */
  sourceLabelRepository: PatientSourceLabelRepository;
  /**
   * Task 3.2/3.3 — a `Cobertura Verificada` múltipla. Obrigatória pelo mesmo motivo da de
   * cima: opcional, seria a fiação que ninguém liga, e o sync seguiria verde com a tabela
   * vazia — que é exatamente o estado que esta fase existe para consertar.
   */
  insuranceRepository: PatientInsuranceVerifiedRepository;
  /**
   * Task 4.2 — o `Tipo de Dispositivo` múltiplo. Obrigatória pelo mesmo motivo da de
   * cobertura: dependência opcional vira "não persistiu e ninguém soube".
   */
  deviceTypeRepository: PatientDeviceTypeRepository;
  /**
   * spec 016 F4 — sincroniza "Tipo de Patología" com o diagnóstico CID-11 estruturado
   * (`patient_diagnoses`, source='CLICKUP'). OPCIONAL na assinatura (permanece opcional para
   * quem monta o use case em teste sem essa dependência), mas o único chamador vivo hoje
   * (`scripts/import-patients-from-clickup.ts`, no branch `--apply`) SEMPRE a passa desde
   * 11/09/2026 (decisão do Gabriel: a carga manual passou a sincronizar diagnóstico também,
   * mesma construção que `ClickUpPatientWebhookController.getDiagnosisMapper()` fazia).
   */
  diagnosisMapper?: ClickUpDiagnosisMapper;
}

export interface SyncPatientOptions {
  onMissingContact?: 'flag' | 'error';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Formats first + last name into "Apellido, Nombre" display string.
 * Handles partial names (either component can be empty).
 */
export function formatPatientName(firstName: string | null | undefined, lastName: string | null | undefined): string {
  const last  = lastName  ?? '';
  const first = firstName ?? '';
  return `${last}, ${first}`.trim().replace(/^,\s*/, '').replace(/,\s*$/, '');
}

/**
 * Determines the reason a mapper returned null for a task that does have some data.
 * Used to distinguish between "truly empty task" vs "task with data mapper couldn't handle".
 */
export function classifyMapperNullReason(task: ClickUpTask): 'SKIPPED_NO_PATIENT_NAME' | 'SKIPPED_MAPPER_NULL' {
  const hasFirstName = task.custom_fields.some(
    f => f.name === 'Nombre de Paciente' && f.value,
  );
  const hasLastName = task.custom_fields.some(
    f => f.name === 'Apellido del Paciente' && f.value,
  );
  return (!hasFirstName && !hasLastName) ? 'SKIPPED_NO_PATIENT_NAME' : 'SKIPPED_MAPPER_NULL';
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 9);
}

// ── Use case ──────────────────────────────────────────────────────────────────

export class SyncPatientFromClickUpTaskUseCase {
  constructor(private readonly deps: SyncPatientDeps) {}

  async execute(
    task: ClickUpTask,
    opts: SyncPatientOptions = {},
    correlationId?: string,
  ): Promise<SyncPatientResult> {
    const cid     = correlationId ?? shortId();
    const taskId  = task.id;
    const startMs = Date.now();

    functions.logger.info('clickup_patient_sync.start', {
      taskId,
      taskStatus: task.status?.status,
      correlationId: cid,
    });

    // Subtasks are skipped — the API already excludes them (subtasks=false),
    // but tasks can still carry a parent reference in edge cases.
    if (task.parent !== null) {
      functions.logger.warn('clickup_patient_sync.skipped', {
        taskId,
        kind: 'SKIPPED_SUBTASK',
        reason: 'task has parent',
        correlationId: cid,
      });
      return { kind: 'SKIPPED_SUBTASK', taskId };
    }

    // Attempt mapping
    let input: ReturnType<ClickUpPatientMapper['map']>;
    try {
      input = this.deps.mapper.map(task);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      functions.logger.error('clickup_patient_sync.error', {
        taskId,
        ...safeErrorFields(err),
        correlationId: cid,
      });
      return { kind: 'ERROR', taskId, error };
    }

    if (input === null) {
      const kind = classifyMapperNullReason(task);
      functions.logger.warn('clickup_patient_sync.skipped', {
        taskId,
        kind,
        reason: kind === 'SKIPPED_NO_PATIENT_NAME' ? 'no patient name in custom fields' : 'mapper returned null',
        correlationId: cid,
      });
      return { kind, taskId };
    }

    // Live upsert
    try {
      const result = await this.deps.patientService.upsertFromClickUp(input, {
        onMissingContact: opts.onMissingContact ?? 'flag',
        correlationId:    cid,
      });

      const patientName = formatPatientName(input.firstName, input.lastName);

      // O conflito de case_number NÃO impede a ficha de existir (o upsert
      // retenta sem o número e devolve um id real) — então os grupos espelham
      // ANTES do early-return, senão exatamente os pacientes conflitados
      // divergiriam do ClickUp para sempre.
      await this.syncChatIds(task, result.id, cid);

      // ── I1: as 4 gravações da ficha espelham ANTES do early-return, pelo MESMO argumento ──
      // O conflito de `case_number` não impede a ficha de existir, e o retry do conflito já
      // gravou os ESCALARES (`PatientService.retryWithoutCaseNumber` → `upsertRelated`). Deixar
      // estas 4 abaixo do `return` fazia com que, para toda tarefa conflitada, o escalar fosse
      // escrito e o conjunto/cru/diagnóstico NÃO — a cada re-sync, em silêncio: exatamente a
      // divergência que o cabeçalho do `ClickUpPatientMapper` adverte, produzida por construção.
      //
      // Todas as quatro são best-effort e NUNCA lançam (cada uma trata o próprio erro e loga
      // evento próprio), então subi-las não muda o `kind` de nenhum caminho: o `CASE_NUMBER_
      // CONFLICT` continua sendo devolvido logo abaixo, e o CREATED/UPDATED segue igual.
      await this.persistSourceLabels(task, result.id, cid);
      await this.persistInsuranceVerified(input, result.id, cid);
      await this.persistDeviceTypes(input, result.id, cid);
      await this.persistDiagnosis(task, result.id, cid);

      if (result.conflict === 'CASE_NUMBER_CONFLICT') {
        functions.logger.warn('clickup_patient_sync.case_number_conflict', {
          taskId,
          caseNumber: input.caseNumber ?? null,
          patientId:  result.id,
          durationMs: Date.now() - startMs,
          correlationId: cid,
          // PII: patientName not logged here
        });
        return {
          kind:        'CASE_NUMBER_CONFLICT',
          patientId:   result.id,
          taskId,
          caseNumber:  input.caseNumber ?? null,
          patientName,
        };
      }

      const kind: 'CREATED' | 'UPDATED' = result.created ? 'CREATED' : 'UPDATED';

      // ── Task 2.3: o rótulo CRU, ao lado do derivado ────────────────────────
      // Roda DEPOIS do upsert porque só aqui existe `patientId` — ver o bloco acima, de onde
      // estas quatro chamadas subiram (I1). O derivado já está gravado: uma falha delas não
      // invalida o paciente, então ela NÃO derruba o sync — mas também não pode passar muda.
      // O F43 desta casa é exatamente isto: o webhook devolvendo `success:true` com erro
      // dentro, e ninguém sabendo. Evento PRÓPRIO, contagem, e o `outcome` de cada campo —
      // que é o que distingue "gravei" de "não li e não toquei".

      // PII: não logar patientName aqui — vai pro Cloud Logging.
      // patientName fica apenas no SyncPatientResult retornado pro CLI script.
      functions.logger.info('clickup_patient_sync.completed', {
        taskId,
        kind,
        patientId:     result.id,
        flagged:       result.flagged,
        durationMs:    Date.now() - startMs,
        correlationId: cid,
      });

      return { kind, patientId: result.id, flagged: result.flagged, taskId, patientName };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      functions.logger.error('clickup_patient_sync.error', {
        taskId,
        ...safeErrorFields(err),
        durationMs: Date.now() - startMs,
        correlationId: cid,
      });
      return { kind: 'ERROR', taskId, error };
    }
  }

  /**
   * Espelha os grupos de WhatsApp do ClickUp em `patient_chat_ids`.
   *
   * Best-effort DEPOIS do upsert do paciente: um grupo em disputa (409) ou um
   * valor torto no ClickUp não pode derrubar a sincronização da ficha — por
   * isso os conflitos viram log estruturado, não exceção. Vazio no ClickUp
   * nunca desvincula (ver PatientChatIdsService.syncFromClickUp).
   */
  private async syncChatIds(task: ClickUpTask, patientId: string, cid: string): Promise<void> {
    if (process.env.PATIENT_CHAT_IDS_CLICKUP_SYNC_ENABLED !== 'true') return;

    const { chatIds, invalid } = extractPatientChatIds(task);

    for (const bad of invalid) {
      // PII: nunca logar `bad.value` — um `@c.us` é literalmente um telefone,
      // e texto livre pode carregar nome (Ley 25.326). `kind` + tamanho bastam
      // para o operador achar o campo torto pela task.
      functions.logger.warn('clickup_patient_sync.chat_id_invalid', {
        taskId: task.id,
        role:   bad.role,
        kind:   bad.kind,
        valueLength: bad.value.length,
        correlationId: cid,
      });
    }
    if (Object.keys(chatIds).length === 0) return;

    try {
      const outcome = await this.chatIdsService().syncFromClickUp(patientId, chatIds);

      if (outcome.applied.length > 0 || outcome.skipped.length > 0) {
        functions.logger.info('clickup_patient_sync.chat_ids', {
          taskId: task.id,
          patientId,
          applied:   outcome.applied,
          unchanged: outcome.unchanged,
          skipped:   outcome.skipped,
          correlationId: cid,
        });
      }
    } catch (err) {
      // Falha de infraestrutura no passo de chat ids (banco fora etc.): reporta
      // e segue — a ficha do paciente já foi gravada. ⚠️ 11/09/2026: NÃO EXISTE MAIS retry
      // automático nenhum — o reconciliador que revisitava tasks alteradas (`cycle`, janela de
      // 30min) foi removido junto com o webhook (decisão do Gabriel: sem sync automático). E o
      // script manual que ficou (`import-patients-from-clickup.ts`) é create-only (parecer do
      // lex): se esta falha aconteceu na criação, um re-run com `--task-id --apply` para o
      // MESMO task_id é RECUSADO (paciente já existe) — não há caminho automático nem manual
      // simples para reprocessar só os chat ids depois do fato. Gap operacional conhecido,
      // reportado, não fechado nesta mudança.
      reportError(err instanceof Error ? err : new Error(String(err)), {
        source: 'clickup_patient_sync.chat_ids',
        taskId: task.id,
        patientId,
        correlationId: cid,
      });
    }
  }

  /**
   * Resolvido sob demanda (não no construtor) de propósito: o repositório real
   * abre pool ao ser construído, e o use case também vive em testes/CLIs que
   * nunca chegam neste passo. Memoizado — uma instância por use case.
   */
  private chatIdsService(): PatientChatIdsService {
    this.chatIdsServiceInstance ??= this.deps.chatIdsService ?? new PatientChatIdsService();
    return this.chatIdsServiceInstance;
  }

  private chatIdsServiceInstance?: PatientChatIdsService;

  /**
   * Persiste a `Cobertura Verificada` múltipla. Nunca lança: o paciente já foi gravado, e a
   * cobertura múltipla é acréscimo ao escalar que continua sendo escrito.
   *
   * Falha aqui não derruba o sync, mas NÃO passa muda — evento próprio, com contagem (C1).
   */
  private async persistInsuranceVerified(
    input: { insuranceVerifiedLabels?: unknown },
    patientId: string,
    cid: string,
  ): Promise<void> {
    const read = input.insuranceVerifiedLabels as
      | { readable: true; labels: readonly unknown[] }
      | { readable: false; reason: string }
      | undefined;

    // Ausente é ANOMALIA, não "nada a fazer": o mapper sempre emite o campo desde a 3.2.
    // Tratar ausência como vazio é o D167 entrando pela porta do chamador.
    if (read === undefined) {
      functions.logger.error('clickup_patient_sync.insurance_verified_error', {
        patientId, error: 'mapper não emitiu insuranceVerifiedLabels', stage: 'read', correlationId: cid,
      });
      return;
    }

    try {
      const r = await this.deps.insuranceRepository.replaceForPatient({ patientId, read });
      functions.logger.info('clickup_patient_sync.insurance_verified', {
        patientId, outcome: r.outcome, recebidos: r.received,
        gravados: r.accepted.length, recusados: r.rejected.length, correlationId: cid,
      });
    } catch (err) {
      functions.logger.error('clickup_patient_sync.insurance_verified_error', {
        patientId, ...safeErrorFields(err), stage: 'write', correlationId: cid,
      });
    }
  }

  /**
   * Persiste o `Tipo de Dispositivo` múltiplo (task 4.2). Nunca lança: o paciente já foi
   * gravado.
   *
   * ⚠️ O MODO DE FALHA AQUI É DIFERENTE do da cobertura, e vale dizer qual é.
   * Na cobertura, falhar depois do COMMIT deixa o escalar preenchido e a tabela vazia — duas
   * cópias divergindo. Aqui não existe escalar co-escrito: `patients.device_type` é derivado
   * da tabela por trigger (migration 310). Então falhar aqui deixa o conjunto **desatualizado**,
   * e o escalar desatualizado JUNTO, coerente com ele. Não há divergência interna; há atraso.
   *
   * Isso é melhor, mas não é invisível de graça: quem detecta é
   * `scripts/verificar-4.2-divergencia.ts`, que compara o escalar com o que o trigger
   * calcularia. Sem esse verificador como critério de aceite, o atraso existiria e ninguém
   * saberia — que é a F43 por outra porta.
   */
  private async persistDeviceTypes(
    input: { deviceTypeLabels?: unknown },
    patientId: string,
    cid: string,
  ): Promise<void> {
    const read = input.deviceTypeLabels as
      | { readable: true; labels: readonly unknown[] }
      | { readable: false; reason: string }
      | undefined;

    // Ausente é ANOMALIA, não "nada a fazer": o mapper sempre emite o campo desde a 4.2.
    if (read === undefined) {
      functions.logger.error('clickup_patient_sync.device_type_error', {
        patientId, error: 'mapper não emitiu deviceTypeLabels', stage: 'read', correlationId: cid,
      });
      return;
    }

    try {
      const r = await this.deps.deviceTypeRepository.replaceForPatient({ patientId, read });
      functions.logger.info('clickup_patient_sync.device_type', {
        patientId, outcome: r.outcome, recebidos: r.received,
        gravados: r.accepted.length, recusados: r.rejected.length,
        quarentena: r.quarantined, correlationId: cid,
      });
    } catch (err) {
      functions.logger.error('clickup_patient_sync.device_type_error', {
        patientId, ...safeErrorFields(err), stage: 'write', correlationId: cid,
      });
    }
  }

  /**
   * spec 016 F4 — sincroniza "Tipo de Patología" com `patient_diagnoses` (source='CLICKUP'),
   * via `ClickUpDiagnosisMapper` (que por sua vez usa o `PatientDiagnosisService`, Facade,
   * com um repositório JÁ ESCOPADO à origem ClickUp — nunca um `if` de origem aqui nem lá).
   *
   * Best-effort, MESMO PADRÃO de `persistInsuranceVerified`/`persistDeviceTypes`: o paciente
   * já foi gravado quando este passo roda, então uma falha aqui não pode derrubar o `kind` do
   * sync — mas também não pode passar muda (log de erro com CAUSA, nunca o rótulo clínico).
   *
   * `diagnosisMapper` é OPCIONAL (ver `SyncPatientDeps`) — ausente, este passo é um no-op.
   */
  private async persistDiagnosis(task: ClickUpTask, patientId: string, cid: string): Promise<void> {
    if (!this.deps.diagnosisMapper) return;

    let read: CatalogRead;
    try {
      read = this.deps.mapper.readPatologia(task);
    } catch (err) {
      functions.logger.error('clickup_patient_sync.diagnosis_error', {
        patientId, ...safeErrorFields(err), stage: 'read', correlationId: cid,
      });
      return;
    }

    // ── I3: "não consegui ler a opção" NÃO é "não há diagnóstico" ─────────────────────────
    // `ClickUpDiagnosisMapper.syncFromLabel(patientId, null)` devolve `{kind:'no_label'}`,
    // documentado como AUSÊNCIA LEGÍTIMA. Mandar para lá a leitura ilegível (opção renomeada
    // no ClickUp, valor que nem forma de índice tem) registrava "sem rótulo" a cada re-sync,
    // indistinguível de um campo que a operação simplesmente não preencheu — e sem alarme.
    // Aqui o passo PARA: nada é gravado, nada é apagado, e o motivo ESTRUTURAL vai para o log.
    // C1/lex: sai nome do campo, tipo do catálogo, motivo e CONTAGEM — nunca o orderindex,
    // nunca o rótulo (o orderindex É o valor clínico em forma codificada).
    //
    // ── I3b: PARAR e GRITAR não é FICAR EM LISTA ──────────────────────────────────────────
    // O grito abaixo é log, e log tem retenção. A regra da casa é que o que não mapeia fica em
    // LISTA (`patient_source_label_rejections`) — e essa lista ficava vazia para a classe
    // INTEIRA dos orderindex ilegíveis, que é justamente a classe que ninguém consegue
    // descobrir de outro jeito (o rótulo não existe para procurar). O registro durável vai
    // depois do log e SEM o valor: `reason='unreadable'`, `raw_label` NULO (migration 329).
    if (!read.readable) {
      functions.logger.error('clickup_patient_sync.diagnosis_unreadable', {
        patientId,
        field:       PATOLOGIA_FIELD_NAME,
        catalogType: read.catalogType,
        reason:      read.reason,
        requested:   read.requested,
        resolved:    read.resolved,
        stage:       'read',
        correlationId: cid,
      });
      try {
        await this.deps.diagnosisMapper.recordUnreadableLabel(patientId);
      } catch (err) {
        // Best-effort como os irmãos deste método: o paciente já foi gravado e a falha do
        // registro não pode derrubar o sync — mas também não passa muda (F43).
        functions.logger.error('clickup_patient_sync.diagnosis_error', {
          patientId, ...safeErrorFields(err), stage: 'reject', correlationId: cid,
        });
      }
      return;
    }

    // `[]` aqui é vazio DE VERDADE (`requested === 0`): ninguém preencheu o campo no ClickUp.
    // Esse `null` sim é a ausência legítima que `syncFromLabel` sabe tratar.
    const label = read.labels[0] ?? null;

    try {
      const outcome = await this.deps.diagnosisMapper.syncFromLabel(patientId, label);
      functions.logger.info('clickup_patient_sync.diagnosis', {
        patientId, kind: outcome.kind,
        outcome: outcome.kind === 'synced' ? outcome.outcome : undefined,
        correlationId: cid,
      });
    } catch (err) {
      functions.logger.error('clickup_patient_sync.diagnosis_error', {
        patientId, ...safeErrorFields(err), stage: 'write', correlationId: cid,
      });
    }
  }

  /**
   * Persiste as leituras cruas dos campos de catálogo. Nunca lança: o paciente já foi gravado
   * e o cru é acréscimo, não pré-requisito.
   *
   * O que sai em log é nome de campo, `outcome` e CONTAGEM (C1 do parecer do `lex`) — nunca o
   * rótulo, nunca o uuid, nunca o `task.id` junto de valor clínico.
   */
  private async persistSourceLabels(task: ClickUpTask, patientId: string, cid: string): Promise<void> {
    let leituras;
    try {
      leituras = this.deps.mapper.readSourceLabels(task);
    } catch (err) {
      // O preflight da 1.11 lançando aqui é ANOMALIA: `map()` acabou de passar por ele. Se
      // acontecer, o catálogo mudou no meio da requisição.
      functions.logger.error('clickup_patient_sync.source_labels_error', {
        patientId, ...safeErrorFields(err), stage: 'read', correlationId: cid,
      });
      return;
    }

    // Contagem zero é falha, nunca sucesso (F19): a lista é derivada de PATIENT_CATALOG_FIELDS,
    // que nunca é vazia. Vazio aqui significa que a derivação quebrou, não que não há o que gravar.
    if (leituras.length === 0) {
      functions.logger.error('clickup_patient_sync.source_labels_error', {
        patientId, error: 'readSourceLabels devolveu ZERO campos', stage: 'read', correlationId: cid,
      });
      return;
    }

    let gravados = 0;
    let ilegiveis = 0;
    let falhas = 0;
    for (const { fieldName, read } of leituras) {
      try {
        const r = await this.deps.sourceLabelRepository.replaceForField({ patientId, fieldName, read });
        if (r.outcome === 'skipped-unreadable') ilegiveis += 1;
        else gravados += 1;
      } catch (err) {
        // Um campo que falha não impede os outros 7: perder tudo porque um deu erro é pior.
        falhas += 1;
        functions.logger.error('clickup_patient_sync.source_labels_error', {
          patientId, field: fieldName, ...safeErrorFields(err), stage: 'write', correlationId: cid,
        });
      }
    }

    functions.logger.info('clickup_patient_sync.source_labels', {
      patientId, campos: leituras.length, gravados, ilegiveis, falhas, correlationId: cid,
    });
  }
}
