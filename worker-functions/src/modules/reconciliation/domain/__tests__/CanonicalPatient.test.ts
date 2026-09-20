/**
 * CanonicalPatient — lex C2: o canônico NUNCA carrega contato/documento de
 * responsável nem de profissional tratante.
 *
 * Controle positivo (D157): `containsForbiddenKeys` precisa acusar um objeto
 * que tenha essas chaves — senão o teste "passa" por não olhar.
 * Fixture sintética — nenhum dado real.
 */
import type { PatientServiceUpsertInput } from '@modules/case';
import { containsForbiddenKeys, toCanonical, UNREADABLE, isUnreadable } from '../CanonicalPatient';

const input: PatientServiceUpsertInput = {
  clickupTaskId: 'task-1',
  firstName: 'Ana',
  lastName: 'Pérez',
  birthDate: new Date('2015-03-04T00:00:00Z'),
  documentType: 'DNI',
  documentNumber: '12345678',
  diagnosis: 'texto sintético',
  responsibles: [{
    firstName: 'Rosa', lastName: 'Pérez', relationship: 'MOTHER',
    phone: '+5491100000000', email: 'rosa@example.test',
    documentType: 'DNI', documentNumber: '99999999', isPrimary: true, displayOrder: 0, source: 'clickup',
  } as PatientServiceUpsertInput['responsibles'] extends (infer R)[] | undefined ? R : never],
  professionals: [{ name: 'Dr. Teste', phone: '+5491100000001', email: 'dr@example.test', displayOrder: 0, isTeam: true }],
  addresses: [{ addressType: 'primary', addressFormatted: 'Calle Falsa 123', addressRaw: 'calle falsa 123', displayOrder: 0 }],
};

describe('toCanonical (C2)', () => {
  const c = toCanonical(input, 'AR');

  it('mantém identidade, clínico e nome/relação do responsável', () => {
    expect(c.firstName).toBe('Ana');
    expect(c.birthDate).toBe('2015-03-04');
    expect(c.diagnosis).toBe('texto sintético');
    expect(c.responsibleFirstName).toBe('Rosa');
    expect(c.responsibleRelationship).toBe('MOTHER');
    expect(c.multidisciplinaryTeam).toBe(true);
    expect(c.addresses).toEqual([{ kind: 'PRIMARY', formatted: 'Calle Falsa 123', raw: 'calle falsa 123' }]);
    expect(c.country).toBe('AR');
  });

  it('NÃO carrega telefone, e-mail nem documento de responsável/profissional', () => {
    const json = JSON.stringify(c);
    expect(json).not.toContain('+549110000000');
    expect(json).not.toContain('example.test');
    expect(json).not.toContain('99999999');
    expect(containsForbiddenKeys(c)).toBe(false);
  });

  it('controle positivo: o detector ACUSA um objeto com chave proibida', () => {
    expect(containsForbiddenKeys({ ...c, responsibles: [{ phone: 'x' }] })).toBe(true);
    expect(containsForbiddenKeys({ nested: { deep: { email: 'x' } } })).toBe(true);
  });

  it('UNREADABLE é distinto de null', () => {
    expect(isUnreadable(UNREADABLE)).toBe(true);
    expect(isUnreadable(null)).toBe(false);
    expect(isUnreadable({})).toBe(false);
  });
});
