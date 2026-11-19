/**
 * GetPatientDailyReportsUseCase — `GET /api/admin/patients/:patientId/daily-reports` (spec 092, CA-4/CA-10).
 * Estrutura sob `daily_report:read`; o TEXTO só com `daily_report_narrative:read` (redação por célula, `canReadDailyReportNarrative`).
 * O atraso é DERIVADO (`ReportDue.isLate`); o sinal é a presença de resposta com aviso imediato (DC-5). Nada é gravado aqui.
 */
import type { DailyReportAdminPort, AdminReportAnswerRow } from '../ports/DailyReportAdminPort';
import { ReportDue } from '../../domain/DailyReport';
import { canReadDailyReportNarrative } from '../dailyReportAccess';

export interface PatientDailyReportView {
  id: string;
  workerId: string;
  onDate: string;
  ptiVersionId: string | null;
  narrativeSource: string;
  deviceSubmittedAt: string;
  receivedAt: string;
  appVersion: string;
  late: boolean;
  answersCount: number;
  immediateAlert: boolean;
  answers: AdminReportAnswerRow[];
  narrative: string | null;
  narrativeRedacted: boolean;
}

export class GetPatientDailyReportsUseCase {
  constructor(private readonly port: DailyReportAdminPort) {}

  /** `null` = paciente não encontrado. */
  async execute(args: { patientId: string; from: string | null; to: string | null; cells: readonly string[] | null }): Promise<{ items: PatientDailyReportView[] } | null> {
    const withNarrative = canReadDailyReportNarrative(args.cells);
    const rows = await this.port.listForPatient({ patientId: args.patientId, from: args.from, to: args.to, withNarrative });
    if (rows === null) return null;
    return {
      items: rows.map((r) => ({
        id: r.id,
        workerId: r.workerId,
        onDate: r.onDate,
        ptiVersionId: r.ptiVersionId,
        narrativeSource: r.narrativeSource,
        deviceSubmittedAt: r.deviceSubmittedAt.toISOString(),
        receivedAt: r.receivedAt.toISOString(),
        appVersion: r.appVersion,
        late: ReportDue.of(r.guardEndsAt).isLate(r.deviceSubmittedAt),
        answersCount: r.answers.length,
        immediateAlert: r.answers.some((a) => a.immediateAlert),
        answers: r.answers,
        // Redação: o campo do texto só carrega valor quando a célula liberou (o adapter já não o leu sem ela).
        narrative: withNarrative ? r.narrative : null,
        narrativeRedacted: !withNarrative,
      })),
    };
  }
}
