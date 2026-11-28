/**
 * vacancyPublication — o DONO de "vaga publicável" (semaforo-da-vaga F4, P5 opção A + P6).
 * A regra em TS e o SQL gerado saem da MESMA tabela de fatos; este teste as segura juntas.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  PACIENTE_QUE_PAUSA_A_VAGA,
  STATUS_QUE_TIRAM_DO_FEED,
  vagaPublicavel,
  pacientePausadoSql,
  vagaPublicavelSql,
  type VagaPublicacaoFatos,
} from '../vacancyPublication';

const VIVA: VagaPublicacaoFatos = {
  status: 'PENDING_ACTIVATION', isDraft: false, isTest: false, deleted: false, serviceActive: true, patientStatus: 'SEARCHING',
};

describe('vagaPublicavel (TS)', () => {
  it('controle positivo: a vaga do foguete (PENDING_ACTIVATION, lançada, paciente em Búsqueda) é publicável', () => {
    expect(vagaPublicavel(VIVA)).toBe(true);
  });

  it.each(['SEARCHING', 'SEARCHING_REPLACEMENT', 'RAPID_RESPONSE', 'ACTIVE', 'PENDING_ACTIVATION'] as const)('%s lançada é publicável', (status) => {
    expect(vagaPublicavel({ ...VIVA, status })).toBe(true);
  });

  it.each(['DE_BAJA', 'CLOSED', 'ON_HOLD', 'SUSPENDED'] as const)('legado %s fica fora (D6)', (status) => {
    expect(vagaPublicavel({ ...VIVA, status })).toBe(false);
  });

  it('rascunho, apagada, teste e serviço inativo ficam fora', () => {
    expect(vagaPublicavel({ ...VIVA, isDraft: true })).toBe(false);
    expect(vagaPublicavel({ ...VIVA, deleted: true })).toBe(false);
    expect(vagaPublicavel({ ...VIVA, isTest: true })).toBe(false);
    expect(vagaPublicavel({ ...VIVA, serviceActive: false })).toBe(false);
  });

  it('vaga sem serviço (serviceActive null) e sem paciente (patientStatus null) continua publicável', () => {
    expect(vagaPublicavel({ ...VIVA, serviceActive: null, patientStatus: null })).toBe(true);
  });

  it.each(['ON_HOLD', 'SUSPENDED', 'ALTA', 'DISCHARGED'])('P6: paciente %s tira a vaga do ar', (patientStatus) => {
    expect(vagaPublicavel({ ...VIVA, patientStatus })).toBe(false);
  });

  it.each(['ACTIVE', 'SEARCHING', 'REPLACEMENT', 'ADMISSION'])('P6: paciente %s mantém a vaga no ar', (patientStatus) => {
    expect(vagaPublicavel({ ...VIVA, patientStatus })).toBe(true);
  });
});

describe('opção incluirTeste (página pública e candidatura servem a vaga de teste; feed, raio e Luz seguem excluindo)', () => {
  it('TS: vaga is_test é publicável SÓ com incluirTeste; todas as outras regras seguem valendo', () => {
    const teste = { ...VIVA, isTest: true };
    expect(vagaPublicavel(teste)).toBe(false);
    expect(vagaPublicavel(teste, { incluirTeste: true })).toBe(true);
    expect(vagaPublicavel({ ...teste, isDraft: true }, { incluirTeste: true })).toBe(false);
    expect(vagaPublicavel({ ...teste, status: 'DE_BAJA' }, { incluirTeste: true })).toBe(false);
    expect(vagaPublicavel({ ...teste, patientStatus: 'SUSPENDED' }, { incluirTeste: true })).toBe(false);
    expect(vagaPublicavel({ ...teste, serviceActive: false }, { incluirTeste: true })).toBe(false);
  });

  it('SQL: a MESMA regra gerada, sem a cláusula is_test; o padrão (sem opção) continua excluindo teste', () => {
    expect(vagaPublicavelSql('jp', 'p')).toContain('jp.is_test = false');
    const com = vagaPublicavelSql('jp', 'p', { incluirTeste: true });
    expect(com).not.toContain('is_test');
    expect(com.replace('jp.is_test = false\n         AND ', '')).toBe(vagaPublicavelSql('jp', 'p').replace('jp.is_test = false\n         AND ', ''));
    expect(com).toContain('jp.is_draft = false');
    expect(com).toMatch(/\bp\.status/);
  });
});

describe('vagaPublicavelSql (gerado da mesma regra)', () => {
  const sql = vagaPublicavelSql('jp', 'p');

  it('carrega TODOS os valores das duas tabelas (ON_HOLD e SUSPENDED existem nas duas: 2 ocorrências)', () => {
    const [doStatus, doPaciente] = sql.split('COALESCE');
    for (const s of STATUS_QUE_TIRAM_DO_FEED) expect(doStatus.match(new RegExp(`'${s}'`, 'g'))).toHaveLength(1);
    for (const s of PACIENTE_QUE_PAUSA_A_VAGA) expect(doPaciente.match(new RegExp(`'${s}'`, 'g'))).toHaveLength(1);
  });

  it('PENDING_ACTIVATION não aparece (é publicável: allowlist invertida)', () => {
    expect(sql).not.toContain('PENDING_ACTIVATION');
  });

  it('usa os aliases recebidos', () => {
    const outro = vagaPublicavelSql('x', 'pac');
    expect(outro).toContain('x.status');
    expect(outro).toContain('pac.status');
    expect(outro).not.toContain('jp.');
  });

  it('semPaciente omite SÓ a cláusula do paciente (a marcação de pausa do Talentum usa essa forma)', () => {
    const sem = vagaPublicavelSql('jp', 'p', { semPaciente: true });
    expect(sem).not.toMatch(/\bp\.status/);
    expect(sem).toContain('jp.is_draft');
    expect(sql).toMatch(/\bp\.status/);
  });

  it('p é opcional na forma semPaciente (sem alias de paciente no FROM)', () => {
    expect(() => vagaPublicavelSql('jp', undefined, { semPaciente: true })).not.toThrow();
  });
});

describe('pacientePausadoSql (a marcação de pausa do publish; gerado da MESMA tabela do paciente)', () => {
  it('carrega exatamente os estados de PACIENTE_QUE_PAUSA_A_VAGA, com o alias recebido', () => {
    const sql = pacientePausadoSql('pac');
    expect(sql).toBe(`pac.status IN (${PACIENTE_QUE_PAUSA_A_VAGA.map((x) => `'${x}'`).join(', ')})`);
    expect(pacientePausadoSql()).toMatch(/^p\.status IN/);
  });
});

describe('o dono não importa pg', () => {
  it('from pg em matching/domain/vacancyPublication.ts = 0', () => {
    const fonte = readFileSync(join(__dirname, '../vacancyPublication.ts'), 'utf8');
    expect(fonte.match(/from ['"]pg['"]/g)).toBeNull();
  });
});
