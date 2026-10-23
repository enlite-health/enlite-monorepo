/**
 * Spec 067 A9: as chaves da coluna Bloqueados existem em es e pt-BR, com o mesmo caminho,
 * e os componentes tocados não carregam texto fixo para o selo/rótulo.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';

const KEYS = [
  'admin.kanban.columns.BLOQUEADO',
  'admin.kanban.completadoBadge.QUALIFIED',
  'admin.kanban.completadoBadge.IN_DOUBT',
  'admin.kanban.completadoBadge.COMPLETED',
  'admin.vacancyDetail.funnelView.kanban.workerEligibilityReason.documents_not_validated',
  'admin.vacancyDetail.enquadre.errors.workerNotEligible',
  'admin.managementDashboard.funnel.stage.BLOQUEADO',
  'admin.managementDashboard.help.stage_BLOQUEADO.title',
  'admin.managementDashboard.help.stage_BLOQUEADO.que',
  'admin.managementDashboard.help.stage_BLOQUEADO.origen',
  'admin.managementDashboard.help.stage_BLOQUEADO.cambia',
];

function lookup(json: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, k) => (acc as Record<string, unknown> | undefined)?.[k], json);
}

describe('067 A9 — chaves de Bloqueados nos dois idiomas', () => {
  it.each(KEYS)('%s existe em es e pt-BR (texto não vazio)', (key) => {
    for (const [lng, json] of [['es', esJson], ['pt-BR', ptBRJson]] as const) {
      const v = lookup(json, key);
      expect(typeof v, `${lng} ${key}`).toBe('string');
      expect((v as string).length, `${lng} ${key}`).toBeGreaterThan(0);
    }
  });

  it('o código WORKER_NOT_ELIGIBLE do encuadre tem chave mapeada (sem texto fixo)', () => {
    const src = readFileSync(
      resolve(__dirname, '../../Enquadre/enquadreErrors.ts'),
      'utf8',
    );
    expect(src).toContain("WORKER_NOT_ELIGIBLE: `${E}.errors.workerNotEligible`");
  });
});
