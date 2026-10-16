import { generateAdmissionCode } from '../admissionCode';
import { ENQUADRE_CODE_PREFIX, generateEnquadreCode } from '../enquadreCode';

describe('código do evento de enquadre (spec 052)', () => {
  it('generateEnquadreCode casa ^ENC-[0-9A-Z]{6}$ e não usa 0/O/1/I', () => {
    expect(ENQUADRE_CODE_PREFIX).toBe('ENC-');
    for (let i = 0; i < 2000; i += 1) {
      const code = generateEnquadreCode();
      expect(code).toMatch(/^ENC-[0-9A-Z]{6}$/);
      expect(code.slice(4)).not.toMatch(/[01OI]/);
    }
  });

  it('reusa o sorteio da admissão (mesmo pick → mesmo sufixo)', () => {
    expect(generateEnquadreCode(() => 0)).toBe('ENC-222222');
    expect(generateEnquadreCode(() => 31)).toBe('ENC-ZZZZZZ');
  });

  it('generateAdmissionCode continua ADM- (prefixo opcional não muda o default)', () => {
    for (let i = 0; i < 200; i += 1) expect(generateAdmissionCode()).toMatch(/^ADM-[0-9A-Z]{6}$/);
    expect(generateAdmissionCode(() => 0)).toBe('ADM-222222');
  });
});
