/**
 * Gate da aba Enquadre (spec 052): com o engine ligado a aba só existe para quem tem uma célula de enquadre;
 * com o engine desligado aparece sempre (as células novas nascem sem grupo).
 */
import { describe, expect, it } from 'vitest';
import { tabsVisibleFor } from '@presentation/hooks/useCellAccess';
import { screenById } from '@presentation/config/screenRegistry';
import { VACANCY_TABS } from '../vacancyTabs';

const screen = screenById('vacancies.detail');

describe('aba Enquadre × células', () => {
  it('engine ligado e sem a célula: a aba não aparece', () => {
    expect(tabsVisibleFor(screen, VACANCY_TABS, ['funnel:read'], 'on')).not.toContain('enquadre');
  });

  it('engine ligado com enquadre_event:read: a aba aparece', () => {
    expect(tabsVisibleFor(screen, VACANCY_TABS, ['enquadre_event:read'], 'on')).toContain('enquadre');
  });

  it('engine ligado só com enquadre_result:update: a aba aparece', () => {
    expect(tabsVisibleFor(screen, VACANCY_TABS, ['enquadre_result:update'], 'on')).toContain('enquadre');
  });

  it('engine desligado: a aba aparece sem nenhuma célula', () => {
    expect(tabsVisibleFor(screen, VACANCY_TABS, [], 'off')).toContain('enquadre');
  });
});
