/**
 * IcdCatalogTerminology — Adapter (GoF) que traduz `terminology.icd_entities`/`icd_releases`
 * (Postgres) para a `TerminologyPort`. Unit test com pool MOCADO (CLAUDE.md do projeto: "mock só
 * em unitário" — o teste de integração real, sem mock, está em
 * tests/e2e/terminology-port-contract.e2e.test.ts).
 *
 * 🔴 Prova de perímetro: este adaptador NUNCA faz HTTP. `icd_uri` é identificador, não endereço
 * — o teste espiona `global.fetch` e prova zero chamadas em qualquer método.
 *
 * 🔧 F1-CORREÇÕES (D2/D3/D4/D6/D7/D8): `search()` agora resolve o release CORRENTE via
 * `pool.query` ANTES de tudo (D2/D3), e roda a query principal numa transação dedicada
 * (`pool.connect()` → BEGIN/SET LOCAL/COMMIT) para setar `pg_trgm.word_similarity_threshold`
 * por sessão (D6) — o mock de pool ganha `connect()` além de `query()`.
 */
const mockQuery = jest.fn();
const mockClientQuery = jest.fn(async (sql: string, _params?: unknown[]) => {
  // BEGIN/SET LOCAL/COMMIT/ROLLBACK não carregam linhas — só a query principal (SELECT) importa
  // para o teste; o default abaixo cobre os comandos de controle de transação.
  if (/^\s*SELECT/i.test(sql)) return mockClientSelectResult();
  return { rows: [] };
});
let mockClientSelectResult = (): { rows: unknown[] } => ({ rows: [] });
const mockRelease = jest.fn();
const mockConnect = jest.fn().mockResolvedValue({ query: mockClientQuery, release: mockRelease });

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: mockQuery, connect: mockConnect }),
    }),
  },
}));

import { IcdCatalogTerminology } from '../IcdCatalogTerminology';
import { TerminologyUnavailableError } from '../../domain/UnavailableTerminology';

const CURRENT_RELEASE_ROW = { rows: [{ release: '2026-01' }] };
const NO_CURRENT_RELEASE_ROW = { rows: [] };

describe('IcdCatalogTerminology', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClientSelectResult = () => ({ rows: [] });
    fetchSpy = jest.spyOn(global, 'fetch' as never);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('resolução do release corrente (D2/D3)', () => {
    it('search() consulta `icd_releases WHERE is_current` antes da busca principal', async () => {
      mockQuery.mockResolvedValueOnce(CURRENT_RELEASE_ROW);
      mockClientSelectResult = () => ({ rows: [] });
      await new IcdCatalogTerminology().search('autismo');

      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toMatch(/icd_releases/);
      expect(sql).toMatch(/is_current/);
    });

    it('D3 — nenhum release corrente (tabela vazia ou nunca promovido) → TerminologyUnavailableError, NUNCA []', async () => {
      mockQuery.mockResolvedValueOnce(NO_CURRENT_RELEASE_ROW);
      await expect(new IcdCatalogTerminology().search('autismo')).rejects.toBeInstanceOf(TerminologyUnavailableError);
      expect(mockConnect).not.toHaveBeenCalled(); // nunca chega a abrir a query principal
    });

    it('D3 — schema/tabela do catálogo ausente (erro Postgres 42P01) → TerminologyUnavailableError, nunca erro cru', async () => {
      const pgError = Object.assign(new Error('relation "terminology.icd_releases" does not exist'), { code: '42P01' });
      mockQuery.mockRejectedValueOnce(pgError);
      await expect(new IcdCatalogTerminology().search('autismo')).rejects.toBeInstanceOf(TerminologyUnavailableError);
    });

    it('D3 — erro de infraestrutura genérico também vira TerminologyUnavailableError (nunca erro cru do driver)', async () => {
      mockQuery.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await expect(new IcdCatalogTerminology().search('autismo')).rejects.toBeInstanceOf(TerminologyUnavailableError);
    });

    it('getByUri() e ancestorsOf() também resolvem o release corrente antes de consultar', async () => {
      mockQuery.mockResolvedValueOnce(NO_CURRENT_RELEASE_ROW);
      await expect(new IcdCatalogTerminology().getByUri('uri-x')).rejects.toBeInstanceOf(TerminologyUnavailableError);

      mockQuery.mockResolvedValueOnce(NO_CURRENT_RELEASE_ROW);
      await expect(new IcdCatalogTerminology().ancestorsOf('uri-x')).rejects.toBeInstanceOf(TerminologyUnavailableError);
    });
  });

  describe('search', () => {
    it('D6 — usa o operador indexável `%>` (não `word_similarity(...) >= limiar`), exclui extension por padrão, mapeia code para IcdCode', async () => {
      mockQuery.mockResolvedValueOnce(CURRENT_RELEASE_ROW);
      mockClientSelectResult = () => ({
        rows: [{ icd_uri: 'uri-1', code: '6A20', title_es: 'Esquizofrenia', title_en: 'Schizophrenia', chapter: '06' }],
      });
      const repo = new IcdCatalogTerminology();
      const out = await repo.search('esquisofrenia');

      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ uri: 'uri-1', title: 'Esquizofrenia', chapter: '06' });
      expect(out[0].code.value).toBe('6A20');

      const mainCall = mockClientQuery.mock.calls.find((c) => /^\s*SELECT/i.test(c[0] as string))!;
      const sql = mainCall[0] as string;
      const params = mainCall[1] as unknown[];
      expect(sql).toMatch(/%>/);
      expect(sql).not.toMatch(/word_similarity\([^)]*\)\s*>=/);
      expect(sql).toMatch(/terminology\.icd_entities/);
      expect(sql).toMatch(/kind\s*(<>|!=)\s*'extension'/);
      expect(sql).toMatch(/release\s*=\s*\$2/);
      expect(params[0]).toBe('esquisofrenia');
      expect(params[1]).toBe('2026-01');
    });

    it('D6 — roda a query principal numa transação dedicada (BEGIN / SET LOCAL threshold / COMMIT) e libera a conexão', async () => {
      mockQuery.mockResolvedValueOnce(CURRENT_RELEASE_ROW);
      await new IcdCatalogTerminology().search('autismo');

      expect(mockConnect).toHaveBeenCalledTimes(1);
      const calls = mockClientQuery.mock.calls.map(([sql]) => sql as string);
      expect(calls[0]).toMatch(/^BEGIN/);
      expect(calls[1]).toMatch(/SET LOCAL pg_trgm\.word_similarity_threshold\s*=\s*0\.3/);
      expect(calls[calls.length - 1]).toMatch(/^COMMIT/);
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('D6 — em erro na query principal, dá ROLLBACK e ainda assim libera a conexão', async () => {
      mockQuery.mockResolvedValueOnce(CURRENT_RELEASE_ROW);
      const boom = new Error('boom');
      mockClientQuery.mockImplementationOnce(async () => ({ rows: [] })); // BEGIN
      mockClientQuery.mockImplementationOnce(async () => ({ rows: [] })); // SET LOCAL
      mockClientQuery.mockImplementationOnce(async () => {
        throw boom;
      }); // SELECT falha
      mockClientQuery.mockImplementationOnce(async () => ({ rows: [] })); // ROLLBACK

      await expect(new IcdCatalogTerminology().search('autismo')).rejects.toThrow(boom);
      expect(mockClientQuery.mock.calls[3][0]).toMatch(/^ROLLBACK/);
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it('D4 — consulta com menos de 2 caracteres devolve [] SEM ir ao banco (nem resolve release, nem conecta)', async () => {
      const repo = new IcdCatalogTerminology();
      expect(await repo.search('')).toEqual([]);
      expect(await repo.search(' ')).toEqual([]);
      expect(await repo.search('a')).toEqual([]);
      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockConnect).not.toHaveBeenCalled();
    });

    it('D4 — % e _ do usuário são escapados no ILIKE (não viram curinga)', async () => {
      mockQuery.mockResolvedValueOnce(CURRENT_RELEASE_ROW);
      await new IcdCatalogTerminology().search('50%_off');

      const mainCall = mockClientQuery.mock.calls.find((c) => /^\s*SELECT/i.test(c[0] as string))!;
      const params = mainCall[1] as unknown[];
      // params: [trimmed (p/ %>), release, escapado (p/ ILIKE), ...]
      expect(params[0]).toBe('50%_off'); // trigram usa o valor cru
      expect(params[2]).toBe('50\\%\\_off'); // ILIKE usa o valor escapado
    });

    it('filtra por capítulos quando `chapters` é passado', async () => {
      mockQuery.mockResolvedValueOnce(CURRENT_RELEASE_ROW);
      await new IcdCatalogTerminology().search('autismo', { chapters: ['06', '08'] });

      const mainCall = mockClientQuery.mock.calls.find((c) => /^\s*SELECT/i.test(c[0] as string))!;
      const sql = mainCall[0] as string;
      const params = mainCall[1] as unknown[];
      expect(sql).toMatch(/chapter\s*=\s*ANY/);
      expect(params).toContainEqual(['06', '08']);
    });

    it('inclui extension quando includeExtensions=true', async () => {
      mockQuery.mockResolvedValueOnce(CURRENT_RELEASE_ROW);
      await new IcdCatalogTerminology().search('x-teste', { includeExtensions: true });

      const mainCall = mockClientQuery.mock.calls.find((c) => /^\s*SELECT/i.test(c[0] as string))!;
      const sql = mainCall[0] as string;
      expect(sql).not.toMatch(/kind\s*(<>|!=)\s*'extension'/);
    });

    it('lang=en prefere title_en; cai para title_es quando title_en falta', async () => {
      mockQuery.mockResolvedValueOnce(CURRENT_RELEASE_ROW);
      mockClientSelectResult = () => ({ rows: [{ icd_uri: 'u', code: '06', title_es: 'Título ES', title_en: null, chapter: '06' }] });
      const repo = new IcdCatalogTerminology();
      const [candidate] = await repo.search('teste', { lang: 'en' });
      expect(candidate.title).toBe('Título ES');
    });

    it('D8 — respeita `limit` explícito dentro do teto', async () => {
      mockQuery.mockResolvedValueOnce(CURRENT_RELEASE_ROW);
      await new IcdCatalogTerminology().search('teste', { limit: 5 });
      const mainCall = mockClientQuery.mock.calls.find((c) => /^\s*SELECT/i.test(c[0] as string))!;
      const params = mainCall[1] as unknown[];
      expect(params).toContain(5);
    });

    it('D8 — `limit` acima do teto é CLAMPADO a 200, nunca passa cru para o SQL', async () => {
      mockQuery.mockResolvedValueOnce(CURRENT_RELEASE_ROW);
      await new IcdCatalogTerminology().search('teste', { limit: 100000 });
      const mainCall = mockClientQuery.mock.calls.find((c) => /^\s*SELECT/i.test(c[0] as string))!;
      const params = mainCall[1] as unknown[];
      expect(params).toContain(200);
      expect(params).not.toContain(100000);
    });

    it('título vazio quando as duas colunas vêm nulas — defensivo, nunca lança (o CHECK do banco impede em produção)', async () => {
      mockQuery.mockResolvedValueOnce(CURRENT_RELEASE_ROW);
      mockClientSelectResult = () => ({ rows: [{ icd_uri: 'u', code: '06', title_es: null, title_en: null, chapter: '06' }] });
      const [candidate] = await new IcdCatalogTerminology().search('teste');
      expect(candidate.title).toBe('');
    });

    it('nunca chama fetch/HTTP — busca é só SQL', async () => {
      mockQuery.mockResolvedValueOnce(CURRENT_RELEASE_ROW);
      await new IcdCatalogTerminology().search('teste');
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('getByUri', () => {
    it('D2 — filtra pelo release corrente, e mapeia code para IcdCode (D7)', async () => {
      mockQuery
        .mockResolvedValueOnce(CURRENT_RELEASE_ROW)
        .mockResolvedValueOnce({
          rows: [{
            icd_uri: 'http://id.who.int/icd/release/11/2026-01/mms/437815624/unspecified',
            code: '6A02.Z',
            title_es: 'Trastorno del espectro autista, sin especificación',
            title_en: 'Autism spectrum disorder, unspecified',
            chapter: '06',
            release: '2026-01',
            kind: 'stem',
            is_leaf: true,
            parent_uri: 'http://id.who.int/icd/release/11/2026-01/mms/437815624',
          }],
        });
      const repo = new IcdCatalogTerminology();
      const entity = await repo.getByUri('http://id.who.int/icd/release/11/2026-01/mms/437815624/unspecified');

      expect(entity?.code.value).toBe('6A02.Z');
      expect(entity).toMatchObject({
        uri: 'http://id.who.int/icd/release/11/2026-01/mms/437815624/unspecified',
        titleEs: 'Trastorno del espectro autista, sin especificación',
        titleEn: 'Autism spectrum disorder, unspecified',
        chapter: '06',
        release: '2026-01',
        kind: 'stem',
        isLeaf: true,
        parentUri: 'http://id.who.int/icd/release/11/2026-01/mms/437815624',
      });

      const [sql, params] = mockQuery.mock.calls[1];
      expect(sql).toMatch(/release\s*=\s*\$2/);
      expect(params[1]).toBe('2026-01');
    });

    it('devolve null quando a linha não existe — nunca lança, nunca chama HTTP', async () => {
      mockQuery.mockResolvedValueOnce(CURRENT_RELEASE_ROW).mockResolvedValueOnce({ rows: [] });
      const entity = await new IcdCatalogTerminology().getByUri('inexistente');
      expect(entity).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('ancestorsOf', () => {
    it('resolve o capítulo com uma 2ª query pelo código de capítulo da entidade, filtrando por release', async () => {
      mockQuery
        .mockResolvedValueOnce(CURRENT_RELEASE_ROW)
        .mockResolvedValueOnce({ rows: [{ chapter: '06' }] })
        .mockResolvedValueOnce({ rows: [{ code: '06', title_es: 'Trastornos mentales...', title_en: 'Mental disorders' }] });

      const entity = await new IcdCatalogTerminology().ancestorsOf('uri-x');
      expect(entity).toEqual({ chapter: { code: '06', title: 'Trastornos mentales...' } });
      expect(mockQuery).toHaveBeenCalledTimes(3);
      const [, lastParams] = mockQuery.mock.calls[2];
      expect(lastParams[1]).toBe('2026-01');
    });

    it('block fica undefined (blocos da OMS não têm código próprio — limite conhecido, ver migration 323)', async () => {
      mockQuery
        .mockResolvedValueOnce(CURRENT_RELEASE_ROW)
        .mockResolvedValueOnce({ rows: [{ chapter: '08' }] })
        .mockResolvedValueOnce({ rows: [{ code: '08', title_es: 'Enfermedades del sistema nervioso', title_en: null }] });

      const { block } = await new IcdCatalogTerminology().ancestorsOf('uri-y');
      expect(block).toBeUndefined();
    });

    it('lança TerminologyEntityNotFoundError quando a uri não existe', async () => {
      mockQuery.mockResolvedValueOnce(CURRENT_RELEASE_ROW).mockResolvedValueOnce({ rows: [] });
      await expect(new IcdCatalogTerminology().ancestorsOf('inexistente')).rejects.toThrow();
    });

    it('lança quando a entidade existe mas o capítulo dela não está no catálogo (integridade)', async () => {
      mockQuery
        .mockResolvedValueOnce(CURRENT_RELEASE_ROW)
        .mockResolvedValueOnce({ rows: [{ chapter: 'ZZ' }] })
        .mockResolvedValueOnce({ rows: [] }); // capítulo 'ZZ' não tem linha kind='chapter'
      await expect(new IcdCatalogTerminology().ancestorsOf('uri-z')).rejects.toThrow();
    });
  });
});
