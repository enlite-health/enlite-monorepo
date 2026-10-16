/**
 * Perfil do admin: `GET /me/tactiq-link` passa a devolver `extension` — o estado da extensão do Tactiq no Chrome da PRÓPRIA pessoa.
 * A fonte é a mesma linha que o `ChromeReportJob` grava e de onde sai o aviso do sino (`admission_chrome_reports.state`); sem linha, o job
 * a trata como `sem_relatorio` (nunca reportou) — nunca `null`, nunca `ausente`.
 */
import type { Pool } from 'pg';
import type { TactiqLinkRepository } from '../../infrastructure/TactiqLinkRepository';
import type { ChromeReportRepository, ChromeReportRow } from '../../infrastructure/ChromeReportRepository';
import type { SystemNotificationPublisher } from '@modules/inapp-notification/application/SystemNotificationPublisher';
import { TactiqLinkService } from '../TactiqLinkService';

const REPORT_AT = new Date('2026-10-12T08:00:00.000Z');
const row = (over: Partial<ChromeReportRow>): ChromeReportRow => ({
  host_email: 'exemplo@enlite.test', state: 'instalada', report_at: REPORT_AT, conclusive_state: 'instalada',
  state_changed_at: new Date('2026-10-10T08:00:00.000Z'), checked_at: REPORT_AT, ...over,
});

function build(chrome: ChromeReportRow | null) {
  const linkRepo = { findByEmail: jest.fn().mockResolvedValue(null) };
  const chromeRepo = { findByEmail: jest.fn().mockResolvedValue(chrome) };
  const service = new TactiqLinkService({
    repo: linkRepo as unknown as TactiqLinkRepository,
    chromeReports: chromeRepo as unknown as ChromeReportRepository,
    oauth: {} as never,
    mcp: {} as never,
    db: {} as Pool,
    publisher: {} as SystemNotificationPublisher,
    cipher: { encrypt: jest.fn(), decrypt: jest.fn() },
  });
  return { service, chromeRepo };
}

describe('TactiqLinkService.getOwn — extension', () => {
  it.each(['instalada', 'ausente', 'desativada', 'sem_relatorio'] as const)('estado %s da linha sai como está, com a data do relatório em ISO', async (state) => {
    const { service } = build(row({ state, conclusive_state: state === 'sem_relatorio' ? 'instalada' : state }));
    const own = await service.getOwn('exemplo@enlite.test');
    expect(own.extension).toEqual({ state, reportedAt: REPORT_AT.toISOString() });
  });

  it('sem linha em admission_chrome_reports → sem_relatorio com reportedAt null (nunca null, nunca ausente)', async () => {
    const { service } = build(null);
    const own = await service.getOwn('exemplo@enlite.test');
    expect(own.extension).toEqual({ state: 'sem_relatorio', reportedAt: null });
  });

  it('linha sem report_at (relatório inutilizável) → reportedAt null, estado preservado', async () => {
    const { service } = build(row({ state: 'sem_relatorio', report_at: null, conclusive_state: null }));
    expect((await service.getOwn('exemplo@enlite.test')).extension).toEqual({ state: 'sem_relatorio', reportedAt: null });
  });

  it('consulta SÓ a pessoa recebida: uma leitura, com exatamente o e-mail dela', async () => {
    const { service, chromeRepo } = build(null);
    await service.getOwn('Outra@Enlite.test');
    expect(chromeRepo.findByEmail).toHaveBeenCalledTimes(1);
    expect(chromeRepo.findByEmail).toHaveBeenCalledWith('Outra@Enlite.test');
  });

  it('os campos do vínculo continuam na resposta, ao lado de extension', async () => {
    const { service } = build(null);
    expect(await service.getOwn('exemplo@enlite.test')).toEqual({
      status: 'missing', linkedAt: null, lastCheckAt: null, statusChangedAt: null,
      extension: { state: 'sem_relatorio', reportedAt: null },
    });
  });
});
