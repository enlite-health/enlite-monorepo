/**
 * GetScaleCatalogUseCase — `GET /api/workers/me/daily-report-scales` (spec 092). Catálogo global (sem PHI) com `version` = hash do conteúdo
 * (vira o ETag: o app só rebaixa quando muda). A ordem é a da planilha (`position`).
 */
import { createHash } from 'crypto';
import type { DailyReportPort } from '../ports/DailyReportPort';
import type { Scale } from '../../domain/DailyReport';

export interface ScaleCatalogView {
  version: string;
  scales: Scale[];
}

export class GetScaleCatalogUseCase {
  constructor(private readonly port: DailyReportPort) {}

  async execute(): Promise<ScaleCatalogView> {
    const catalog = await this.port.run((tx) => tx.scaleCatalog());
    const scales = [...catalog.values()].sort((a, b) => a.code.localeCompare(b.code));
    const version = createHash('sha256').update(JSON.stringify(scales)).digest('hex');
    return { version, scales };
  }
}
