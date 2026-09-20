/**
 * Unit de `scripts/lib/cliArgs.ts` (B3) — a fonte única de `argValue` que antes
 * estava copiada byte a byte em três scripts (set-staff-country-claim,
 * iam-config-export, iam-config-import).
 */
import { argValue } from '../../../scripts/lib/cliArgs';

describe('argValue', () => {
  it('devolve o valor logo após a flag', () => {
    expect(argValue('--out', ['node', 'script.ts', '--out', 'file.json'])).toBe('file.json');
  });

  it('flag ausente → undefined', () => {
    expect(argValue('--out', ['node', 'script.ts'])).toBeUndefined();
  });

  it('flag na última posição, sem valor seguinte → undefined', () => {
    expect(argValue('--out', ['node', 'script.ts', '--out'])).toBeUndefined();
  });

  it('sem argv explícito, usa process.argv', () => {
    const anterior = process.argv;
    process.argv = ['node', 'script.ts', '--tenant', 'abc'];
    try {
      expect(argValue('--tenant')).toBe('abc');
    } finally {
      process.argv = anterior;
    }
  });
});
