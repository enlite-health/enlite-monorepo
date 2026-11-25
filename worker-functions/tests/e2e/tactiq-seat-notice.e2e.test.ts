/**
 * tactiq-seat-notice.e2e.test.ts — change tactiq-vinculo-resiliente, F3: queda ou recusa por FALTA DE ASSENTO avisa os membros vivos do
 * Acesso Master (e o host), contra POSTGRES REAL (SQL de `activeMasterUids`/`iam.is_master_member`, `claimSeatEpisode`, `seatEpisodeNotified`,
 * `claimNotification`, publicação do sino). Serviço, repositório e publicador REAIS; só o Tactiq (OAuth e MCP) é dublê, programado POR TOKEN.
 * O KMS roda em passthrough base64 (NODE_ENV=test). Dados SINTÉTICOS (@example.test); nenhum canal real.
 *
 * Os membros do Acesso Master são semeados em `iam.user_groups` SÓ no banco de teste (o código de produção nunca escreve em `iam.*`).
 * O `runDailyCheck` olha a tabela inteira (outros testes deixam linhas): TODA asserção é sobre os e-mails/uids DESTA rodada, e a cópia do
 * Master é separada por nome da operadora (cada host leva um nome próprio). Os eventos `tactiq_link.*` são append-only: e-mail com o sufixo da rodada.
 *
 * (a) o diário derruba por `request_seat` → 1 cópia por master vivo + 1 aviso ao host (`adminNotified`)
 * (b) membro com `removed_at` NÃO recebe · (c) 2ª rodada → nada novo
 * (d) duas recusas no callback (`completeLink`) → 1 cópia por master · (e) 0 masters → host `adminNotified=false`
 */
import { Pool } from 'pg';
import type { AccessVerdict } from '../../src/modules/matching/application/ports/TactiqPorts';
import { TactiqAccessDeniedError, TactiqLinkService } from '../../src/modules/matching/application/TactiqLinkService';
import { TactiqLinkRepository } from '../../src/modules/matching/infrastructure/TactiqLinkRepository';
import { FakeTactiqMcp, FakeTactiqOAuth } from '../../src/modules/matching/infrastructure/doubles/FakeTactiq';
import { capturingLogger } from '../../src/modules/matching/infrastructure/doubles/admissionTestKit';
import { ACESSO_MASTER_GROUP_ID } from '../../src/modules/identity/permissions/domain/PermissionCell';
import { TENANT_E2E, limparIamFixtures } from './helpers/permissionFamilyHarness';
import { deleteInterviewHosts, insertInterviewHost } from './helpers/interviewHostFixture';
import { declareTactiqSeat } from './helpers/tactiqSeatFixture';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const RUN = Date.now().toString(36);
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const MIN = 60_000;
const DETAILS = 'mcp:meetings:own mcp:meetings:details';

const MASTERS = {
  vivoA: `tqseat-ma-${RUN}`,
  vivoB: `tqseat-mb-${RUN}`,
  removido: `tqseat-mr-${RUN}`, // filiação com `removed_at`: NÃO é Master vivo
};
const emailOfUid = (uid: string): string => `${uid}@seat-e2e.example.test`;

/** MCP com veredito POR access token; quem não está no mapa é `ready` (não derruba o que é de outra suíte). */
class ScriptedMcp extends FakeTactiqMcp {
  readonly verdicts = new Map<string, AccessVerdict>();
  async ping(accessToken: string): Promise<AccessVerdict> {
    const programmed = this.verdicts.get(accessToken);
    if (programmed) {
      this.pingTokens.push(accessToken);
      return programmed;
    }
    return super.ping(accessToken);
  }
}

/** Banco SEM nenhum Master vivo (o teste (e)): o resto do repositório é o real. O `activeMasterUids` real já é provado em (a)-(c). */
class RepoSemMasters extends TactiqLinkRepository {
  async activeMasterUids(): Promise<string[]> {
    return [];
  }
}

describe('falta de assento avisa o Acesso Master — Postgres real (change tactiq-vinculo-resiliente, F3)', () => {
  let admin: Pool;
  let oauth: FakeTactiqOAuth;
  let mcp: ScriptedMcp;
  let logs: ReturnType<typeof capturingLogger>;
  let clock = new Date();
  let seq = 0;
  const hostEmails: string[] = [];
  const hostUids: string[] = [];
  const tick = (): void => {
    clock = new Date(clock.getTime() + MIN);
  };

  const service = (repo: TactiqLinkRepository = new TactiqLinkRepository(admin)): TactiqLinkService =>
    new TactiqLinkService({ repo, oauth, mcp, db: admin, log: logs.log, now: () => clock, clientId: () => 'mcp-cliente-e2e' });

  /** Operadora do roster com usuário (recebe o sino), vínculo `linked` e o token programado. O nome é próprio: separa a cópia do Master por host. */
  async function newHost(opts: { link?: boolean } = {}): Promise<{ email: string; uid: string; name: string; token: string }> {
    seq += 1;
    const email = `op${seq}.${RUN}@example.test`;
    const uid = `tqseat-op${seq}-${RUN}`;
    const name = `Operadora Sintetica ${seq} ${RUN}`;
    const token = `rt-seat-${seq}-${RUN}`;
    await insertInterviewHost(admin, { email, displayName: name, withUser: true, uid });
    hostEmails.push(email);
    hostUids.push(uid);
    if (opts.link !== false) {
      const { rows } = await admin.query<{ id: string }>(
        `INSERT INTO tactiq_links (host_email, firebase_uid, status, status_changed_at, last_notified_status)
         VALUES ($1, $2, 'linked', $3, 'linked') RETURNING id`,
        [email, uid, clock],
      );
      await admin.query(`INSERT INTO tactiq_link_secrets (link_id, refresh_token_encrypted) VALUES ($1, $2)`, [rows[0].id, b64(token)]);
    }
    return { email, uid, name, token };
  }

  const denySeat = (token: string): void => void mcp.verdicts.set(`at-${token}`, { kind: 'denied', action: 'request_seat', title: null });

  type Payload = Record<string, unknown>;
  const sino = async (uid: string): Promise<Payload[]> =>
    (
      await admin.query<{ payload: Payload }>(
        `SELECT e.payload FROM notifications n JOIN notification_events e ON e.id = n.event_id
          WHERE n.recipient_uid = $1 AND e.type_code = 'ADMISSION_TACTIQ_LINK_REQUIRED' ORDER BY n.created_at, e.id`,
        [uid],
      )
    ).rows.map((r) => r.payload);
  /** A cópia do Master sobre ESTE host (o nome é único por host). */
  const copiesAbout = async (masterUid: string, hostName: string): Promise<Payload[]> =>
    (await sino(masterUid)).filter((p) => p.audience === 'master' && p.hostName === hostName);
  const notified = async (email: string) =>
    (
      await admin.query<{ outcome: string | null; reason: string | null }>(
        `SELECT outcome, reason FROM admission_events WHERE lower(host_email) = lower($1) AND kind = $2 ORDER BY at, id`,
        [email, 'tactiq_link.notified'],
      )
    ).rows;
  const linkStatus = async (email: string): Promise<string | undefined> =>
    (await admin.query<{ status: string }>(`SELECT status FROM tactiq_links WHERE lower(host_email) = lower($1)`, [email])).rows[0]?.status;

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL, max: 4 });
    await limparIamFixtures(admin, { uids: Object.values(MASTERS), grupos: [] });
    for (const uid of Object.values(MASTERS)) {
      await admin.query(
        `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES ($1, $2, 'admin', 'ACTIVE', true, $3)`,
        [uid, emailOfUid(uid), TENANT_E2E],
      );
    }
    // Semeado só no banco de teste: o código de produção nunca escreve em `iam.*`.
    for (const uid of [MASTERS.vivoA, MASTERS.vivoB]) {
      await admin.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [uid, ACESSO_MASTER_GROUP_ID, TENANT_E2E]);
    }
    await admin.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id, removed_at) VALUES ($1, $2, $3, now())`, [
      MASTERS.removido, ACESSO_MASTER_GROUP_ID, TENANT_E2E,
    ]);
  });
  beforeEach(() => {
    oauth = new FakeTactiqOAuth();
    mcp = new ScriptedMcp();
    logs = capturingLogger();
    clock = new Date();
  });
  afterAll(async () => {
    await admin.query(`DELETE FROM notifications WHERE recipient_uid = ANY($1)`, [[...Object.values(MASTERS), ...hostUids]]);
    await admin.query(
      `DELETE FROM notification_events e WHERE e.type_code = 'ADMISSION_TACTIQ_LINK_REQUIRED' AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.event_id = e.id)`,
    );
    await admin.query(`DELETE FROM tactiq_oauth_states WHERE host_email = ANY($1)`, [hostEmails]);
    await admin.query(`DELETE FROM tactiq_links WHERE lower(host_email) = ANY($1)`, [hostEmails]);
    await deleteInterviewHosts(admin, hostEmails);
    await admin.query(`DELETE FROM users WHERE firebase_uid = ANY($1)`, [hostUids]);
    await limparIamFixtures(admin, { uids: Object.values(MASTERS), grupos: [] });
    await admin.end();
  });

  it('(a) o diário derruba por `request_seat` → 1 cópia por master vivo (com o nome) + 1 aviso ao host com `adminNotified`; eventos `notified` na trilha', async () => {
    const h = await newHost();
    denySeat(h.token);
    await service().runDailyCheck();

    expect(await linkStatus(h.email)).toBe('broken');
    const expected = { reason: 'seat_missing', audience: 'master', hostName: h.name, autoReactivates: true };
    expect(await copiesAbout(MASTERS.vivoA, h.name)).toEqual([expected]);
    expect(await copiesAbout(MASTERS.vivoB, h.name)).toEqual([expected]);
    expect(await sino(h.uid)).toEqual([{ reason: 'seat_missing', audience: 'host', adminNotified: true, autoReactivates: true }]);
    expect(await notified(h.email)).toEqual([
      { outcome: 'sent', reason: 'seat_missing_master' },
      { outcome: 'sent', reason: 'seat_missing' },
    ]);
  });

  it('(b) membro com `removed_at` NÃO recebe a cópia (filiação viva é o critério)', async () => {
    const h = await newHost();
    denySeat(h.token);
    await service().runDailyCheck();
    expect(await copiesAbout(MASTERS.vivoA, h.name)).toHaveLength(1);
    expect(await sino(MASTERS.removido)).toEqual([]);
  });

  it('(c) 2ª rodada com o mesmo estado → nada novo (Master, host e trilha)', async () => {
    const h = await newHost();
    denySeat(h.token);
    const svc = service();
    await svc.runDailyCheck();
    tick();
    await svc.runDailyCheck();
    tick();
    await svc.runDailyCheck();
    expect(await copiesAbout(MASTERS.vivoA, h.name)).toHaveLength(1);
    expect(await copiesAbout(MASTERS.vivoB, h.name)).toHaveLength(1);
    expect(await sino(h.uid)).toHaveLength(1);
    expect(await notified(h.email)).toHaveLength(2);
  });

  it('(d) duas recusas no callback (`completeLink` real, `request_seat`) → 1 cópia por master; o host não leva sino (está na tela)', async () => {
    const h = await newHost({ link: false });
    oauth.exchangeScope = DETAILS;
    // F5 (D16): quem nunca vinculou só começa com a licença declarada. Declarada e recusada por assento = MARCAÇÃO FALSA: a 1ª recusa derruba a
    // declaração e o Master recebe a cópia com `autoReactivates=false` (a pessoa cai no caminho do legado); a 2ª já tem linha e não repete nada.
    await declareTactiqSeat(admin, h.email);
    const svc = service();
    for (const n of [1, 2]) {
      const code = `rt-d${n}-${seq}-${RUN}`;
      denySeat(code);
      const { authorizeUrl } = await svc.startLink({ uid: h.uid, email: h.email });
      await expect(svc.completeLink({ state: new URL(authorizeUrl).searchParams.get('state')!, code })).rejects.toBeInstanceOf(TactiqAccessDeniedError);
      tick();
    }
    expect(await linkStatus(h.email)).toBe('broken');
    expect(await copiesAbout(MASTERS.vivoA, h.name)).toEqual([{ reason: 'seat_missing', audience: 'master', hostName: h.name, autoReactivates: false }]);
    expect(await copiesAbout(MASTERS.vivoB, h.name)).toHaveLength(1);
    expect(await sino(h.uid)).toEqual([]);
    expect((await notified(h.email)).filter((e) => e.outcome === 'sent')).toEqual([{ outcome: 'sent', reason: 'seat_missing_master' }]);

    // o episódio já foi avisado: o teste diário seguinte avisa o HOST (que ainda não sabe) sem repetir a cópia do Master
    await svc.runDailyCheck();
    expect(await copiesAbout(MASTERS.vivoA, h.name)).toHaveLength(1);
    expect(await sino(h.uid)).toEqual([{ reason: 'seat_missing', audience: 'host', adminNotified: true, autoReactivates: true }]);
  });

  it('(e) 0 masters vivos → o host recebe `adminNotified=false`, a trilha registra `no_recipient` e o log avisa sem e-mail nem nome', async () => {
    const h = await newHost();
    denySeat(h.token);
    await service(new RepoSemMasters(admin)).runDailyCheck();

    expect(await sino(h.uid)).toEqual([{ reason: 'seat_missing', audience: 'host', adminNotified: false, autoReactivates: true }]);
    expect(await copiesAbout(MASTERS.vivoA, h.name)).toEqual([]);
    expect(await notified(h.email)).toEqual([
      { outcome: 'no_recipient', reason: 'seat_missing_master' },
      { outcome: 'sent', reason: 'seat_missing' },
    ]);
    const out = logs.output();
    expect(out).toContain('admission.tactiq_link.master_notice.no_recipient');
    expect(out).not.toContain(h.email);
    expect(out).not.toContain(h.name);
  });
});
