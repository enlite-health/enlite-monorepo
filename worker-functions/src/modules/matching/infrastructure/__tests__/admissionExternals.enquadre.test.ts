/**
 * A composição do ENQUADRE na fábrica das fronteiras (spec 052, Fase 3, T-35c): o cofre é a MESMA `GcsTranscriptVault` apontada para
 * `ENQUADRE_TRANSCRIPT_VAULT_BUCKET` (nunca para a env da admissão), e o resumo é o MESMO gerador com o perfil do enquadre. Em `fake`,
 * dublês (nada sai da máquina). O `Storage` do Google é substituído por um espião: o teste nunca toca bucket real.
 */
const buckets: string[] = [];
jest.mock('@google-cloud/storage', () => ({
  Storage: class {
    apiEndpoint = 'https://storage.googleapis.com';
    bucket(name: string) {
      buckets.push(name);
      return { file: () => ({ save: async () => undefined, metadata: { generation: '7' } }) };
    }
  },
}));

import { createAdmissionExternals } from '../admissionExternals';
import { GcsTranscriptVault, ENQUADRE_VAULT_BUCKET_ENV, VAULT_BUCKET_ENV } from '../GcsTranscriptVault';
import { InMemoryTranscriptVault } from '../doubles/InMemoryTranscriptVault';
import { FakeAdmissionSummaryGenerator } from '../doubles/FakeAdmissionSummaryGenerator';
import { VertexAdmissionSummaryGenerator } from '../VertexAdmissionSummaryGenerator';
import { ENQUADRE_SUMMARY_PROFILE } from '../enquadreSummaryProfile';
import { assertEnquadreSummaryShape } from '../../application/enquadreSummaryGate';
import { InMemoryAdmissionReminderTasks } from '../doubles/InMemoryAdmissionReminderTasks';

const realWhatsApp = jest.fn(() => ({ sendWithContentSid: jest.fn() }));
const PROD = { NODE_ENV: 'production' as const };
const real = (extra: Record<string, string>) =>
  createAdmissionExternals({ ...PROD, ...extra } as never, { realWhatsApp, realReminderTasks: () => new InMemoryAdmissionReminderTasks() });

describe('createAdmissionExternals — o enquadre (spec 052, T-35c)', () => {
  beforeEach(() => { buckets.length = 0; });

  it('a env do cofre do enquadre tem o NOME certo e é outra que a da admissão', () => {
    expect(ENQUADRE_VAULT_BUCKET_ENV).toBe('ENQUADRE_TRANSCRIPT_VAULT_BUCKET');
    expect(ENQUADRE_VAULT_BUCKET_ENV).not.toBe(VAULT_BUCKET_ENV);
  });

  it('real: o cofre do enquadre lê ENQUADRE_TRANSCRIPT_VAULT_BUCKET; o da admissão continua em ADMISSION_TRANSCRIPT_VAULT_BUCKET (instâncias distintas da mesma classe)', async () => {
    const ext = real({ ADMISSION_TRANSCRIPT_VAULT_BUCKET: 'bucket-admissao', ENQUADRE_TRANSCRIPT_VAULT_BUCKET: 'bucket-enquadre' });
    expect(ext.enquadreVault).toBeInstanceOf(GcsTranscriptVault);
    expect(ext.enquadreVault).not.toBe(ext.vault);
    await ext.enquadreVault.putOnce('AR/enquadre/x/transcricao-a.txt', Buffer.from('x'), { sha256: 'a' });
    expect(buckets).toEqual(['bucket-enquadre']); // VERMELHO se alguém apontar o cofre do enquadre para a env da admissão
    await ext.vault.putOnce('AR/y/transcricao-b.txt', Buffer.from('x'), { sha256: 'b' });
    expect(buckets).toEqual(['bucket-enquadre', 'bucket-admissao']);
  });

  it('real: sem a env do enquadre, ou com ela IGUAL à da admissão, o cofre do enquadre NÃO grava (not_configured) — nunca cai no cofre errado', async () => {
    const sem = real({ ADMISSION_TRANSCRIPT_VAULT_BUCKET: 'bucket-admissao' });
    await expect(sem.enquadreVault.putOnce('n', Buffer.from('x'), { sha256: 'a' })).rejects.toMatchObject({ reason: 'not_configured' });
    const igual = real({ ADMISSION_TRANSCRIPT_VAULT_BUCKET: 'mesmo', ENQUADRE_TRANSCRIPT_VAULT_BUCKET: 'mesmo' });
    await expect(igual.enquadreVault.putOnce('n', Buffer.from('x'), { sha256: 'a' })).rejects.toMatchObject({ reason: 'not_configured' });
    expect(buckets).toEqual([]);
  });

  it('real: o resumo do enquadre é o MESMO gerador (classe única) com o gate do enquadre; o da admissão fica com o da admissão', () => {
    const ext = real({});
    expect(ext.enquadreSummary).toBeInstanceOf(VertexAdmissionSummaryGenerator);
    expect(ext.summary).toBeInstanceOf(VertexAdmissionSummaryGenerator);
    expect(ext.enquadreSummary).not.toBe(ext.summary);
    expect(ext.enquadreSummary.assertShape).toBe(ENQUADRE_SUMMARY_PROFILE.assertShape);
    expect(ext.summary.assertShape).not.toBe(ENQUADRE_SUMMARY_PROFILE.assertShape);
  });

  it('fake (NODE_ENV=test e ADMISSION_EXTERNALS=fake): dublês, cada um com o seu gate; nada real é construído', () => {
    for (const env of [{ NODE_ENV: 'test' }, { NODE_ENV: 'development', ADMISSION_EXTERNALS: 'fake' }]) {
      const ext = createAdmissionExternals(env, { realWhatsApp });
      expect(ext.mode).toBe('fake');
      expect(ext.enquadreVault).toBeInstanceOf(InMemoryTranscriptVault);
      expect(ext.enquadreVault).not.toBe(ext.vault);
      expect(ext.enquadreSummary).toBeInstanceOf(FakeAdmissionSummaryGenerator);
      expect(ext.enquadreSummary.assertShape).toBe(assertEnquadreSummaryShape);
      expect(ext.summary.assertShape).toBeUndefined(); // o dublê da admissão cai no gate da admissão
    }
  });
});
