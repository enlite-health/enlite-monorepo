/**
 * Spec 051 (F1) — tabela-verdade de `decidirTrocaForaDoFluxo`. Função pura, ainda não ligada
 * ao writer. `null` ≠ `[]`.
 */
import { CLINICAL_PATIENT_STATUSES, type ClinicalPatientStatus } from '../enums/PatientStatus';
import { INTERNAL_CHANGE_SOURCES, ROTA_CHANGE_SOURCES, type PatientChangeSource } from '../enums/PatientChangeSource';
import { CELULA_DO_DESTINO, decidirTrocaForaDoFluxo, type DestinoHumano } from '../trocaForaDoFluxo';

const DESTINOS: readonly DestinoHumano[] = ['ON_HOLD', 'SUSPENDED', 'ALTA', 'DISCHARGED'];
const DERIVADOS: readonly ClinicalPatientStatus[] = ['SEARCHING', 'REPLACEMENT', 'ACTIVE'];
const outraOrigem = (d: ClinicalPatientStatus): ClinicalPatientStatus => (d === 'ACTIVE' ? 'SEARCHING' : 'ACTIVE');
const TODAS = Object.values(CELULA_DO_DESTINO);

let casos = 0;
afterAll(() => {
  // Contagem declarada: 4 destinos x 14 casos + 3 derivados x 2 origens da rota + 1 de funil + 1 de tipo = 64.
  // eslint-disable-next-line no-console
  console.log(`TABELA_VERDADE casos executados: ${casos}`);
});
const marca = () => { casos += 1; };

describe('decidirTrocaForaDoFluxo — tabela-verdade', () => {
  it('controle positivo: 4 destinos humanos (com célula) e 3 derivados (sem)', () => {
    expect(DESTINOS).toHaveLength(4);
    expect(DERIVADOS).toHaveLength(3);
    expect(CLINICAL_PATIENT_STATUSES).toHaveLength(7);
  });

  describe.each(DERIVADOS)('destino derivado %s (F5: não há célula)', (para) => {
    const base = { de: 'DISCHARGED' as const, para, cells: Object.values(CELULA_DO_DESTINO) as string[] | null };
    it.each(ROTA_CHANGE_SOURCES)('fora da FSM (%s): não se aplica — nenhuma célula o destrava', (changeSource) => {
      marca();
      expect(decidirTrocaForaDoFluxo({ ...base, naFsm: false, changeSource }))
        .toEqual({ resultado: 'nao_se_aplica', motivo: 'destino_do_fluxo_automatico' });
    });
  });

  describe.each(DESTINOS)('destino %s', (para) => {
    const de = outraOrigem(para);
    const propria = CELULA_DO_DESTINO[para];
    const base = { de, para, naFsm: false, cells: [propria] as string[] | null, changeSource: 'admin_panel' as PatientChangeSource };

    it.each(INTERNAL_CHANGE_SOURCES)(
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

    it.each(ROTA_CHANGE_SOURCES)('par na FSM (%s): fluxo normal, sem célula e sem override', (changeSource) => {
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

    it.each(ROTA_CHANGE_SOURCES)('fora da FSM com a célula do destino (%s): permitida por permissão', (changeSource) => {
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

  it('tipo fechado: erro de digitação na origem é erro de COMPILAÇÃO (e, em runtime, não é manual)', () => {
    marca();
    const r = decidirTrocaForaDoFluxo({
      de: 'ACTIVE', para: 'SEARCHING', naFsm: false, cells: [],
      // @ts-expect-error 'admin_pannel' não pertence a PatientChangeSource
      changeSource: 'admin_pannel',
    });
    expect(r).toEqual({ resultado: 'nao_se_aplica', motivo: 'origem_nao_manual' });
  });

  it('contagem: 4 destinos x 14 casos + 3 derivados x |ROTA| + 1 de funil + 1 de tipo (contagem zero é falha, não sucesso)', () => {
    // por destino: 4 origens não manuais + funil(de) + nulo + mesmo estado + 2 na FSM
    //              + null + [] + só-outras + 2 permitidas = 14
    expect(casos).toBe(4 * 14 + DERIVADOS.length * ROTA_CHANGE_SOURCES.length + 2);
  });
});
