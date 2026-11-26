import {
  CORES, FAIXAS_DO_SEMAFORO, GRAVIDADE_DA_COR, corDoSemaforo, corDoSemaforoSql, piorCor,
} from '../vacancySemaphore';

describe('corDoSemaforo — a cor sai da tabela FAIXAS_DO_SEMAFORO', () => {
  it.each([
    [0, 'red'], [4, 'red'],
    [5, 'yellow'], [9, 'yellow'],
    [10, 'green'], [11, 'green'], [999, 'green'],
  ])('n=%i -> %s', (n, cor) => {
    expect(corDoSemaforo(n)).toBe(cor);
  });

  it('a tabela cobre as 3 cores, a última faixa não tem teto e as faixas encostam (até exclusivo)', () => {
    expect(FAIXAS_DO_SEMAFORO.map((f) => f.cor)).toEqual([...CORES]);
    expect(FAIXAS_DO_SEMAFORO[FAIXAS_DO_SEMAFORO.length - 1].ate).toBeNull();
    FAIXAS_DO_SEMAFORO.slice(1).forEach((f, i) => expect(f.de).toBe(FAIXAS_DO_SEMAFORO[i].ate));
  });
});

describe('piorCor — a mais grave pela tabela GRAVIDADE_DA_COR', () => {
  it('escolhe a pior, em qualquer ordem', () => {
    expect(piorCor(['green', 'yellow'])).toBe('yellow');
    expect(piorCor(['green', 'red', 'yellow'])).toBe('red');
    expect(piorCor(['red', 'green'])).toBe('red');
    expect(piorCor(['green', 'green'])).toBe('green');
  });
  it('lista vazia -> null (sem vaga, sem cor)', () => {
    expect(piorCor([])).toBeNull();
  });
  it('a gravidade cobre todas as cores', () => {
    expect(Object.keys(GRAVIDADE_DA_COR).sort()).toEqual([...CORES].sort());
  });
});

describe('corDoSemaforoSql — gerado da mesma tabela', () => {
  const sql = corDoSemaforoSql('x.n');
  it('tem um WHEN por faixa', () => {
    expect(sql.match(/WHEN /g)).toHaveLength(FAIXAS_DO_SEMAFORO.length);
  });
  it('referencia a expressão e cada cor, e os limites vêm da tabela', () => {
    expect(sql).toContain('x.n');
    FAIXAS_DO_SEMAFORO.forEach((f) => expect(sql).toContain(`THEN '${f.cor}'`));
    FAIXAS_DO_SEMAFORO.forEach((f) => expect(sql).toContain(`>= ${f.de}`));
    FAIXAS_DO_SEMAFORO.filter((f) => f.ate !== null).forEach((f) => expect(sql).toContain(`< ${f.ate}`));
  });
});
