/**
 * workerDisplayNames — a projeção do nome do prestador numa fonte só (Fase 12, P6). Os ids são
 * sintéticos; o "nome" é o próprio texto cifrado de mentira sem o prefixo `enc:`.
 */
import { projectWorkerDisplayNames, type WorkerNameSource } from '../workerDisplayNames';
import { CELL_WORKER_CONTACT_READ, NOME_REDIGIDO, type Decryptor } from '@modules/identity/permissions';

function kmsSpy(): { kms: Decryptor; decrypt: jest.Mock } {
  const decrypt = jest.fn(async (c?: string | null) => String(c ?? '').replace(/^enc:/, ''));
  return { kms: { decrypt }, decrypt };
}

function fontes(): Map<string, WorkerNameSource> {
  return new Map<string, WorkerNameSource>([
    ['w-1', { firstNameEncrypted: 'enc:Uno', lastNameEncrypted: 'enc:Qa' }],
    ['w-2', { firstNameEncrypted: 'enc:Dos', lastNameEncrypted: null }],
  ]);
}

describe('projectWorkerDisplayNames', () => {
  it('cells sem worker_contact:read → null para todos e 0 chamadas ao KMS', async () => {
    const { kms, decrypt } = kmsSpy();
    const result = await projectWorkerDisplayNames(fontes(), ['worker:read'], kms);
    console.log('[12.P6]', 'sem-celula', result.size, decrypt.mock.calls.length);
    expect(decrypt).toHaveBeenCalledTimes(0);
    expect([...result.entries()]).toEqual([
      ['w-1', null],
      ['w-2', null],
    ]);
  });

  it('com worker_contact:read → primeiro + último decifrados e juntos', async () => {
    const { kms } = kmsSpy();
    const result = await projectWorkerDisplayNames(fontes(), [CELL_WORKER_CONTACT_READ], kms);
    expect(result.get('w-1')).toBe('Uno Qa');
    expect(result.get('w-2')).toBe('Dos');
  });

  it('cells === null (engine OFF) → o nome aparece, como hoje', async () => {
    const { kms } = kmsSpy();
    const result = await projectWorkerDisplayNames(fontes(), null, kms);
    expect(result.get('w-1')).toBe('Uno Qa');
  });

  it('NOME_REDIGIDO nunca sai na resposta → null', async () => {
    const decrypt = jest.fn(async () => NOME_REDIGIDO);
    const result = await projectWorkerDisplayNames(
      new Map([['w-1', { firstNameEncrypted: 'enc:x', lastNameEncrypted: null }]]),
      [CELL_WORKER_CONTACT_READ],
      { decrypt },
    );
    expect(result.get('w-1')).toBeNull();
  });

  it('fonte sem nome cifrado → null', async () => {
    const { kms } = kmsSpy();
    const result = await projectWorkerDisplayNames(
      new Map([['w-1', { firstNameEncrypted: null, lastNameEncrypted: null }]]),
      [CELL_WORKER_CONTACT_READ],
      kms,
    );
    expect(result.get('w-1')).toBeNull();
  });

  it('2 prestadores → os decrypts de ambos começam antes de qualquer um terminar (paralelo), 1 fonte por prestador', async () => {
    const pendentes: Array<() => void> = [];
    const decrypt = jest.fn(
      (c?: string | null) =>
        new Promise<string>((resolve) => {
          pendentes.push(() => resolve(String(c ?? '').replace(/^enc:/, '')));
        }),
    );
    const soPrimeiroNome = new Map<string, WorkerNameSource>([
      ['w-1', { firstNameEncrypted: 'enc:Uno', lastNameEncrypted: null }],
      ['w-2', { firstNameEncrypted: 'enc:Dos', lastNameEncrypted: null }],
    ]);
    const promessa = projectWorkerDisplayNames(soPrimeiroNome, [CELL_WORKER_CONTACT_READ], { decrypt });
    await Promise.resolve();
    await Promise.resolve();
    // 2 prestadores, 1 campo cifrado cada → 2 decrypts já pedidos sem nenhum resolvido.
    expect(decrypt.mock.calls.map((c) => c[0]).sort()).toEqual(['enc:Dos', 'enc:Uno']);
    pendentes.forEach((resolve) => resolve());
    const result = await promessa;
    expect(result.size).toBe(2);
    expect(result.get('w-2')).toBe('Dos');
  });
});
