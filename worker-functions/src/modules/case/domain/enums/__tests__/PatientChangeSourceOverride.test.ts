import { MANUAL_CHANGE_SOURCES, INTERNAL_CHANGE_SOURCES } from '../PatientChangeSource';
import { OVERRIDE_CHANGE_SOURCE, recordedChangeSource } from '../PatientChangeSourceOverride';

describe('PatientChangeSourceOverride (spec 051)', () => {
  it('o mapa tem UMA entrada por origem manual, e só por elas', () => {
    expect(Object.keys(OVERRIDE_CHANGE_SOURCE).sort()).toEqual([...MANUAL_CHANGE_SOURCES].sort());
    expect(OVERRIDE_CHANGE_SOURCE).toEqual({ admin_panel: 'admin_panel_override', kanban: 'kanban_override' });
  });

  it.each(MANUAL_CHANGE_SOURCES)('%s: fora do fluxo vira a versão override; dentro do fluxo fica como veio', (origem) => {
    expect(recordedChangeSource(origem, true)).toBe(OVERRIDE_CHANGE_SOURCE[origem]);
    expect(recordedChangeSource(origem, false)).toBe(origem);
  });

  it.each(INTERNAL_CHANGE_SOURCES)('%s (interna) nunca vira override, nem com foraDoFluxo=true', (origem) => {
    expect(recordedChangeSource(origem, true)).toBe(origem);
    expect(recordedChangeSource(origem, false)).toBe(origem);
  });
});
