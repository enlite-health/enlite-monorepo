/**
 * AnaCareProviderNameRepository — pool mockado na fronteira (`@shared/database/DatabaseConnection`),
 * mesmo molde de `ShiftHoursValidationRepository.test.ts`. Prova: (1) busca em LOTE, sem N+1; (2) o
 * DTO devolvido tem SOMENTE os 3 campos necessários pro nome (condição (b) do lex — minimização de
 * payload, nunca reusar o método que decripta sex/birth_date/document a mais); (3) o filtro de país
 * e merge é responsabilidade da QUERY SQL (WHERE country='AR' AND merged_into_id IS NULL), provado
 * aqui pela FORMA do SQL enviado ao pool — o comportamento real do filtro é e2e/psql manual (fase 1).
 */
const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ query: mockPoolQuery }) }),
  },
}));

import { AnaCareProviderNameRepository } from '../AnaCareProviderNameRepository';

describe('AnaCareProviderNameRepository', () => {
  let repo: AnaCareProviderNameRepository;

  beforeEach(() => {
    mockPoolQuery.mockReset();
    repo = new AnaCareProviderNameRepository();
  });

  describe('findByAnaCareIds', () => {
    it('devolve mapa vazio SEM query quando a lista de ids é vazia', async () => {
      const result = await repo.findByAnaCareIds([]);
      expect(result.size).toBe(0);
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    it('1 query só para N ids (batch, sem N+1)', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      await repo.findByAnaCareIds(['90200', '90201', '90202']);
      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockPoolQuery.mock.calls[0];
      expect(params).toEqual([['90200', '90201', '90202']]);
      expect(sql).toMatch(/ANY\(\$1::text\[\]\)/);
    });

    it("a query filtra country = 'AR' e merged_into_id IS NULL", async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      await repo.findByAnaCareIds(['90200']);
      const [sql] = mockPoolQuery.mock.calls[0];
      expect(sql).toMatch(/country\s*=\s*'AR'/);
      expect(sql).toMatch(/merged_into_id IS NULL/);
    });

    it('o DTO devolvido tem SOMENTE os 3 campos (id, firstNameEncrypted, lastNameEncrypted) — minimização de payload (condição b do lex)', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [
          {
            ana_care_id: '90200',
            id: 'worker-1',
            first_name_encrypted: 'cifra-first',
            last_name_encrypted: 'cifra-last',
            // Se o SELECT algum dia vazar sex/birth_date/document, este teste NÃO pegaria — a
            // prova real de minimização é a FORMA do SELECT, checada no teste seguinte.
          },
        ],
      });
      const result = await repo.findByAnaCareIds(['90200']);
      const dto = result.get('90200')!;
      expect(Object.keys(dto).sort()).toEqual(['firstNameEncrypted', 'id', 'lastNameEncrypted']);
      expect(dto).toEqual({ id: 'worker-1', firstNameEncrypted: 'cifra-first', lastNameEncrypted: 'cifra-last' });
    });

    it('o SELECT só pede as colunas do nome — nunca sex/birth_date/document (condição b do lex)', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      await repo.findByAnaCareIds(['90200']);
      const [sql] = mockPoolQuery.mock.calls[0];
      expect(sql).toMatch(/first_name_encrypted/);
      expect(sql).toMatch(/last_name_encrypted/);
      expect(sql).not.toMatch(/sex_encrypted|birth_date_encrypted|document_number_encrypted/);
    });

    it('sem match no banco, devolve mapa vazio (ana_care_id ausente)', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      const result = await repo.findByAnaCareIds(['nao-existe']);
      expect(result.size).toBe(0);
    });
  });
});
