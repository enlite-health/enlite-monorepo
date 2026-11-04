/**
 * InterviewHostRepository.test.ts
 *
 * A ordem por e-mail não é estética: é o desempate determinístico da
 * atribuição. Se ela depender da ordem física das linhas no Postgres, duas
 * execuções idênticas podem escolher atendentes diferentes — que é justamente
 * o que o spec proíbe.
 *
 * Spec 055: a leitura é por país (lista), por FLUXO (interruptor) e por usuário staff ATIVO (JOIN, nunca LEFT JOIN);
 * só a listagem da tela usa LEFT JOIN, para a linha sem usuário aparecer.
 */

const mockQuery = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: mockQuery }),
    }),
  },
}));

import { InterviewHostRepository, interviewHostRepository } from '../InterviewHostRepository';

describe('InterviewHostRepository', () => {
  const repo = new InterviewHostRepository();

  beforeEach(() => jest.clearAllMocks());

  describe('leitura de agendamento', () => {
    it('pede só as ativas cujo país está na lista, ordenadas por e-mail', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await repo.listActiveByCountry('BR', 'admission');

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('FROM interview_hosts h');
      expect(sql).toContain('$1 = ANY(h.countries)');
      expect(sql).toContain('h.active = true');
      expect(sql).toContain('ORDER BY h.email ASC');
      expect(params).toEqual(['BR']);
    });

    it('filtra pelo interruptor do FLUXO: admissão lê does_admission, enquadre lê does_enquadre', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await repo.listActiveByCountry('AR', 'admission');
      await repo.listActiveWithIdByCountry('AR', 'enquadre');

      const admissionSql: string = mockQuery.mock.calls[0][0];
      const enquadreSql: string = mockQuery.mock.calls[1][0];
      expect(admissionSql).toContain('h.does_admission = true');
      expect(admissionSql).not.toContain('does_enquadre');
      expect(enquadreSql).toContain('h.does_enquadre = true');
      expect(enquadreSql).not.toContain('does_admission');
    });

    it('cruza com usuário staff ATIVO por JOIN (linha sem usuário ou desativado não entra)', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      await repo.listActiveByCountry('AR', 'enquadre');
      await repo.listActiveWithIdByCountry('AR', 'admission');

      for (const [sql] of mockQuery.mock.calls) {
        expect(sql).toMatch(/\bJOIN users u ON u\.firebase_uid = h\.user_uid/);
        expect(sql).not.toMatch(/LEFT\s+JOIN/i);
        expect(sql).toContain("u.account_type = 'staff'");
        expect(sql).toContain('u.is_active = true');
      }
    });

    it('traduz a linha do banco para o domínio', async () => {
      mockQuery.mockResolvedValue({
        rows: [
          { email: 'ana@enlite.health', display_name: 'Ana Joulie' },
          { email: 'mari@enlite.health', display_name: null },
        ],
      });

      await expect(repo.listActiveByCountry('AR', 'admission')).resolves.toEqual([
        { email: 'ana@enlite.health', displayName: 'Ana Joulie' },
        { email: 'mari@enlite.health', displayName: null },
      ]);
    });

    it('com id: devolve o id da linha', async () => {
      mockQuery.mockResolvedValue({ rows: [{ id: 'h1', email: 'a@enlite.health', display_name: 'A' }] });
      await expect(repo.listActiveWithIdByCountry('AR', 'enquadre')).resolves.toEqual([
        { id: 'h1', email: 'a@enlite.health', displayName: 'A' },
      ]);
    });

    it('país sem atendente → lista vazia, não erro', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await expect(repo.listActiveByCountry('BR', 'admission')).resolves.toEqual([]);
    });
  });

  describe('listagem da tela', () => {
    it('usa LEFT JOIN e marca userMissing (sem usuário) e userInactive (usuário desativado)', async () => {
      mockQuery.mockResolvedValue({
        rows: [
          { id: 'h1', email: 'ok@enlite.health', user_uid: 'u1', countries: ['AR'], does_enquadre: true, does_admission: false, active: true, display_name: 'Ok Antigo', u_name: 'Ok Novo', u_uid: 'u1', u_ok: true },
          { id: 'h2', email: 'anajoulie@enlite.health', user_uid: null, countries: ['BR'], does_enquadre: true, does_admission: true, active: true, display_name: 'Ana Joulie', u_name: null, u_uid: null, u_ok: null },
          { id: 'h3', email: 'off@enlite.health', user_uid: 'u3', countries: ['AR', 'BR'], does_enquadre: true, does_admission: true, active: true, display_name: null, u_name: 'Off', u_uid: 'u3', u_ok: false },
        ],
      });

      const rows = await repo.listAdmin();

      expect(mockQuery.mock.calls[0][0]).toMatch(/LEFT\s+JOIN users u/);
      expect(rows[0]).toMatchObject({ displayName: 'Ok Novo', userMissing: false, userInactive: false, doesAdmission: false });
      expect(rows[1]).toMatchObject({ displayName: 'Ana Joulie', userUid: null, userMissing: true, userInactive: false });
      expect(rows[2]).toMatchObject({ countries: ['AR', 'BR'], userMissing: false, userInactive: true });
    });
  });

  describe('escritas', () => {
    it('insert grava country = 1º país da lista e o e-mail em minúsculas', async () => {
      mockQuery.mockResolvedValue({ rows: [{ id: 'new' }] });
      const id = await repo.insert(
        { uid: 'u1', email: 'Flor@Enlite.health', displayName: 'Flor' },
        { countries: ['BR', 'AR'], doesEnquadre: true, doesAdmission: false, active: true, updatedBy: 'admin' },
        { query: mockQuery },
      );
      expect(id).toBe('new');
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('lower($1)');
      expect(params).toEqual(['Flor@Enlite.health', 'Flor', 'BR', ['BR', 'AR'], 'u1', true, false, true, 'admin']);
    });

    it('a busca de candidatos escapa curinga e exclui staff inativo e quem já está na lista', async () => {
      mockQuery.mockResolvedValue({ rows: [{ firebase_uid: 'u1', display_name: 'Flor', email: 'f@enlite.health' }] });
      const found = await repo.searchCandidates('50%_');
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain("u.account_type = 'staff' AND u.is_active = true");
      expect(sql).toContain('NOT EXISTS');
      expect(sql).toContain('LIMIT 20');
      expect(params).toEqual(['%50\\%\\_%']);
      expect(found).toEqual([{ uid: 'u1', displayName: 'Flor', email: 'f@enlite.health' }]);
    });
  });

  it('exporta um singleton pronto para uso', () => {
    expect(interviewHostRepository).toBeInstanceOf(InterviewHostRepository);
  });
});
