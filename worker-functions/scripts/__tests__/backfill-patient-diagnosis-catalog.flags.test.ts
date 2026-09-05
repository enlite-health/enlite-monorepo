/**
 * spec 016 F4, Parte 2 — parsing dos flags do CLI do backfill. Puro.
 *
 * `--dry-run` é o DEFAULT (spec): escrever exige `--write` EXPLÍCITO. Não existe combinação de
 * flags que produza escrita sem `--write` — é a mesma disciplina do D10 do ingestor CID-11
 * ("falha VISÍVEL na configuração, nunca cai silenciosamente no ramo perigoso").
 */
import { parseBackfillFlags, shouldWrite } from '../backfill-diagnosis-catalog/cli-guards';

describe('parseBackfillFlags', () => {
  it('sem argumentos: dry-run (default), write=false', () => {
    expect(parseBackfillFlags([])).toEqual({ dryRun: true, write: false });
  });

  it('--dry-run explícito: mesmo resultado do default', () => {
    expect(parseBackfillFlags(['--dry-run'])).toEqual({ dryRun: true, write: false });
  });

  it('--write: sai do dry-run', () => {
    expect(parseBackfillFlags(['--write'])).toEqual({ dryRun: false, write: true });
  });

  it('--dry-run E --write juntos: --write NÃO vence — dry-run permanece true (fail-safe)', () => {
    expect(parseBackfillFlags(['--dry-run', '--write'])).toEqual({ dryRun: true, write: true });
  });
});

/**
 * `shouldWrite` — a decisão que `run()` faz. Ela existe porque o orquestrador perguntava
 * `flags.write` e gravava com `--dry-run` digitado (gate F5, D3). A tabela abaixo é a mesma
 * do parser acima, lida pela outra ponta: o que sai do parser × o que o caminho de escrita faz.
 */
describe('shouldWrite — dry-run vence, em todas as combinações', () => {
  it.each([
    [[], false],
    [['--dry-run'], false],
    [['--write'], true],
    [['--dry-run', '--write'], false],
    [['--write', '--dry-run'], false],
  ] as ReadonlyArray<[string[], boolean]>)('%j → grava=%s', (args, esperado) => {
    expect(shouldWrite(parseBackfillFlags(args))).toBe(esperado);
  });

  it('só `--write` sozinho libera a escrita — é a ÚNICA combinação que grava', () => {
    expect(shouldWrite({ dryRun: false, write: true })).toBe(true);
    expect(shouldWrite({ dryRun: true, write: true })).toBe(false);
    expect(shouldWrite({ dryRun: false, write: false })).toBe(false);
    expect(shouldWrite({ dryRun: true, write: false })).toBe(false);
  });
});
