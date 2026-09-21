/**
 * Régua anti-DEFAULT da migration 457 (F1, change `anacare-horas-conclusao-de-corrida`) — as 6
 * colunas novas de `anacare_sync_run` são NULLABLE e SEM DEFAULT por decisão de produto (`NULL` =
 * DESCONHECIDO, nunca "zero"/"falhou"; as linhas de agosto/setembro pré-existentes ficam
 * `status IS NULL` de propósito). Um `DEFAULT` em qualquer uma mudaria esse significado em
 * silêncio (ex.: `DEFAULT 'running'` faria toda linha antiga PARECER em andamento).
 *
 * Decisão de implementação (diverge de design.md, que pedia consultar `information_schema.columns`
 * em Postgres real): o gate `_backend-quality.yml` roda `npm test -- --coverage` SEM nenhum
 * serviço de Postgres (confirmado lendo o workflow) — um teste que abrisse conexão real quebraria
 * o CI sempre, não só quando o DEFAULT aparecesse. Este teste lê o ARQUIVO da migration direto
 * (mesmo padrão de `identity/permissions/infrastructure/__tests__/protectedCells.sql-parity.test.ts`,
 * que já compara o texto de uma migration contra uma constante do app) e verifica cada linha
 * `ALTER TABLE ... ADD COLUMN` das 6 colunas novas.
 *
 * Verificado manualmente (não neste arquivo) contra Postgres 15 real: aplicar 443 depois 457 e
 * rodar `\d+ anacare_sync_run` mostra as 6 colunas com `Default` vazio — evidência colada na
 * entrega desta fase, fora do que o gate consegue rodar.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const MIGRATION_PATH = join(__dirname, '../../../../../migrations/457_anacare_sync_run_conclusao.sql');

const NEW_COLUMNS = ['status', '"cursor"', 'reservations_total', 'reservations_done', 'finished_at', 'last_error'];

/** Extrai a linha `ALTER TABLE anacare_sync_run ADD COLUMN IF NOT EXISTS <col> ...;` de uma coluna. */
function addColumnLine(sql: string, column: string): string {
  const re = new RegExp(`ALTER TABLE anacare_sync_run ADD COLUMN IF NOT EXISTS ${column} [^;]*;`);
  const m = sql.match(re);
  if (!m) throw new Error(`ADD COLUMN de "${column}" não encontrado na migration 457 — regex desatualizada ou coluna renomeada`);
  return m[0];
}

describe('migration 457 — anacare_sync_run: 6 colunas novas SEM DEFAULT', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');

  it('arquivo existe e tem as 6 colunas esperadas (contagem não é zero por caminho errado)', () => {
    expect(NEW_COLUMNS).toHaveLength(6);
    for (const column of NEW_COLUMNS) {
      expect(() => addColumnLine(sql, column)).not.toThrow();
    }
  });

  it.each(NEW_COLUMNS)('coluna %s: ADD COLUMN sem DEFAULT', (column) => {
    const line = addColumnLine(sql, column);
    expect(line.toUpperCase()).not.toMatch(/DEFAULT/);
  });

  /**
   * Prova de que a régua MORRE com DEFAULT: sabota uma CÓPIA em memória do texto da migration
   * (nunca escreve no arquivo real) acrescentando `DEFAULT 'running'` a `status`, roda a MESMA
   * checagem, e confirma que ela VIRA VERMELHA. Sem isto, um `expect(...).not.toMatch(/DEFAULT/)`
   * que nunca teve chance de falhar não prova nada (autoteste de um lado só).
   */
  it('SABOTAGEM: DEFAULT em status faz a régua morrer (prova que o teste acima detectaria)', () => {
    const sabotaged = sql.replace(
      'ALTER TABLE anacare_sync_run ADD COLUMN IF NOT EXISTS status TEXT NULL;',
      "ALTER TABLE anacare_sync_run ADD COLUMN IF NOT EXISTS status TEXT NULL DEFAULT 'running';",
    );
    expect(sabotaged).not.toEqual(sql); // a substituição realmente aconteceu
    const line = addColumnLine(sabotaged, 'status');
    expect(() => expect(line.toUpperCase()).not.toMatch(/DEFAULT/)).toThrow();
  });

  it('nenhuma das 6 colunas novas está em `NOT NULL` (todas aceitam DESCONHECIDO)', () => {
    for (const column of NEW_COLUMNS) {
      const line = addColumnLine(sql, column);
      expect(line.toUpperCase()).not.toMatch(/NOT NULL/);
    }
  });

  it('CHECK de status aceita NULL e só os 3 valores do domínio (running/done/failed)', () => {
    expect(sql).toMatch(/CHECK\s*\(\s*status IS NULL OR status IN \('running', 'done', 'failed'\)\s*\)/);
  });
});
