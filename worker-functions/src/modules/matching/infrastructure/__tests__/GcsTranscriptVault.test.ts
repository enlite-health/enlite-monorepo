/**
 * GcsTranscriptVault — o cofre só cria (spec 049 F6, A6-7 e A6-10). Esta unidade prova a PORTA: as opções passadas ao SDK do
 * Storage (`ifGenerationMatch: 0`) e o tratamento do 412. A prova contra o servidor (emulador) está no e2e `admission-049-import`.
 */
import type { Storage } from '@google-cloud/storage';
import { AdmissionRealAdapterInTestError } from '../../application/ports/AdmissionMessagingPorts';
import { TranscriptVaultError } from '../../application/ports/AdmissionImportPorts';
import { GcsTranscriptVault } from '../GcsTranscriptVault';

function fakeStorage(save: jest.Mock, apiEndpoint = 'http://localhost:54449', metadata?: { generation: string }): { client: Storage; files: string[] } {
  const files: string[] = [];
  const client = {
    apiEndpoint,
    bucket: (b: string) => ({ file: (name: string) => { files.push(`${b}/${name}`); return { save, metadata }; } }),
  } as unknown as Storage;
  return { client, files };
}
const env = { NODE_ENV: 'test', ADMISSION_TRANSCRIPT_VAULT_BUCKET: 'cofre-teste' } as NodeJS.ProcessEnv;

describe('GcsTranscriptVault', () => {
  it('A6-7: a escrita leva `preconditionOpts: { ifGenerationMatch: 0 }` (só cria, nunca sobrescreve) e o hash vai nos metadados', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const { client, files } = fakeStorage(save, 'http://localhost:54449', { generation: '1760000000000001' });
    const vault = new GcsTranscriptVault({ env, client });

    const r = await vault.putOnce('AR/x/transcricao-h.txt', Buffer.from('texto'), { sha256: 'h' });

    expect(r).toEqual({ outcome: 'created', generation: '1760000000000001' });
    expect(files).toEqual(['cofre-teste/AR/x/transcricao-h.txt']);
    const [body, opts] = save.mock.calls[0];
    expect(body).toEqual(Buffer.from('texto'));
    expect(opts.preconditionOpts).toEqual({ ifGenerationMatch: 0 });
    expect(opts.resumable).toBe(false);
    expect(opts.metadata.metadata).toEqual({ sha256: 'h' });
  });

  it('412 do GCS (o objeto já existe) → `already_exists`, sem lançar', async () => {
    const save = jest.fn().mockRejectedValue(Object.assign(new Error('conditionNotMet'), { code: 412 }));
    const vault = new GcsTranscriptVault({ env, client: fakeStorage(save).client });
    await expect(vault.putOnce('n', Buffer.from('x'), { sha256: 'h' })).resolves.toEqual({ outcome: 'already_exists' });
  });

  it('qualquer outro erro vira `write_failed` — a mensagem do GCS (que traz o nome do objeto) NÃO sobe', async () => {
    const save = jest.fn().mockRejectedValue(Object.assign(new Error('No such object: bucket/AR/segredo/transcricao.txt'), { code: 500 }));
    const vault = new GcsTranscriptVault({ env, client: fakeStorage(save).client });
    const err = await vault.putOnce('n', Buffer.from('x'), { sha256: 'h' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TranscriptVaultError);
    expect((err as TranscriptVaultError).reason).toBe('write_failed');
    expect((err as Error).message).not.toContain('segredo');
  });

  it('sem `ADMISSION_TRANSCRIPT_VAULT_BUCKET` falha na CHAMADA (`not_configured`), não no construtor', async () => {
    const save = jest.fn();
    const vault = new GcsTranscriptVault({ env: { NODE_ENV: 'test' } as NodeJS.ProcessEnv, client: fakeStorage(save).client });
    await expect(vault.putOnce('n', Buffer.from('x'), { sha256: 'h' })).rejects.toMatchObject({ reason: 'not_configured' });
    expect(save).not.toHaveBeenCalled();
  });

  it('A6-10: em NODE_ENV=test o construtor LANÇA sem cliente de emulador — e também com um cliente que aponta para o Google', () => {
    expect(() => new GcsTranscriptVault({ env })).toThrow(AdmissionRealAdapterInTestError);
    expect(() => new GcsTranscriptVault({ env, client: fakeStorage(jest.fn(), 'https://storage.googleapis.com').client })).toThrow(AdmissionRealAdapterInTestError);
    expect(() => new GcsTranscriptVault({ env, client: fakeStorage(jest.fn()).client })).not.toThrow();
  });
});
