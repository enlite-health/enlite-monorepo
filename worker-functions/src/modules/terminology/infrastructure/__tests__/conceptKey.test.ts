/**
 * conceptKey — o espelho TS da função SQL `terminology.concept_key` (migration 328).
 *
 * A PARIDADE entre os dois (a mesma URI real dá a mesma chave nos dois lados) é provada contra o
 * catálogo real em `tests/e2e/concept-key-parity.e2e.test.ts`. Aqui fica a forma.
 */
import { conceptKey } from '../conceptKey';

describe('conceptKey — identidade de conceito estável entre releases (T2)', () => {
  it('remove o segmento de release da URI canônica da OMS', () => {
    expect(conceptKey('http://id.who.int/icd/release/11/2026-01/mms/405565289')).toBe('mms/405565289');
  });

  it('a MESMA entidade em releases diferentes dá a MESMA chave — é o ponto inteiro da correção', () => {
    const em2026 = conceptKey('http://id.who.int/icd/release/11/2026-01/mms/405565289/unspecified');
    const em2027 = conceptKey('http://id.who.int/icd/release/11/2027-01/mms/405565289/unspecified');
    expect(em2026).toBe(em2027);
    expect(em2026).toBe('mms/405565289/unspecified');
  });

  it('entidades DIFERENTES continuam com chaves diferentes — a normalização não afrouxa a identidade', () => {
    expect(conceptKey('http://id.who.int/icd/release/11/2026-01/mms/111')).not.toBe(
      conceptKey('http://id.who.int/icd/release/11/2026-01/mms/222'),
    );
  });

  it('o HOST não faz parte da identidade (o ingestor reescreve host para o container local)', () => {
    expect(conceptKey('http://localhost:8085/icd/release/11/2026-01/mms/999')).toBe(
      conceptKey('http://id.who.int/icd/release/11/2026-01/mms/999'),
    );
  });

  it('URI SEM o marcador de release passa INTACTA (fixture de teste, vocabulário não-OMS)', () => {
    expect(conceptKey('test://c1/orphan')).toBe('test://c1/orphan');
    expect(conceptKey('')).toBe('');
  });

  it('a linearização faz parte da chave — mms e outra linearização não colidem', () => {
    expect(conceptKey('http://id.who.int/icd/release/11/2026-01/mms/123')).not.toBe(
      conceptKey('http://id.who.int/icd/release/11/2026-01/icf/123'),
    );
  });
});
