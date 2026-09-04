/**
 * spec 016 F4, Parte 2 — parsing dos flags do CLI do backfill. Puro.
 *
 * `--dry-run` é o DEFAULT (spec): escrever exige `--write` EXPLÍCITO. Não existe combinação de
 * flags que produza escrita sem `--write` — é a mesma disciplina do D10 do ingestor CID-11
 * ("falha VISÍVEL na configuração, nunca cai silenciosamente no ramo perigoso").
 */
import { parseBackfillFlags } from '../backfill-diagnosis-catalog/cli-guards';

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
