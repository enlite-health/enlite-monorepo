import { ConcurrencyConflictError, withSerializationRetry } from '../withSerializationRetry';

const pgError = (code: string): Error & { code: string } => Object.assign(new Error(`pg ${code}`), { code });

describe('withSerializationRetry', () => {
  it('3 tentativas em 40001/40P01: recupera na 3ª e, esgotadas, lança 409 (ConcurrencyConflictError)', async () => {
    let chamadas = 0;
    const recupera = jest.fn(async () => {
      chamadas++;
      if (chamadas === 1) throw pgError('40001');
      if (chamadas === 2) throw pgError('40P01');
      return 'ok';
    });
    await expect(withSerializationRetry(recupera)).resolves.toBe('ok');
    expect(recupera).toHaveBeenCalledTimes(3);

    const sempre = jest.fn(async () => { throw pgError('40P01'); });
    const e = await withSerializationRetry(sempre).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ConcurrencyConflictError);
    expect((e as ConcurrencyConflictError).httpStatus).toBe(409);
    expect((e as ConcurrencyConflictError).sqlState).toBe('40P01');
    expect(sempre).toHaveBeenCalledTimes(3);
  });

  it('sucesso na 1ª tentativa não repete', async () => {
    const fn = jest.fn(async () => 7);
    await expect(withSerializationRetry(fn)).resolves.toBe(7);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('erro de outro código (23505) e erro sem código passam direto, sem repetir', async () => {
    const dup = jest.fn(async () => { throw pgError('23505'); });
    await expect(withSerializationRetry(dup)).rejects.toMatchObject({ code: '23505' });
    expect(dup).toHaveBeenCalledTimes(1);
    const cru = jest.fn(async () => { throw new Error('boom'); });
    await expect(withSerializationRetry(cru)).rejects.toThrow('boom');
    expect(cru).toHaveBeenCalledTimes(1);
  });
});
