/**
 * PatientAddressAuditRepository — trilha da remoção de Localización (spec 044, A9/A10).
 * Endereços de ficção. A prova de que o texto não vaza: a linha de origem TRAZ o texto e o `changes` não.
 */
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('@shared/logging', () => ({ logger: { ...mockLogger, child: () => mockLogger }, reportError: jest.fn() }));

import type { PoolClient } from 'pg';
import { PatientAddressAuditRepository, buildAddressDeletedChanges } from '../PatientAddressAuditRepository';

const TEXTO_SEMEADO = 'Calle Falsa 123, Ciudad Ficticia';

describe('buildAddressDeletedChanges (A10: lista POSITIVA de chaves)', () => {
  const linhaCompleta = {
    id: 'addr-1',
    address_type: 'casa_madre',
    neighborhood: 'Barrio Ficticio',
    address_formatted: TEXTO_SEMEADO,
    address_raw: TEXTO_SEMEADO,
    complement: 'Depto 2B',
    access_notes: 'portero de 8 a 12',
    lat: -34.6,
    lng: -58.4,
    coluna_nova_do_futuro: 'x',
  };

  it('copia só address_id, address_type e neighborhood; after é null', () => {
    const changes = buildAddressDeletedChanges(linhaCompleta);
    expect(changes).toEqual({
      before: { address_id: 'addr-1', address_type: 'casa_madre', neighborhood: 'Barrio Ficticio' },
      after: null,
    });
  });

  it('nenhuma chave de texto de endereço e nenhum valor igual ao texto semeado (nem coluna nova entra por omissão)', () => {
    const json = JSON.stringify(buildAddressDeletedChanges(linhaCompleta));
    const before = (buildAddressDeletedChanges(linhaCompleta).before as Record<string, unknown>);
    expect(Object.keys(before).sort()).toEqual(['address_id', 'address_type', 'neighborhood']);
    expect(json).not.toContain('address_formatted');
    expect(json).not.toContain('address_raw');
    expect(json).not.toContain(TEXTO_SEMEADO);
    expect(json).not.toContain('coluna_nova_do_futuro');
  });

  it('tipo e bairro ausentes viram null (nunca undefined)', () => {
    expect(buildAddressDeletedChanges({ id: 'addr-2' })).toEqual({
      before: { address_id: 'addr-2', address_type: null, neighborhood: null },
      after: null,
    });
  });
});

describe('PatientAddressAuditRepository.logDeleted (A9)', () => {
  it('INSERT em patient_address_audit_log: DELETED, ator HUMAN, patient_id e changes sem texto', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const client = { query } as unknown as PoolClient;
    const changes = buildAddressDeletedChanges({ id: 'addr-1', address_type: 'otro', neighborhood: 'Barrio Ficticio' });

    await new PatientAddressAuditRepository().logDeleted(client, {
      patientId: 'pat-1', changes, actorUserId: 'uid-1', traceId: 'trace-1',
    });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO patient_address_audit_log');
    expect(sql).toContain('patient_id');
    expect(values).toEqual(['pat-1', 'DELETED', null, JSON.stringify(changes), 'uid-1', 'HUMAN', null, 'trace-1']);
  });

  it('sem traceId grava null; falha do INSERT PROPAGA (a transação do DELETE desfaz — nada de logEventSafe)', async () => {
    const query = jest.fn().mockRejectedValue(new Error('insert falhou'));
    const client = { query } as unknown as PoolClient;
    await expect(
      new PatientAddressAuditRepository().logDeleted(client, {
        patientId: 'pat-1', changes: buildAddressDeletedChanges({ id: 'a' }), actorUserId: null,
      }),
    ).rejects.toThrow('insert falhou');
    expect(query.mock.calls[0][1]).toEqual(['pat-1', 'DELETED', null, expect.any(String), null, 'HUMAN', null, null]);
  });
});
