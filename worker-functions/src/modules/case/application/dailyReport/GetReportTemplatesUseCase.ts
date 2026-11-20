/**
 * GetReportTemplatesUseCase — `GET /api/workers/me/daily-report-templates?from&to` (spec 092, DC-2/DC-4).
 *
 * Uma entrada por guarda do prestador na janela (a expansão do itinerário, F-5): `occurrenceId`, o PTI vigente DO SERVIÇO DA GUARDA na data
 * (`projectInForceFor`, nunca o do paciente), o prazo e os itens perguntáveis. Sem `patient_id`, sem diagnóstico, sem contexto clínico (DF-7):
 * a entrada do molde é só objetivo/atividade do catálogo.
 */
import type { DailyReportPort, GuardOccurrence, ProjectVersionRef } from '../ports/DailyReportPort';
import { ReportDue, type TemplateActivity, type TemplateObjective } from '../../domain/DailyReport';
import { projectInForceFor } from '../../domain/TherapeuticProjectVigencia';
import { addDaysToDateString } from '../../domain/itineraryEvents';
import { AccountInactiveError } from '../GetWorkerItineraryUseCase';
import { templateOf } from './templateAssembler';

/** Janela máxima do contrato: 9 dias corridos (ontem..hoje+7). */
export const MAX_TEMPLATE_WINDOW_DAYS = 9;

export class InvalidTemplateWindowError extends Error {
  constructor() {
    super('invalid_window');
    this.name = 'InvalidTemplateWindowError';
  }
}

export interface ReportTemplateItem {
  occurrenceId: string;
  ptiVersionId: string | null;
  dueAt: string;
  objectives: readonly TemplateObjective[];
  activities: readonly TemplateActivity[];
}

export class GetReportTemplatesUseCase {
  constructor(private readonly port: DailyReportPort) {}

  async execute(args: { uid: string; from: string; to: string; today: string }): Promise<{ items: ReportTemplateItem[] }> {
    if (args.from > args.to || addDaysToDateString(args.from, MAX_TEMPLATE_WINDOW_DAYS - 1) < args.to) throw new InvalidTemplateWindowError();
    return this.port.run(async (tx) => {
      const workerId = await tx.workerIdByUid(args.uid);
      if (workerId === null) throw new AccountInactiveError();
      const guards = (await tx.guardsOf(workerId, args.today)).filter((g) => g.onDate >= args.from && g.onDate <= args.to);
      const catalog = await tx.scaleCatalog();
      const versionsByService = new Map<string, ProjectVersionRef[]>();
      const items: ReportTemplateItem[] = [];
      for (const g of guards) {
        const versions = await this.versionsOf(tx, versionsByService, g);
        const version = projectInForceFor(versions, g.serviceId, g.onDate);
        const template = await templateOf(tx, catalog, version);
        items.push({
          occurrenceId: g.occurrenceId,
          ptiVersionId: template.ptiVersionId,
          dueAt: ReportDue.of(g.endsAt).dueAt.toISOString(),
          objectives: template.objectives,
          activities: template.activities,
        });
      }
      return { items };
    });
  }

  private async versionsOf(
    tx: Parameters<Parameters<DailyReportPort['run']>[0]>[0],
    memo: Map<string, ProjectVersionRef[]>,
    g: GuardOccurrence,
  ): Promise<ProjectVersionRef[]> {
    const known = memo.get(g.serviceId);
    if (known) return known;
    const loaded = await tx.projectVersionsOfService(g.serviceId);
    memo.set(g.serviceId, loaded);
    return loaded;
  }
}
