import { toSafeError } from '../safeError';

describe('toSafeError', () => {
  it('erro do pg: só code/constraint — nem a mensagem (ecoa valor), nem o detail, nem o cabeçalho da stack', () => {
    const pgErr = Object.assign(new Error('invalid input syntax for type uuid: "maria@x.com"'), {
      code: '22P02', constraint: 'workers_x', detail: 'Key (email)=(maria@x.com) already exists',
    });
    const safe = toSafeError(pgErr);

    expect(safe.message).toBe('db error code=22P02 constraint=workers_x');
    expect(JSON.stringify([safe.message, safe.stack, Object.keys(safe)])).not.toContain('maria@x.com');
    expect(safe.stack).toContain('    at ');
  });

  it('erro nosso (sem code): mantém a 1ª linha da mensagem', () => {
    expect(toSafeError(new Error('falhou aqui\noutra linha')).message).toBe('falhou aqui');
  });
});
