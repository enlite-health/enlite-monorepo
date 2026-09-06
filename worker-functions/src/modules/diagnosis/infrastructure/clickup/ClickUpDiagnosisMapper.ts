/**
 * ClickUpDiagnosisMapper — Adapter (GoF, spec 016 F4) entre o rótulo CRU de "Tipo de
 * Patología" (ClickUp) e o diagnóstico ESTRUTURADO do paciente.
 *
 * 🔑 NUNCA decide por `if (source === 'CLICKUP')` — o escopo vem de fábrica: `service` É um
 * `PatientDiagnosisService` construído com `new PostgresPatientDiagnosisRepository(
 * DiagnosisSource.CLICKUP)` (ver `createClickUpDiagnosisMapper`, abaixo). Isso torna esta
 * classe fisicamente incapaz de tocar uma linha `PANEL` — a mesma física de
 * `PostgresPatientDiagnosisRepository`, um nível acima. `grep -rn "if.*source\|if.*CLICKUP"`
 * neste arquivo tem de dar zero (critério de aceite da F4).
 *
 * Entra no `PatientDiagnosisService` (Facade) — nunca chama `RecordPatientDiagnosis` direto
 * (Contrato de arquitetura da spec 016: "webhook e tela chamando 4 objetos na fé" é o que a
 * Facade existe para evitar).
 *
 * `Tipo de Patología` é seleção ÚNICA (D163, Javier corrigiu "múltipla" → "única" no ato) —
 * por isso todo mapeamento entra como `isPrimary: true`. Isso não risca o diagnóstico do
 * PAINEL: `is_primary` é único por `(paciente, ORIGEM)` (migration 325), não por paciente
 * inteiro — o painel e o ClickUp têm, cada um, seu próprio principal.
 */
import type { PatientDiagnosisService } from '../../application/PatientDiagnosisService';
import type { ClickUpDiagnosisLabelPort } from './ClickUpDiagnosisLabelRepository';
import type { ClickUpDiagnosisRejectionPort } from './ClickUpDiagnosisRejectionRepository';

/** Ator de sistema nomeado — nunca um uid de staff (o webhook não tem sessão humana). */
export const CLICKUP_DIAGNOSIS_SYNC_ACTOR = 'clickup-sync';

export type ClickUpDiagnosisSyncOutcome =
  /** O campo veio vazio no ClickUp — não é recusa, é ausência legítima (D167). */
  | { readonly kind: 'no_label' }
  /** O rótulo não tem linha em `clickup_diagnosis_labels` — registrado, nunca inventado. */
  | { readonly kind: 'unmapped' }
  /**
   * A origem mandou valor e o catálogo do ClickUp não o traduz mais (opção renomeada,
   * reordenada ou apagada): NÃO HÁ rótulo. Registrado como OCORRÊNCIA, sem o valor.
   */
  | { readonly kind: 'unreadable' }
  /** Mapeado e encaminhado ao Facade — `outcome` é o do `RecordPatientDiagnosisResult`, sem
   *  reinterpretação (inclusive `already_active`, `primary_race`, `not_diagnosable` etc.). */
  | { readonly kind: 'synced'; readonly outcome: string };

export class ClickUpDiagnosisMapper {
  constructor(
    private readonly labels: ClickUpDiagnosisLabelPort,
    private readonly rejections: ClickUpDiagnosisRejectionPort,
    private readonly service: PatientDiagnosisService,
  ) {}

  async syncFromLabel(patientId: string, label: string | null): Promise<ClickUpDiagnosisSyncOutcome> {
    if (!label) return { kind: 'no_label' };

    const conceptUri = await this.labels.resolve(label);
    if (!conceptUri) {
      await this.rejections.recordUnmapped(patientId, label);
      return { kind: 'unmapped' };
    }

    const result = await this.service.recordDiagnosis({
      patientId,
      conceptUri,
      isPrimary: true,
      actorUid: CLICKUP_DIAGNOSIS_SYNC_ACTOR,
    });
    return { kind: 'synced', outcome: result.outcome };
  }

  /**
   * O caminho da leitura ILEGÍVEL — a origem mandou valor e o catálogo não o traduziu, então
   * não existe rótulo para passar a `syncFromLabel`.
   *
   * ── POR QUE ESTE MÉTODO MORA AQUI, E NÃO NO CHAMADOR ─────────────────────────────────────
   * Quem detecta o ilegível é `SyncPatientFromClickUpTaskUseCase.persistDiagnosis`, no módulo
   * `integration`; quem sabe registrar a recusa é o repositório do módulo `diagnosis`. Foi
   * exatamente nessa fronteira que o conserto ficou pela metade. Fechá-la injetando o
   * repositório de recusa no use case abriria uma SEGUNDA porta de `integration` para dentro
   * de `diagnosis` (hoje ele só conhece este Adapter) — e o `integration` passaria a decidir
   * COMO a recusa é gravada. Aqui, `integration` continua dizendo apenas O QUE ACONTECEU e
   * `diagnosis` segue dono da própria persistência (o mesmo desenho de `syncFromLabel`).
   *
   * ⚠️ NÃO recebe o valor ilegível, e a assinatura é a trava: o orderindex é dado clínico em
   * forma codificada e não atravessa esta fronteira nem por engano.
   *
   * Nunca chama o Facade: ilegível não é diagnóstico, e nada pode ser gravado nem apagado
   * (D167/F41 — "não consegui ler" não é "está vazio").
   */
  async recordUnreadableLabel(patientId: string): Promise<ClickUpDiagnosisSyncOutcome> {
    await this.rejections.recordUnreadable(patientId);
    return { kind: 'unreadable' };
  }
}
