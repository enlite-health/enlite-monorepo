import { parseMode, stageFromStatus } from '../talentum-repontar-vaga-dona';

describe('talentum-repontar-vaga-dona (puro)', () => {
  it('exige exatamente um de --dry-run/--apply', () => {
    expect(parseMode(['--dry-run'])).toBe('dry-run');
    expect(parseMode(['--apply'])).toBe('apply');
    expect(() => parseMode([])).toThrow(/exatamente um/);
    expect(() => parseMode(['--apply', '--dry-run'])).toThrow(/exatamente um/);
  });

  it('etapa como o syncFunnel: INITIATED→PRE_SCREENING, NOT_QUALIFIED→REJECTED, PENDING→nada', () => {
    expect(stageFromStatus('INITIATED')).toBe('PRE_SCREENING');
    expect(stageFromStatus('NOT_QUALIFIED')).toBe('REJECTED');
    expect(stageFromStatus('PENDING')).toBeNull();
    expect(stageFromStatus('QUALIFIED')).toBe('QUALIFIED');
  });
});
