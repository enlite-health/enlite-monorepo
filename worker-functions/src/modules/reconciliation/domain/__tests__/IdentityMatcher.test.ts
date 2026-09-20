/**
 * IdentityMatcher — R2 da spec 003.
 * Cobre: documento igual; nome+data iguais; nome igual + data ≠ → AMBIGUOUS;
 * acento/caixa/pontuação; DENIED persiste; duplicata interna → AMBIGUOUS;
 * documento igual com nome outro → AMBIGUOUS; nenhum → NONE.
 * Fixture sintética — nenhum dado real.
 */
import { IdentityMatcher, normalizeDocument, normalizeName } from '../IdentityMatcher';
import type { IdentityCandidate, IdentityProbe } from '../IdentityMatcher';

const matcher = new IdentityMatcher();

const ana: IdentityCandidate = {
  patientId: 'p-ana', firstName: 'Ana María', lastName: 'Pérez', birthDate: '2015-03-04',
  documentType: 'DNI', documentNumber: '12.345.678',
};
const bruno: IdentityCandidate = {
  patientId: 'p-bruno', firstName: 'Bruno', lastName: 'Silva', birthDate: '2010-01-01',
  documentType: null, documentNumber: null,
};

function probe(over: Partial<IdentityProbe>): IdentityProbe {
  return { firstName: null, lastName: null, birthDate: null, documentType: null, documentNumber: null, ...over };
}

describe('normalize*', () => {
  it('nome: acento, caixa, pontuação e espaços', () => {
    expect(normalizeName('  ANA  MARÍA', 'Pérez.')).toBe('ana maria perez');
    expect(normalizeName(null, null)).toBeNull();
  });
  it('documento: só o número normalizado, tipo NÃO entra na chave (F14)', () => {
    expect(normalizeDocument('dni', '12.345.678')).toBe('12345678');
    expect(normalizeDocument('TI', '12.345.678')).toBe('12345678');
    expect(normalizeDocument('', '12.345.678')).toBe('12345678');
    expect(normalizeDocument(null, '12.345.678')).toBe('12345678');
    expect(normalizeDocument('DNI', null)).toBeNull();
  });
});

describe('IdentityMatcher.match', () => {
  it('documento igual → MATCH DOCUMENT (mesmo com nome escrito diferente mas parecido)', () => {
    const out = matcher.match(probe({ documentType: 'DNI', documentNumber: '12345678', firstName: 'ana m', lastName: 'perez' }), [ana, bruno]);
    expect(out).toEqual({ kind: 'MATCH', matchKey: 'DOCUMENT', patientId: 'p-ana' });
  });

  it('mesmo número, tipos diferentes (\'\' vs \'TI\') → casam por DOCUMENT (F14: 59/66 pacientes com tipo vazio)', () => {
    const semTipo: IdentityCandidate = {
      patientId: 'p-sem-tipo', firstName: 'Ana María', lastName: 'Pérez', birthDate: '2015-03-04',
      documentType: '', documentNumber: '12345678',
    };
    const out = matcher.match(probe({ documentType: 'TI', documentNumber: '12.345.678', firstName: 'ana m', lastName: 'perez' }), [semTipo]);
    expect(out).toEqual({ kind: 'MATCH', matchKey: 'DOCUMENT', patientId: 'p-sem-tipo' });
  });

  it('documento igual mas nome claramente outro → AMBIGUOUS, nunca funde', () => {
    const out = matcher.match(probe({ documentType: 'DNI', documentNumber: '12345678', firstName: 'Carlos', lastName: 'Gómez' }), [ana]);
    expect(out).toEqual({ kind: 'AMBIGUOUS', candidatePatientId: 'p-ana', reason: 'DOCUMENT_MATCH_NAME_DIFFERS' });
  });

  it('sem documento: nome + nascimento iguais → MATCH NAME_BIRTHDATE', () => {
    const out = matcher.match(probe({ firstName: 'bruno', lastName: 'SILVA', birthDate: '2010-01-01' }), [ana, bruno]);
    expect(out).toEqual({ kind: 'MATCH', matchKey: 'NAME_BIRTHDATE', patientId: 'p-bruno' });
  });

  it('nome igual, data diferente → AMBIGUOUS com o candidato', () => {
    const out = matcher.match(probe({ firstName: 'Bruno', lastName: 'Silva', birthDate: '2011-01-01' }), [bruno]);
    expect(out).toEqual({ kind: 'AMBIGUOUS', candidatePatientId: 'p-bruno', reason: 'NAME_MATCH_BIRTHDATE_DIFFERS' });
  });

  it('data igual, nome parecido (token comum) mas diferente → AMBIGUOUS', () => {
    const out = matcher.match(probe({ firstName: 'Bruno', lastName: 'Silveira', birthDate: '2010-01-01' }), [bruno]);
    expect(out).toEqual({ kind: 'AMBIGUOUS', candidatePatientId: 'p-bruno', reason: 'BIRTHDATE_MATCH_NAME_DIFFERS' });
  });

  it('DENIED persiste: candidato negado sai do pool mesmo com chave forte', () => {
    const out = matcher.match(
      probe({ documentType: 'DNI', documentNumber: '12345678', firstName: 'Ana María', lastName: 'Pérez' }),
      [ana],
      new Set(['p-ana']),
    );
    expect(out).toEqual({ kind: 'NONE' });
  });

  it('duplicata interna (dois candidatos com o mesmo documento) → AMBIGUOUS MULTIPLE_CANDIDATES', () => {
    const anaDup = { ...ana, patientId: 'p-ana-2' };
    const out = matcher.match(probe({ documentType: 'DNI', documentNumber: '12345678', firstName: 'Ana', lastName: 'Pérez' }), [ana, anaDup]);
    expect(out.kind).toBe('AMBIGUOUS');
    expect((out as { reason?: string }).reason).toBe('MULTIPLE_CANDIDATES');
  });

  it('nada bate → NONE', () => {
    expect(matcher.match(probe({ firstName: 'Zé', lastName: 'Ninguém', birthDate: '1999-09-09' }), [ana, bruno])).toEqual({ kind: 'NONE' });
  });
});
