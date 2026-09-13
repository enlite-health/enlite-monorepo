/**
 * RESTRICTED_CLINICAL_COLUMNS — bloco B (spec 012; lex C7.1-d e C2.1): `on_hold_note` e
 * `access_notes` são texto livre da mesma classe de `emergency_instructions` e NUNCA saem por
 * SQL ad-hoc para um LLM. O controle que vale é a role (create-mcp-ro-role.sql); esta camada
 * é defesa em profundidade e falha ANTES de tocar o banco.
 */
import { Pool } from 'pg';
import { ReadonlyDbQueryService, RESTRICTED_CLINICAL_COLUMNS } from '../ReadonlyDbQueryService';

describe('ReadonlyDbQueryService — colunas restritas do bloco B', () => {
  const connect = jest.fn();
  const service = new ReadonlyDbQueryService({ connect } as unknown as Pool);

  it.each(['on_hold_note', 'ON_HOLD_NOTE', 'access_notes', 'clinical_context', 'general_objective'])('%s: recusado sem abrir conexão', async (col) => {
    await expect(service.run(`SELECT ${col} FROM patients LIMIT 1`)).rejects.toThrow(/restricted clinical column/);
    expect(connect).not.toHaveBeenCalled();
  });

  it.each(['on_hold_note', 'ON_HOLD_NOTE', 'access_notes', 'address_type_other'])('%s: recusado sem abrir conexão (patient_addresses)', async (col) => {
    await expect(service.run(`SELECT ${col} FROM patient_addresses LIMIT 1`)).rejects.toThrow(/restricted clinical column/);
    expect(connect).not.toHaveBeenCalled();
  });

  it('a regex nomeia as seis colunas e continua pegando emergency_instructions', () => {
    for (const c of ['emergency_instructions', 'on_hold_note', 'access_notes', 'clinical_context', 'general_objective', 'address_type_other']) expect(RESTRICTED_CLINICAL_COLUMNS.test(c)).toBe(true);
    expect(RESTRICTED_CLINICAL_COLUMNS.test('on_hold_reason')).toBe(false); // rótulo de catálogo, não texto
  });

  it('spec 019: address_type (enum fechado) NÃO entra na regex — o controle dele é o REVOKE (B1/B2), não a redação de log', () => {
    expect(RESTRICTED_CLINICAL_COLUMNS.test('address_type')).toBe(false);
  });

  it('quando a query falha E o ROLLBACK também falha, o erro original é o que sobe (o catch do ROLLBACK engole o segundo)', async () => {
    const client = { query: jest.fn().mockRejectedValue(new Error('conexão caiu')), release: jest.fn() };
    const svc = new ReadonlyDbQueryService({ connect: jest.fn().mockResolvedValue(client) } as unknown as Pool);
    await expect(svc.run('SELECT id FROM patients')).rejects.toThrow('conexão caiu');
    expect(client.release).toHaveBeenCalled();
  });
});
