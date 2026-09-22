/**
 * AdminRepository.searchStaffDirectory — R2-B (change 022-ux-mencao-e-notificacao, Rodada 2):
 * `isOnline` calculado no SQL e exclusão do próprio requester. Unit puro (pool mockado) — o
 * comportamento do SQL real (isOnline por janela de 5 min, exclusão funcionando de fato) é
 * coberto pelo e2e `adminStaffDirectory.e2e.test.ts` (Postgres real). Aqui só se prova o
 * CONTRATO: quais parâmetros e em que ordem a query recebe, e que a forma da linha devolvida
 * inclui `isOnline`. Molde: `AdminRepository.isLastManager.test.ts`.
 */
const mockQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: mockQuery }) }) },
}));

import { AdminRepository } from '../AdminRepository';
import { ENLITE_TENANT_ID } from '@modules/identity/permissions';

const PATIENT_ID = 'ee422000-c4a7-0002-0002-000000000002';

describe('AdminRepository.searchStaffDirectory', () => {
  beforeEach(() => mockQuery.mockReset());

  it('q ausente: SQL sem ILIKE, LIMIT e excludeUid como parâmetros ($1, $2)', async () => {
    mockQuery.mockResolvedValue({ rows: [{ uid: 'u1', displayName: 'Ana', isOnline: true }] });
    const rows = await new AdminRepository().searchStaffDirectory(undefined, 20, 'me-uid');

    expect(rows).toEqual([{ uid: 'u1', displayName: 'Ana', isOnline: true }]);
    const [sql, params] = mockQuery.mock.calls[0];
    const sqlStr = String(sql);
    expect(sqlStr).not.toContain('ILIKE');
    expect(sqlStr).toContain('isOnline');
    expect(sqlStr).toContain("interval '5 minutes'");
    expect(sqlStr).toContain('LEFT JOIN staff_presence');
    // 🔒 Guarda dura (gate revisao-pr, critério 8): se alguém remover a exclusão do PRÓPRIO
    // requester neste ramo (sem `q`), este teste tem de morrer — a cláusula literal
    // `firebase_uid <> $2` é o que impede o requester de aparecer na própria lista de
    // mencionáveis. Provado por sabotagem em cópia (ver relatório da execução): removendo esta
    // linha do `AdminRepository.ts` copiado, este `expect` falha (RED); com o arquivo original,
    // passa (GREEN).
    expect(sqlStr).toContain('firebase_uid <> $2');
    expect(params).toEqual([20, 'me-uid']);
  });

  it('q ausente + sem excludeUid: passa null (não filtra ninguém)', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await new AdminRepository().searchStaffDirectory(undefined, 20);
    expect(mockQuery.mock.calls[0][1]).toEqual([20, null]);
  });

  it('q presente: SQL com ILIKE, params [q escapado, limit, excludeUid]', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await new AdminRepository().searchStaffDirectory('ana', 20, 'me-uid');
    const [sql, params] = mockQuery.mock.calls[0];
    const sqlStr = String(sql);
    expect(sqlStr).toContain('ILIKE');
    expect(sqlStr).toContain('isOnline');
    expect(sqlStr).toContain('LEFT JOIN staff_presence');
    expect(sqlStr).toContain('firebase_uid <> $3');
    expect(params).toEqual(['ana', 20, 'me-uid']);
  });

  it('limit explícito (R2-B "Mostrar todos"): propagado sem alteração', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await new AdminRepository().searchStaffDirectory(undefined, 200, 'me-uid');
    expect(mockQuery.mock.calls[0][1]).toEqual([200, 'me-uid']);
  });

  // ── R3-1 (change 022-ux-mencao-e-notificacao, Rodada 3): patientId filtra por quem TEM, de
  // fato, `patient_conversation:read` (célula) — via `iam.effective_permissions` (MESMA fonte
  // que `PermissionService.resolve` consulta), em SQL, não em loop no Node (sem N+1 por
  // candidato). O recorte de PAÍS (`iam.effective_countries`) é condicional a `enforceCountry`
  // (gate 🔴 do revisao-pr, 22/09) — ver describe('enforceCountry (COUNTRY_RLS_ENABLED)') abaixo.
  describe('patientId (R3-1)', () => {
    it('patientId AUSENTE (q ausente): SQL sem EXISTS/iam.effective_*, params inalterados', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await new AdminRepository().searchStaffDirectory(undefined, 20, 'me-uid');
      const [sql, params] = mockQuery.mock.calls[0];
      expect(String(sql)).not.toContain('iam.effective_permissions');
      expect(String(sql)).not.toContain('iam.effective_countries');
      expect(params).toEqual([20, 'me-uid']);
    });

    it('patientId PRESENTE (q ausente, enforceCountry omitido/default false): SQL ganha EXISTS com iam.effective_permissions (célula), SEM iam.effective_countries; params ganham [patientId, tenantId]', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await new AdminRepository().searchStaffDirectory(undefined, 20, 'me-uid', PATIENT_ID);
      const [sql, params] = mockQuery.mock.calls[0];
      const sqlStr = String(sql);
      expect(sqlStr).toContain('iam.effective_permissions');
      expect(sqlStr).toContain("'patient_conversation:read'");
      expect(sqlStr).not.toContain('iam.effective_countries');
      expect(sqlStr).not.toContain('pt.country');
      expect(params).toEqual([20, 'me-uid', PATIENT_ID, ENLITE_TENANT_ID]);
    });

    it('patientId PRESENTE (q presente, enforceCountry default false): mesmo EXISTS sem país, params ganham [patientId, tenantId] no fim', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await new AdminRepository().searchStaffDirectory('ana', 20, 'me-uid', PATIENT_ID);
      const [sql, params] = mockQuery.mock.calls[0];
      const sqlStr = String(sql);
      expect(sqlStr).toContain('iam.effective_permissions');
      expect(sqlStr).not.toContain('iam.effective_countries');
      expect(params).toEqual(['ana', 20, 'me-uid', PATIENT_ID, ENLITE_TENANT_ID]);
    });

    it('patientId null (uso interno explícito): equivalente a ausente — sem EXISTS', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await new AdminRepository().searchStaffDirectory(undefined, 20, 'me-uid', null);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(String(sql)).not.toContain('iam.effective_permissions');
      expect(params).toEqual([20, 'me-uid']);
    });
  });

  // ── enforceCountry (gate 🔴 do revisao-pr, 22/09): o recorte de país só entra na EXISTS quando
  // o CONTROLLER manda `true` (leitura de `COUNTRY_RLS_ENABLED` via `isEnvFlagOn` — ver
  // AdminStaffDirectoryController.test.ts para a leitura da flag). Aqui, unit puro do
  // REPOSITÓRIO: o contrato é "o booleano que chega decide a cláusula", sem tocar em env.
  //
  // 🔒 Guarda dura (TDD, sabotagem cp+cmp): removendo o `enforceCountry ? ... : ''` do
  // `AdminRepository.ts` (voltando a cláusula de país a incondicional, como era ANTES do fix)
  // o teste "enforceCountry=false NÃO inclui país" morre (RED) — prova que o gate está de fato
  // no caminho, não só documentado. Removendo a linha da CÉLULA (`iam.effective_permissions`) o
  // teste "célula sempre presente, com ou sem país" morre — prova que o eixo de célula nunca é
  // desligado, mesmo quando o país é.
  describe('enforceCountry (COUNTRY_RLS_ENABLED)', () => {
    it('enforceCountry AUSENTE (default false): SQL tem célula, NUNCA país — mesmo com patientId', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await new AdminRepository().searchStaffDirectory(undefined, 20, 'me-uid', PATIENT_ID);
      const sqlStr = String(mockQuery.mock.calls[0][0]);
      expect(sqlStr).toContain('iam.effective_permissions');
      expect(sqlStr).not.toContain('iam.effective_countries');
    });

    it('enforceCountry=false explícito: SQL tem célula, NUNCA país (prova que false não é só "esquecer de passar")', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await new AdminRepository().searchStaffDirectory(undefined, 20, 'me-uid', PATIENT_ID, false);
      const sqlStr = String(mockQuery.mock.calls[0][0]);
      expect(sqlStr).toContain('iam.effective_permissions');
      expect(sqlStr).not.toContain('iam.effective_countries');
    });

    it('enforceCountry=true: SQL ganha o recorte de país (iam.effective_countries / pt.country), célula continua presente', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await new AdminRepository().searchStaffDirectory(undefined, 20, 'me-uid', PATIENT_ID, true);
      const sqlStr = String(mockQuery.mock.calls[0][0]);
      expect(sqlStr).toContain('iam.effective_permissions');
      expect(sqlStr).toContain('iam.effective_countries');
      expect(sqlStr).toContain('pt.country');
    });

    it('enforceCountry=true SEM patientId: não tem efeito nenhum — sem patientId não há EXISTS pra decorar', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await new AdminRepository().searchStaffDirectory(undefined, 20, 'me-uid', undefined, true);
      const sqlStr = String(mockQuery.mock.calls[0][0]);
      expect(sqlStr).not.toContain('iam.effective_permissions');
      expect(sqlStr).not.toContain('iam.effective_countries');
    });

    it('enforceCountry=true não muda os PARÂMETROS — mesmo [patientId, tenantId] de antes, país é literal no SQL', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      await new AdminRepository().searchStaffDirectory(undefined, 20, 'me-uid', PATIENT_ID, true);
      const params = mockQuery.mock.calls[0][1];
      expect(params).toEqual([20, 'me-uid', PATIENT_ID, ENLITE_TENANT_ID]);
    });
  });
});
