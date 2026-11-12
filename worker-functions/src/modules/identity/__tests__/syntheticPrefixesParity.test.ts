/**
 * Paridade dos prefixos sintéticos (spec acesso-do-cliente, F1, item 12; design §2.2 "Backfill" 3).
 *
 * A migration 580 congela a lista de prefixos de `auth_uid` sintético (iam._is_synthetic_uid) — migration é ato único.
 * Este teste morre se ela divergir de SYNTHETIC_AUTH_UID_PREFIXES. "Sintético" do iam (6, com `talentum_`) é DE PROPÓSITO
 * diferente de `isImportedWorker` do claim (5, sem `talentum_`): sintético = "não é login real"; importável = "pode ser reclamado".
 */
import * as fs from 'fs';
import * as path from 'path';
import { SYNTHETIC_AUTH_UID_PREFIXES } from '../../../infrastructure/services/WorkerPhoneMergeTypes';

const MIGRATION = path.resolve(__dirname, '../../../../migrations/580_iam_person.sql');

function prefixesFromSql(sql: string): string[] {
  const fn = /CREATE FUNCTION iam\._is_synthetic_uid[\s\S]*?\$\$;/.exec(sql);
  if (!fn) throw new Error('iam._is_synthetic_uid não encontrada na migration 580');
  const arr = /ARRAY\[([\s\S]*?)\]/.exec(fn[0]);
  if (!arr) throw new Error('lista ARRAY[...] não encontrada em iam._is_synthetic_uid');
  return [...arr[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('paridade: lista de prefixos sintéticos da migration 580 × SYNTHETIC_AUTH_UID_PREFIXES', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');

  it('a lista do SQL é exatamente SYNTHETIC_AUTH_UID_PREFIXES (mesmos itens, mesma ordem)', () => {
    expect(prefixesFromSql(sql)).toEqual([...SYNTHETIC_AUTH_UID_PREFIXES]);
  });

  it('controle: o extrator enxerga os 6 prefixos e pega divergência (prefixo a mais / a menos)', () => {
    expect(prefixesFromSql(sql)).toHaveLength(6);
    const sabotado = sql.replace("'talentum_'", "'talentum_',\n      'novo_'");
    expect(prefixesFromSql(sabotado)).not.toEqual([...SYNTHETIC_AUTH_UID_PREFIXES]);
    const sem = sql.replace(/,\s*'talentum_'/, '');
    expect(prefixesFromSql(sem)).not.toEqual([...SYNTHETIC_AUTH_UID_PREFIXES]);
  });

  it('o backfill e o gancho usam a MESMA função (nenhuma segunda lista literal na migration)', () => {
    expect((sql.match(/anacareimport_/g) ?? []).length).toBe(1);
  });
});
