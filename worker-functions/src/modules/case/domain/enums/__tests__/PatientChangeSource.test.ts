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
  saiDoFunilParaSearching,
  type PatientChangeSource,
} from '../PatientChangeSource';

const saemDoFunil = () => CHANGE_SOURCES.filter((s) => saiDoFunilParaSearching(s)).sort();

describe('PatientChangeSource — tabela de política por origem', () => {
  it('controle positivo: a tabela tem as 7 origens e as listas saem dela', () => {
    expect(CHANGE_SOURCES).toHaveLength(7);
    expect([...MANUAL_CHANGE_SOURCES, ...INTERNAL_CHANGE_SOURCES].sort()).toEqual([...CHANGE_SOURCES].sort());
  });

  it('D1: só o foguete e o arrasto do Kanban saem do funil — o lançamento da vaga (e toda origem só de leitura da trilha) NÃO sai', () => {
    expect(saemDoFunil()).toEqual(['kanban', 'recruitment_activation']);
    const naoSaem = CHANGE_SOURCES.filter((s) => !saiDoFunilParaSearching(s));
    expect(naoSaem).toHaveLength(CHANGE_SOURCES.length - 2);
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
    expect(POLITICA_POR_ORIGEM.resume).toEqual({ humana: true, aceitaNaRota: false, saiDoFunilParaSearching: false, escopoDaCompletude: 'paciente' });
    expect(isManualChangeSource('resume')).toBe(true);
    expect([...ROTA_CHANGE_SOURCES]).not.toContain('resume');
  });

  it('D2: o foguete mede o SERVIÇO; toda outra origem mede o paciente inteiro', () => {
    const escopos = Object.fromEntries(CHANGE_SOURCES.map((s: PatientChangeSource) => [s, escopoDaCompletudeDe(s)]));
    expect(escopos.recruitment_activation).toBe('servico');
    expect(CHANGE_SOURCES.filter((s) => escopoDaCompletudeDe(s) === 'servico')).toEqual(['recruitment_activation']);
  });
});
