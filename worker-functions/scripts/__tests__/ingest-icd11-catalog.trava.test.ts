/**
 * F1.6 — a trava de alvo do ingestor do CID-11 (gate `revisao-pr`, BLOQUEADOR 4).
 *
 * O ingestor ESCREVE 35.692 linhas. Ele era o único script de escrita do PR sem trava de alvo:
 * abria um `Pool` direto do `DATABASE_URL`, então apontar a variável para produção bastava.
 *
 * 🔴 Por que cada teste afirma a MENSAGEM e não só "lançou": ao ligar a trava eu errei o import
 * e o `createPool` passou a estourar `assertLocalDatabaseTarget is not defined` — um
 * ReferenceError. Um teste `expect(...).toThrow()` teria ficado VERDE com a trava morta, porque
 * "lançou" era verdade pelo motivo errado. E o `tsc` não pegava: `tsconfig.json` inclui só
 * `src/**\/*`, então a pasta `scripts/` inteira fica fora do type-check (medido: 87 arquivos,
 * 160 erros se entrasse — dívida pré-existente, na LISTA).
 *
 * Régua POSITIVA: cada caso exige o texto da recusa certa.
 */
import { createPool } from '../ingest-icd11-catalog';

const url = (u: string) => ({ DATABASE_URL: u }) as unknown as NodeJS.ProcessEnv;

describe('createPool — trava de alvo do ingestor', () => {
  it('ACEITA o docker local (é para onde a ingestão deve ir)', () => {
    const pool = createPool(url('postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e'));
    expect(pool).toBeDefined();
    return pool.end();
  });

  it('RECUSA a porta de PRD (5436) dizendo qual porta barrou', () => {
    expect(() => createPool(url('postgresql://u:p@localhost:5436/enlite_ar'))).toThrow(/TRAVA: porta 5436/);
  });

  it('RECUSA a porta de stage (5434)', () => {
    expect(() => createPool(url('postgresql://u:p@localhost:5434/enlite_ar'))).toThrow(/TRAVA: porta 5434/);
  });

  it('RECUSA query string — o truque que fura a trava copiada dos backfills', () => {
    // `?port=5436` mantém o path parecendo local, mas o `pg` conecta em 5436 (PRD).
    expect(() => createPool(url('postgresql://u:p@localhost:5432/enlite_e2e?port=5436'))).toThrow(/TRAVA: DATABASE_URL com query string/);
  });

  it('RECUSA socket do Cloud SQL', () => {
    expect(() => createPool(url('postgresql://u:p@/enlite_ar?host=/cloudsql/enlite-prd:x:y'))).toThrow(/TRAVA:/);
  });

  it('RECUSA base que não é a de teste', () => {
    expect(() => createPool(url('postgresql://u:p@localhost:5432/enlite_ar'))).toThrow(/TRAVA: base "enlite_ar"/);
  });

  it('RECUSA host remoto', () => {
    expect(() => createPool(url('postgresql://u:p@10.0.0.5:5432/enlite_e2e'))).toThrow(/TRAVA: host "10.0.0.5"/);
  });

  it('nenhuma recusa vem de ReferenceError — a trava tem de estar VIVA, não quebrada', () => {
    // O modo de falha que este arquivo existe para impedir: import errado deixa a função
    // indefinida, tudo "recusa", e um teste frouxo aprova a trava morta.
    try {
      createPool(url('postgresql://u:p@localhost:5436/enlite_ar'));
      throw new Error('deveria ter recusado');
    } catch (e) {
      expect(e).not.toBeInstanceOf(ReferenceError);
      expect(String((e as Error).message)).toMatch(/^TRAVA:/);
    }
  });
});
