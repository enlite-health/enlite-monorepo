import { isRecentLogin, fetchLastLogins, LoginRecord } from '../livenessGuard';

const DIA = 24 * 60 * 60 * 1000;
const AGORA = Date.parse('2026-08-11T12:00:00Z');

describe('isRecentLogin — separa registro velho de pessoa viva', () => {
  it('protege quem logou dentro da janela', () => {
    const logins = new Map([['uid-a', AGORA - 3 * DIA]]);
    expect(isRecentLogin('uid-a', logins, 90, AGORA)).toBe(true);
  });

  it('NÃO protege quem logou fora da janela', () => {
    const logins = new Map([['uid-a', AGORA - 120 * DIA]]);
    expect(isRecentLogin('uid-a', logins, 90, AGORA)).toBe(false);
  });

  it('a borda exata da janela ainda protege', () => {
    const logins = new Map([['uid-a', AGORA - 90 * DIA]]);
    expect(isRecentLogin('uid-a', logins, 90, AGORA)).toBe(true);
  });

  describe('o caso que causou o incidente de 10/08/2026', () => {
    it('uid ausente do mapa = conta NÃO EXISTE = não protegido (os 3.745 órfãos)', () => {
      const logins = new Map<string, number | null>();
      expect(isRecentLogin('uid-orfao-do-import', logins, 90, AGORA)).toBe(false);
    });

    it('conta existe mas nunca logou = não protegido', () => {
      const logins = new Map<string, number | null>([['uid-a', null]]);
      expect(isRecentLogin('uid-a', logins, 90, AGORA)).toBe(false);
    });

    it('worker sem auth_uid = não protegido', () => {
      const logins = new Map([['uid-a', AGORA]]);
      expect(isRecentLogin(null, logins, 90, AGORA)).toBe(false);
    });

    it('PROTEGE o perfil real do incidente: registro de planilha antigo, conta criada e logada dias atrás', () => {
      // worker importado em março, pessoa criou conta em agosto e logou em 04/08
      const logins = new Map([['uid-pessoa-real', Date.parse('2026-08-04T19:57:56Z')]]);
      expect(isRecentLogin('uid-pessoa-real', logins, 90, AGORA)).toBe(true);
      // e continuaria protegida mesmo na janela curta de 30 dias
      expect(isRecentLogin('uid-pessoa-real', logins, 30, AGORA)).toBe(true);
    });
  });
});

describe('fetchLastLogins', () => {
  it('quebra os uids em lotes e junta os resultados', async () => {
    const uids = Array.from({ length: 250 }, (_, i) => `uid-${i}`);
    const lotes: number[] = [];
    const getUsers = async (batch: string[]): Promise<LoginRecord[]> => {
      lotes.push(batch.length);
      return batch.map((uid) => ({ uid, lastLoginAtMs: AGORA }));
    };
    const map = await fetchLastLogins(uids, getUsers, 100);
    expect(lotes).toEqual([100, 100, 50]);
    expect(map.size).toBe(250);
  });

  it('uid que não volta fica FORA do mapa (não vira null silencioso)', async () => {
    const getUsers = async (batch: string[]): Promise<LoginRecord[]> =>
      batch.filter((u) => u === 'existe').map((uid) => ({ uid, lastLoginAtMs: AGORA }));
    const map = await fetchLastLogins(['existe', 'nao-existe'], getUsers);
    expect(map.has('existe')).toBe(true);
    expect(map.has('nao-existe')).toBe(false);
  });

  it('FALHA FECHADA: erro na consulta propaga em vez de devolver mapa vazio', async () => {
    // Mapa vazio significaria "ninguém está vivo" e o chamador arquivaria todos —
    // o acidente que este guard existe para impedir.
    const getUsers = async (): Promise<LoginRecord[]> => {
      throw new Error('Identity Platform indisponível');
    };
    await expect(fetchLastLogins(['uid-a'], getUsers)).rejects.toThrow('Identity Platform indisponível');
  });
});
