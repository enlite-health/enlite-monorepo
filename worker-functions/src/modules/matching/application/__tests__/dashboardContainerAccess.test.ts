import {
  DASHBOARD_SECTIONS, DASHBOARD_SECTION_KEYS, canReadDashboardSection, dashboardReadsOf, dashboardSectionCell,
  projectManagementDashboard,
} from '../dashboardContainerAccess';
import { managementDashboardSchema } from '../managementDashboardSchema';

const DATA = {
  bigNumbers: { a: 1 }, pacientes: { b: 2 }, horas: { c: 3 }, equipoArmada: { pct: 4 }, encuadres: { pct: 5 },
  prioridades: { d: 6 }, cadastros: { e: 7 }, funnelPorPrestador: { f: 8 }, funnel: { g: 9 },
};

describe('dashboardContainerAccess — Gestión a la Vista por bloco (D286)', () => {
  it('5 seções projetadas + zonas por rota; cada uma com célula própria de leitura', () => {
    expect(DASHBOARD_SECTIONS).toEqual(['numbers', 'team', 'priorities', 'registrations', 'funnel']);
    expect(DASHBOARD_SECTIONS.map(dashboardSectionCell)).toEqual([
      'dashboard_numbers:read', 'dashboard_team:read', 'dashboard_priorities:read', 'dashboard_registrations:read', 'dashboard_funnel:read',
    ]);
    // toda chave do PAYLOAD REAL (o schema zod de management) está mapeada em alguma seção — chave
    // nova que ninguém mapear ficaria visível para todo mundo em silêncio (achado do gate, 06/09)
    expect(new Set(Object.values(DASHBOARD_SECTION_KEYS).flat())).toEqual(new Set(Object.keys(managementDashboardSchema.shape)));
  });

  it('cells = null → o MESMO objeto (D113); [] → tudo null e as 5 seções no marcador', () => {
    expect(projectManagementDashboard(DATA, null)).toBe(DATA);
    expect(projectManagementDashboard(DATA, undefined)).toBe(DATA);
    const nada = projectManagementDashboard(DATA, ['dashboard:read']);
    for (const k of Object.keys(DATA)) expect(nada[k as keyof typeof DATA]).toBeNull();
    expect(nada.redacted).toEqual({ numbers: true, team: true, priorities: true, registrations: true, funnel: true });
    expect(canReadDashboardSection(undefined, 'team')).toBe(true);
  });

  it('sub-objeto compartilhado FICA se qualquer seção permitida o usa: só Equipo armado → equipoArmada e horas ficam, bigNumbers não', () => {
    const so = projectManagementDashboard(DATA, ['dashboard_team:read']);
    expect(so.equipoArmada).toEqual({ pct: 4 });
    expect(so.horas).toEqual({ c: 3 });
    expect(so.bigNumbers).toBeNull();
    expect(so.encuadres).toBeNull();
    expect(so.prioridades).toBeNull();
    expect(so.redacted).toEqual({ numbers: true, priorities: true, registrations: true, funnel: true });
    expect(DATA.bigNumbers).toEqual({ a: 1 }); // não muta
  });

  it('Números clave puxa os 5 sub-objetos que a seção lê; Totalización puxa encuadres também', () => {
    const n = projectManagementDashboard(DATA, ['dashboard_numbers:read']);
    for (const k of ['bigNumbers', 'pacientes', 'horas', 'equipoArmada', 'encuadres']) expect(n[k as keyof typeof DATA]).not.toBeNull();
    for (const k of ['prioridades', 'cadastros', 'funnelPorPrestador', 'funnel']) expect(n[k as keyof typeof DATA]).toBeNull();
    const f = projectManagementDashboard(DATA, ['dashboard_funnel:read']);
    expect(f.encuadres).not.toBeNull();
    expect(f.funnelPorPrestador).not.toBeNull();
    expect(f.bigNumbers).toBeNull();
  });

  it('com as 5 células (sem null) a resposta é igual à inteira, sem marcador', () => {
    const tudo = projectManagementDashboard(DATA, DASHBOARD_SECTIONS.map(dashboardSectionCell));
    expect(tudo).toBe(DATA);
    expect(dashboardReadsOf(['dashboard_priorities:read'])).toEqual({ numbers: false, team: false, priorities: true, registrations: false, funnel: false });
  });
});
