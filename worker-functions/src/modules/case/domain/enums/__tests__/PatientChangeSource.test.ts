/**
 * Tabela de política por origem (estado-automatico-do-paciente, design §4): o dono único de quem sai do funil para
 * `SEARCHING`, de quem é humano / aceito na rota e do escopo da completude. Os testes leem a TABELA e conferem o
 * que os leitores (zod da rota, escritor) enxergam — nenhuma lista de origem repetida aqui.
 */
import {
  CHANGE_SOURCES,
  INTERNAL_CHANGE_SOURCES,
  MANUAL_CHANGE_SOURCES,
  ROTA_CHANGE_SOURCES,
  POLITICA_POR_ORIGEM,
  escopoDaCompletudeDe,
  isManualChangeSource,
  origemPodePedirDestino,
  saiDoFunilParaSearching,
  type PatientChangeSource,
} from '../PatientChangeSource';

const saemDoFunil = () => CHANGE_SOURCES.filter((s) => saiDoFunilParaSearching(s)).sort();

describe('PatientChangeSource — tabela de política por origem', () => {
  it('controle positivo: a tabela tem as 7 origens e as listas saem dela', () => {
    expect(CHANGE_SOURCES).toHaveLength(7);
    expect([...MANUAL_CHANGE_SOURCES, ...INTERNAL_CHANGE_SOURCES].sort()).toEqual([...CHANGE_SOURCES].sort());
  });

  it('D1 + F5: SÓ o foguete sai do funil — nem o arrasto do Kanban (saiu na F5), nem o lançamento da vaga, nem origem só de leitura', () => {
    expect(saemDoFunil()).toEqual(['recruitment_activation']);
    const naoSaem = CHANGE_SOURCES.filter((s) => !saiDoFunilParaSearching(s));
    expect(naoSaem).toHaveLength(CHANGE_SOURCES.length - 1);
    expect(naoSaem.filter((s) => s.startsWith('vacancy_'))).toHaveLength(1); // a origem do lançamento continua na união (trilha antiga) mas sem saída
  });

  it('a rota HTTP só aceita as origens marcadas na tabela, e todas elas são humanas', () => {
    const aceitas = CHANGE_SOURCES.filter((s) => POLITICA_POR_ORIGEM[s].aceitaNaRota).sort();
    expect(aceitas).toEqual([...ROTA_CHANGE_SOURCES].sort());
    expect(aceitas).toEqual(['admin_panel', 'kanban']);
    for (const s of CHANGE_SOURCES) expect(isManualChangeSource(s)).toBe(POLITICA_POR_ORIGEM[s].humana);
    for (const s of ROTA_CHANGE_SOURCES) expect(POLITICA_POR_ORIGEM[s].humana).toBe(true);
  });

  it('F3 (E3): `resume` é humana (motivo de saída de SUSPENDED + trava de alocação), NÃO é aceita na rota e NÃO sai do funil', () => {
    expect(POLITICA_POR_ORIGEM.resume).toMatchObject({ humana: true, aceitaNaRota: false, saiDoFunilParaSearching: false, escopoDaCompletude: 'paciente' });
    expect(isManualChangeSource('resume')).toBe(true);
    expect([...ROTA_CHANGE_SOURCES]).not.toContain('resume');
  });

  it('D2: o foguete mede o SERVIÇO; toda outra origem mede o paciente inteiro', () => {
    const escopos = Object.fromEntries(CHANGE_SOURCES.map((s: PatientChangeSource) => [s, escopoDaCompletudeDe(s)]));
    expect(escopos.recruitment_activation).toBe('servico');
    expect(CHANGE_SOURCES.filter((s) => escopoDaCompletudeDe(s) === 'servico')).toEqual(['recruitment_activation']);
  });

  it('F5: quem pode pedir cada destino clínico sai da tabela — admin_panel só os humanos, kanban nenhum, o resto do fluxo automático os derivados', () => {
    const DERIVADOS = ['SEARCHING', 'REPLACEMENT', 'ACTIVE'] as const;
    const HUMANOS = ['ON_HOLD', 'SUSPENDED', 'ALTA', 'DISCHARGED'] as const;
    for (const d of DERIVADOS) expect(origemPodePedirDestino('admin_panel', d)).toBe(false);
    for (const d of HUMANOS) expect(origemPodePedirDestino('admin_panel', d)).toBe(true);
    for (const d of [...DERIVADOS, ...HUMANOS, 'ADMISSION', 'SOLICITANTE', 'PENDING_ADMISSION'] as const) expect(origemPodePedirDestino('kanban', d)).toBe(false);
    for (const o of ['system', 'resume'] as const) for (const d of DERIVADOS) expect(origemPodePedirDestino(o, d)).toBe(true);
    expect(CHANGE_SOURCES.filter((o) => origemPodePedirDestino(o, 'SEARCHING')).sort()).toEqual(['recruitment_activation', 'resume', 'system']);
    expect(CHANGE_SOURCES.filter((o) => origemPodePedirDestino(o, 'ACTIVE')).sort()).toEqual(['resume', 'system']);
  });
});
