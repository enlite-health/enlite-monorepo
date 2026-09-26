/**
 * funnel-move-e2e-helper.ts
 *
 * Helper e2e da Fase 4 (change cadeia-paciente-vacante-itinerario, P16 — DX-4.16):
 * semear vaga + paciente + N cards (worker + WJA + encuadre) em etapas dadas, ler a
 * trilha de uma candidatura, contar o efeito colateral de mensageria/eventos desde um
 * `t0`, ler `patients.status` e `faltantes` pela API, mover pelo `PUT /move` (DX-4.6) e
 * escolher a categoria no modal de motivo (DX-4.10).
 *
 * Reusa (nunca copia): `insertTestPatient`/`insertBaseVacancy`/`insertTestWorker`
 * (db-test-helper.ts), `insertWJA`/`upsertEncuadre` (wja-test-helper.ts) e `runSQL`
 * (patient-detail-a-helper.ts, já usado por vacancy-notes-e2e-helper.ts). O teste (P17-19)
 * importa `dragKanbanCard` (kanban-notes-e2e-helper.ts), `loginAs`/`tokenFor`
 * (abac-stack-helper.ts) e `seedMockStaff`/`readVacancyListRow` (vacancy-notes-e2e-helper.ts)
 * direto dos arquivos de origem — nada disso é reexportado aqui.
 *
 * Duas lacunas dos helpers reusados, medidas na Fase 3 (`51e3ec19`) e confirmadas ao ler
 * este arquivo em 26/09 — os dois pontos onde este helper faz o `UPDATE` direto que o
 * helper reusado não expõe, no molde de `seedVacancyWithCandidatesAtKm`
 * (vacancy-notes-e2e-helper.ts:266-267):
 *   1. `insertBaseVacancy` não expõe `providers_needed` (fixo em 1) — quando o passo pede
 *      outro valor, este helper faz `UPDATE job_postings SET providers_needed = …` depois do insert.
 *   2. `insertWJA` não expõe `messaged_at` — sem setá-lo, um card INVITED/source='system'
 *      fica "matched not invited" e some da coluna Invitados
 *      (`isMatchedNotInvited`, `WF/domain/kanbanColumn.ts:42-48`).
 */
import type { APIRequestContext, Page } from '@playwright/test';
import {
  insertTestPatient,
  insertBaseVacancy,
  insertTestWorker,
  cleanupTestPatient,
  cleanupTestWorker,
} from './db-test-helper';
import { insertWJA, upsertEncuadre, cleanupWJAAndEncuadre } from './wja-test-helper';
import { runSQL } from './patient-detail-a-helper';

// ── Semente: vaga + paciente + N cards ──────────────────────────────────────────

export interface SeedCardSpec {
  /** application_funnel_stage do card — ex: 'SELECTED', 'INVITED', 'QUICK_RESPONSE_TEAM'. */
  stage: string;
  /** worker_job_applications.source — default 'system' (o mesmo default de insertWJA). */
  source?: 'manual' | 'system';
}

export interface SeedVacancyCard {
  workerId: string;
  wjaId: string;
  encuadreId: string;
  stage: string;
  source: 'manual' | 'system';
}

export interface SeedVacancyWithCardsOpts {
  /** Default 1 (o default de insertBaseVacancy). Só gera o UPDATE extra se != 1. */
  providersNeeded?: number;
}

export interface SeedVacancyWithCardsResult {
  patientId: string;
  vacancyId: string;
  addressId: string;
  cards: SeedVacancyCard[];
  /** Apaga cada card (WJA + encuadre + worker) e depois o paciente (cascade na vaga). */
  cleanup: () => void;
}

/**
 * Paciente com endereço + vaga `SEARCHING`/publicada (providers_needed dado) + um worker
 * REGISTERED por `stages[i]`, cada um com WJA na etapa pedida (`messaged_at = NOW()`) e
 * encuadre (upsert). Devolve os ids de cada card e um `cleanup()`.
 */
export function seedVacancyWithCards(
  stages: SeedCardSpec[],
  opts: SeedVacancyWithCardsOpts = {},
): SeedVacancyWithCardsResult {
  const { providersNeeded = 1 } = opts;

  const { patientId, addressId } = insertTestPatient({
    withAddress: true,
    firstName: 'FunnelMoveE2E',
    lastName: `Seed-${Date.now()}`,
  });
  if (!addressId) {
    throw new Error('seedVacancyWithCards: insertTestPatient não devolveu addressId (withAddress: true)');
  }

  // Base distinta de seedVacancyWithCandidatesAtKm (986_000, Fase 3) para não colidir
  // se as duas sementes rodarem na mesma janela de teste.
  const caseNumber = 988_000 + Math.floor(Math.random() * 900);
  const vacancyId = insertBaseVacancy({
    patientId,
    patientAddressId: addressId,
    caseNumber,
    status: 'SEARCHING',
    isDraft: false,
  });

  // insertBaseVacancy não expõe providers_needed (achado da Fase 3, 51e3ec19) — ajuste
  // direto quando o passo pede um valor diferente do default (1).
  if (providersNeeded !== 1) {
    runSQL(`UPDATE job_postings SET providers_needed = ${providersNeeded} WHERE id = '${vacancyId}'`);
  }

  const cards: SeedVacancyCard[] = stages.map(({ stage, source = 'system' }, idx) => {
    const workerId = insertTestWorker({
      firstName: `FunnelMove${stage}`,
      lastName: `E2E${Date.now()}-${idx}`,
    });
    const wjaId = insertWJA({ workerId, jobPostingId: vacancyId, funnelStage: stage, source });
    // insertWJA não expõe messaged_at — sem isso, INVITED/system fica "matched not
    // invited" e some da coluna Invitados (isMatchedNotInvited, kanbanColumn.ts:42-48).
    runSQL(`UPDATE worker_job_applications SET messaged_at = NOW() WHERE id = '${wjaId}'`);
    const encuadreId = upsertEncuadre({ workerId, jobPostingId: vacancyId });
    return { workerId, wjaId, encuadreId, stage, source };
  });

  const cleanup = (): void => {
    for (const card of cards) {
      try {
        cleanupWJAAndEncuadre(card.workerId, vacancyId);
        cleanupTestWorker(card.workerId);
      } catch (err) {
        console.error('[cleanup] card falhou (seguindo)', err);
      }
    }
    cleanupTestPatient(patientId);
  };

  return { patientId, vacancyId, addressId, cards, cleanup };
}

// ── Trilha (worker_job_application_stage_history) ───────────────────────────────

export interface StageHistoryRow {
  oldValue: string | null;
  newValue: string;
  changedBy: string | null;
  createdAt: string;
  /** Coluna nova da migration 478 (DX-4.3) — null nas linhas de automação (DX-4.15). */
  reasonCategory: string | null;
}

/** Lê a trilha inteira de uma candidatura, mais antiga primeiro. */
export function readTrail(applicationId: string): StageHistoryRow[] {
  const out = runSQL(
    `SELECT old_value, new_value, COALESCE(changed_by, ''), created_at, COALESCE(reason_category, '') ` +
      `FROM worker_job_application_stage_history WHERE application_id = '${applicationId}' ORDER BY created_at`,
  );
  if (!out.trim()) return [];
  return out
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const [oldValue, newValue, changedBy, createdAt, reasonCategory] = line.split('|');
      return {
        oldValue: oldValue || null,
        newValue,
        changedBy: changedBy || null,
        createdAt,
        reasonCategory: reasonCategory || null,
      };
    });
}

/** Conta as linhas da trilha de uma candidatura. */
export function countTrail(applicationId: string): number {
  const out = runSQL(
    `SELECT COUNT(*) FROM worker_job_application_stage_history WHERE application_id = '${applicationId}'`,
  );
  return Number(out.trim());
}

// ── Efeito colateral de mensageria/eventos desde t0 ─────────────────────────────

export interface OutboundCounts {
  domainEvents: number;
  stageMessageLog: number;
  outbox: number;
}

/**
 * Conta `domain_events` (por `payload->>'workerId'`), `funnel_stage_message_log`
 * (`worker_id`) e `messaging_outbox` (`worker_id`) do worker, com `created_at >= t0`.
 * Usado pelo critério 11 (DX-4.7): mover para `QUICK_RESPONSE_TEAM` não deve gerar
 * NADA nas três — as três contagens saem 0.
 */
export function countOutboundSince(workerId: string, t0: Date): OutboundCounts {
  const iso = t0.toISOString();
  const domainEvents = Number(
    runSQL(
      `SELECT COUNT(*) FROM domain_events WHERE payload->>'workerId' = '${workerId}' AND created_at >= '${iso}'`,
    ).trim(),
  );
  const stageMessageLog = Number(
    runSQL(
      `SELECT COUNT(*) FROM funnel_stage_message_log WHERE worker_id = '${workerId}' AND created_at >= '${iso}'`,
    ).trim(),
  );
  const outbox = Number(
    runSQL(
      `SELECT COUNT(*) FROM messaging_outbox WHERE worker_id = '${workerId}' AND created_at >= '${iso}'`,
    ).trim(),
  );
  return { domainEvents, stageMessageLog, outbox };
}

// ── Leitura pela API ─────────────────────────────────────────────────────────────

/** `GET /api/admin/patients/:id` (molde `kanban-pacientes.integration.e2e.ts:87-98`) — devolve só `status`. */
export async function readPatientStatusApi(
  request: APIRequestContext,
  backendUrl: string,
  token: string,
  patientId: string,
): Promise<string | null> {
  const res = await request.get(`${backendUrl}/api/admin/patients/${patientId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok()) {
    throw new Error(`GET /api/admin/patients/${patientId} falhou: ${res.status()}`);
  }
  const body = (await res.json()) as { data?: { status?: string } };
  return body.data?.status ?? null;
}

// ── Movimento pela API (DX-4.6) ───────────────────────────────────────────────────

export interface MoveEncuadreBody {
  targetStage: string;
  /** Substitui `rejectionReasonCategory` no corpo do `/move` (DX-4.6) — a rota de
   *  bloqueados continua com o nome antigo, mas não é esta. */
  reasonCategory?: string;
  [key: string]: unknown;
}

export interface MoveEncuadreResponse {
  status: number;
  body: unknown;
}

/**
 * `PUT /api/admin/encuadres/:id/move`. O contrato (DX-4.6) é do backend, escrito por
 * outro agente nesta mesma fase — este helper não valida forma de resposta, só
 * devolve `{ status, body }` cru para o teste decidir (200, ou 422 com
 * `code: 'MOVE_REASON_REQUIRED' | 'MOVE_REASON_INVALID'`).
 */
export async function putMove(
  request: APIRequestContext,
  backendUrl: string,
  token: string,
  encuadreId: string,
  body: MoveEncuadreBody,
): Promise<MoveEncuadreResponse> {
  const res = await request.put(`${backendUrl}/api/admin/encuadres/${encuadreId}/move`, {
    headers: { Authorization: `Bearer ${token}` },
    data: body,
  });
  const parsed = await res.json().catch(() => null);
  return { status: res.status(), body: parsed };
}

// ── Modal de motivo (DX-4.10/DX-4.11) ─────────────────────────────────────────────

/**
 * Escolhe a categoria no modal de motivo genérico (`RejectionReasonSelect.tsx`
 * generalizado por props, DX-4.10): clica em `<prefix>-option-<slug>` (label do
 * radio) e depois em `<prefix>-confirm`. `slug` é `category` em minúsculas com `_`
 * trocado por `-` (o mesmo molde de `RejectionReasonSelect.tsx:39`). Nunca `fill()`.
 */
export async function chooseReasonInModal(page: Page, prefix: string, category: string): Promise<void> {
  const slug = category.toLowerCase().replace(/_/g, '-');
  await page.getByTestId(`${prefix}-option-${slug}`).click();
  await page.getByTestId(`${prefix}-confirm`).click();
}
