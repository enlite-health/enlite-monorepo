/**
 * Guarda de i18n da baixa e do selo da vaga (spec 084 + semaforo-da-vaga F4). Lê os JSONs de verdade (nunca um dublê do `t`).
 * Substitui `vacancyStatusEditor.i18n.test.ts`: o editor de estado saiu, o que ele guardava de vivo (baixa, selo, "sem reativar") ficou.
 */
import { describe, it, expect } from 'vitest';
import es from '@infrastructure/i18n/locales/es.json';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';

type Json = { [k: string]: Json | string };
const dig = (o: Json, path: string): string | Json | undefined =>
  path.split('.').reduce<Json | string | undefined>((acc, k) => (acc && typeof acc === 'object' ? (acc as Json)[k] : undefined), o);

const STATUS_BADGE = ['SEARCHING', 'ON_HOLD', 'SUSPENDED', 'CLOSED', 'DE_BAJA']; // `statusBadge` segue (LinkExistingVacancyModal)

const KEYS = [
  ...STATUS_BADGE.map((s) => `admin.vacancyDetail.statusBadge.${s}`),
  'admin.vacancyDetail.baja.button', 'admin.vacancyDetail.baja.confirmTitle', 'admin.vacancyDetail.baja.confirmBody',
  'admin.vacancyDetail.baja.confirm', 'admin.vacancyDetail.baja.cancel', 'admin.vacancyDetail.baja.working',
  'admin.vacancyDetail.baja.readOnlyBanner', 'admin.vacancyDetail.baja.readOnlyDetail', 'admin.vacancyDetail.baja.error',
  'admin.vacancyDetail.baja.talentumManual', 'admin.vacancyDetail.baja.talentumManualResume', 'admin.vacancyDetail.baja.talentumPending',
  'admin.vacancies.baja.talentumPendingBadge', 'admin.vacancies.filters.patientStatus.label',
  // o selo tem 2 valores (F15): o resto da vaga fica sem selo
  'admin.vacancyDetail.lifecycle.rascunho', 'admin.vacancyDetail.lifecycle.baja',
  'admin.vacancies.baja.showToggle', 'admin.vacancies.baja.talentumManualToggle', 'admin.vacancies.baja.badge',
  'admin.vacancies.baja.readOnlyHint', 'admin.vacancies.baja.talentumManualBadge', 'admin.vacancies.baja.talentumManualResumeBadge',
  'admin.vacancies.baja.selectAll', 'admin.vacancies.baja.selectRow', 'admin.vacancies.baja.selectedCount',
  'admin.vacancies.baja.bulkButton', 'admin.vacancies.baja.clearSelection', 'admin.vacancies.baja.confirmTitle',
  'admin.vacancies.baja.confirmBody', 'admin.vacancies.baja.confirmCases', 'admin.vacancies.baja.confirm',
  'admin.vacancies.baja.cancel', 'admin.vacancies.baja.working', 'admin.vacancies.baja.done', 'admin.vacancies.baja.error',
  'admin.vacancies.baja.errors.VACANCY_HAS_SERVICE', 'admin.vacancies.baja.errors.VACANCY_ALREADY_DE_BAJA',
  'admin.vacancies.baja.errors.VACANCY_NOT_FOUND',
];

describe('baixa e selo da vaga — i18n es + pt-BR', () => {
  it.each(KEYS)('%s existe em es E em pt-BR', (key) => {
    expect(dig(es as Json, key), `es: ${key}`).toBeTruthy();
    expect(dig(ptBR as Json, key), `pt-BR: ${key}`).toBeTruthy();
  });

  it('"En espera" em es e "Em espera" em pt-BR (rótulo do ON_HOLD)', () => {
    expect(dig(es as Json, 'admin.vacancyDetail.statusBadge.ON_HOLD')).toBe('En espera');
    expect(dig(ptBR as Json, 'admin.vacancyDetail.statusBadge.ON_HOLD')).toBe('Em espera');
  });

  it('P8: VACANCY_HAS_SERVICE aponta a ação do paciente ou a desativação do serviço (não manda mais "Pausar" a vaga)', () => {
    expect(dig(es as Json, 'admin.vacancies.baja.errors.VACANCY_HAS_SERVICE')).toBe(
      'Una vacante de un servicio contratado no se da de baja a mano: pausá o suspendé al paciente, o desactivá el servicio.',
    );
    expect(dig(ptBR as Json, 'admin.vacancies.baja.errors.VACANCY_HAS_SERVICE')).toBe(
      'Vaga de serviço contratado não recebe baixa manual: pause ou suspenda o paciente, ou desative o serviço.',
    );
  });

  it.each([
    'admin.vacancyDetail.statusEditor',
    'admin.vacancyDetail.vacancyForm.statusOptions',
    'admin.vacancyDetail.lifecycle.aberta',
    'admin.vacancyDetail.lifecycle.pausada',
    'admin.vacancyDetail.lifecycle.cerrada',
    'admin.vacancies.filters.lifecycle',
    'admin.managementDashboard.bigNumbers.vacantesPausadas',
    'admin.managementDashboard.help.vacantesPausadas',
  ])('%s saiu dos dois idiomas (F4: ninguém escolhe estado para a vaga)', (key) => {
    expect(dig(es as Json, key)).toBeUndefined();
    expect(dig(ptBR as Json, key)).toBeUndefined();
  });

  it('não existe nenhum botão/texto de "reativar vaga" nos dois idiomas (R17)', () => {
    for (const bundle of [es, ptBR]) {
      const baja = JSON.stringify({ a: dig(bundle as Json, 'admin.vacancies.baja'), b: dig(bundle as Json, 'admin.vacancyDetail.baja') });
      expect(baja).not.toMatch(/reactivar vacante|reativar vaga|reactivate|\bReactivar\b|\bReativar\b/);
    }
  });
});
