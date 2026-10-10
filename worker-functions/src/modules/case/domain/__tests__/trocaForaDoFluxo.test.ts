/**
 * Spec 051 (F1) — tabela-verdade de `decidirTrocaForaDoFluxo`. Função pura, ainda não ligada
 * ao writer. `null` ≠ `[]`.
 */
import { CLINICAL_PATIENT_STATUSES, type ClinicalPatientStatus } from '../enums/PatientStatus';
import { CELULA_DO_DESTINO, decidirTrocaForaDoFluxo } from '../trocaForaDoFluxo';

const DESTINOS: readonly ClinicalPatientStatus[] = CLINICAL_PATIENT_STATUSES;
const outraOrigem = (d: ClinicalPatientStatus): ClinicalPatientStatus => (d === 'ACTIVE' ? 'SEARCHING' : 'ACTIVE');
const TODAS = Object.values(CELULA_DO_DESTINO);

let casos = 0;
afterAll(() => {
  // Contagem declarada: 7 destinos x 14 casos + 1 caso de funil (destino) = 99.
  // eslint-disable-next-line no-console
  console.log(`TABELA_VERDADE casos executados: ${casos}`);
});
const marca = () => { casos += 1; };

describe('decidirTrocaForaDoFluxo — tabela-verdade', () => {
  it('controle positivo: 7 destinos', () => {
    expect(DESTINOS).toHaveLength(7);
  });

  describe.each(DESTINOS)('destino %s', (para) => {
    const de = outraOrigem(para);
    const propria = CELULA_DO_DESTINO[para];
    const base = { de, para, naFsm: false, cells: [propria] as string[] | null, changeSource: 'admin_panel' };

    it.each(['system', 'activate', 'vacancy_launch', 'recruitment_activation'])(
      'origem não manual (%s) não se aplica, mesmo fora da FSM e sem célula', (changeSource) => {
        marca();
        expect(decidirTrocaForaDoFluxo({ ...base, changeSource, cells: [] }))
          .toEqual({ resultado: 'nao_se_aplica', motivo: 'origem_nao_manual' });
      });

    it('origem fora do funil clínico (de = funil de admissão) não se aplica', () => {
      marca();
      expect(decidirTrocaForaDoFluxo({ ...base, de: 'ADMISSION', cells: [] }))
        .toEqual({ resultado: 'nao_se_aplica', motivo: 'fora_do_funil_clinico' });
    });

    it('origem nula (paciente sem status) não se aplica', () => {
      marca();
      expect(decidirTrocaForaDoFluxo({ ...base, de: null, cells: [] }))
        .toEqual({ resultado: 'nao_se_aplica', motivo: 'fora_do_funil_clinico' });
    });

    it('de === para não se aplica', () => {
      marca();
      expect(decidirTrocaForaDoFluxo({ ...base, de: para, cells: [] }))
        .toEqual({ resultado: 'nao_se_aplica', motivo: 'mesmo_estado' });
    });

    it.each(['admin_panel', 'kanban'])('par na FSM (%s): fluxo normal, sem célula e sem override', (changeSource) => {
      marca();
      expect(decidirTrocaForaDoFluxo({ ...base, changeSource, naFsm: true, cells: [] }))
        .toEqual({ resultado: 'fluxo_normal' });
    });

    it('fora da FSM e cells === null: engine não decidiu (≠ sem permissão)', () => {
      marca();
      expect(decidirTrocaForaDoFluxo({ ...base, cells: null })).toEqual({ resultado: 'engine_nao_decidiu' });
    });

    it('fora da FSM e cells === [] : recusa por permissão com a chave que falta', () => {
      marca();
      expect(decidirTrocaForaDoFluxo({ ...base, cells: [] }))
        .toEqual({ resultado: 'recusada_por_permissao', celulaFaltante: propria });
    });

    it('fora da FSM e só as células dos OUTROS destinos: recusa', () => {
      marca();
      expect(decidirTrocaForaDoFluxo({ ...base, cells: TODAS.filter((c) => c !== propria) }))
        .toEqual({ resultado: 'recusada_por_permissao', celulaFaltante: propria });
    });

    it.each(['admin_panel', 'kanban'])('fora da FSM com a célula do destino (%s): permitida por permissão', (changeSource) => {
      marca();
      expect(decidirTrocaForaDoFluxo({ ...base, changeSource, cells: [propria, 'patient:read'] }))
        .toEqual({ resultado: 'permitida_por_permissao', celula: propria });
    });
  });

  it('destino fora do funil clínico (para = funil) não se aplica', () => {
    marca();
    expect(decidirTrocaForaDoFluxo({ de: 'ACTIVE', para: 'SOLICITANTE', naFsm: false, cells: [], changeSource: 'admin_panel' }))
      .toEqual({ resultado: 'nao_se_aplica', motivo: 'fora_do_funil_clinico' });
  });

  it('contagem: 7 destinos x 14 casos + 1 de funil = 99 (contagem zero é falha, não sucesso)', () => {
    // por destino: 4 origens não manuais + funil(de) + nulo + mesmo estado + 2 na FSM
    //              + null + [] + só-outras + 2 permitidas = 14
    expect(casos).toBe(7 * 14 + 1);
  });
});
