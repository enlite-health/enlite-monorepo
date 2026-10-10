import { ADMISSION_CODE_ALPHABET, generateAdmissionCode } from '../admissionCode';

describe('generateAdmissionCode (spec 049, A3-9)', () => {
  it('formato ADM-XXXXXX: 6 caracteres de [0-9A-Z] — o mesmo CHECK da migration 503', () => {
    for (let i = 0; i < 2000; i += 1) expect(generateAdmissionCode()).toMatch(/^ADM-[0-9A-Z]{6}$/);
  });

  it('nunca usa 0, O, 1, I (não se confundem ao ler em voz alta)', () => {
    expect(ADMISSION_CODE_ALPHABET).not.toMatch(/[01OI]/);
    for (let i = 0; i < 2000; i += 1) expect(generateAdmissionCode().slice(4)).not.toMatch(/[01OI]/);
  });

  it('o alfabeto tem 32 símbolos e o sorteio os cobre (o pick recebe o tamanho do alfabeto)', () => {
    expect(ADMISSION_CODE_ALPHABET).toHaveLength(32);
    const seen: number[] = [];
    generateAdmissionCode((max) => { seen.push(max); return 0; });
    expect(seen).toEqual([32, 32, 32, 32, 32, 32]);
    expect(generateAdmissionCode(() => 31)).toBe('ADM-ZZZZZZ');
    expect(generateAdmissionCode(() => 0)).toBe('ADM-222222');
  });

  it('dois códigos seguidos diferem (CSPRNG de verdade, não constante)', () => {
    const set = new Set(Array.from({ length: 200 }, () => generateAdmissionCode()));
    expect(set.size).toBeGreaterThan(190);
  });
});
