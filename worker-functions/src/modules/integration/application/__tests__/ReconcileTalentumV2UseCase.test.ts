import {
  ReconcileTalentumV2UseCase,
  applyReconcile,
  restoreRollbackRows,
  rollbackRowsOf,
} from '../ReconcileTalentumV2UseCase';
import { FakeReconcileDb } from './fakeReconcileDb';
import { fakeTalentumV2Client, type FakeProject } from './fakeTalentumV2Client';
import { buildPublicPrescreeningUrl } from '../../infrastructure/TalentumApiClient';

const PUB = (n: number) => `0b0d2c1e-0000-4000-8000-${String(n).padStart(12, '0')}`;
const WA = 'https://wa.me/5491100000000?text=Hola';

function world(projects: FakeProject[]) {
  const db = new FakeReconcileDb();
  const client = fakeTalentumV2Client(projects);
  return { db, client, uc: new ReconcileTalentumV2UseCase(db, client) };
}

describe('ReconcileTalentumV2UseCase.plan', () => {
  it('liga por publicId: project_id, link web e slug do projeto; o antigo vai para o rollback', async () => {
    const { db, uc } = world([{ projectId: 'v2-1', title: 'EN 1#1', publicId: PUB(1), slug: 'abc' }]);
    db.add({ id: 'jp-1', title: 'outro', talentum_project_id: 'v1-1', talentum_public_id: PUB(1), talentum_whatsapp_url: WA });

    const { changes, report } = await uc.plan();

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      jobPostingId: 'jp-1', kind: 'publicId',
      before: { projectId: 'v1-1', publicId: PUB(1), slug: null, whatsappUrl: WA },
      after: { projectId: 'v2-1', publicId: PUB(1), slug: 'abc', whatsappUrl: buildPublicPrescreeningUrl(PUB(1)) },
    });
    expect(report).toMatchObject({ linkedByPublicId: 1, linkedByTitle: 0, noMatch: 0, ambiguous: 0, alreadyCorrect: 0, projectsWithoutVacancy: 0 });
    expect(rollbackRowsOf(changes)).toEqual([{ jobPostingId: 'jp-1', projectId: 'v1-1', publicId: PUB(1), slug: null, whatsappUrl: WA }]);
  });

  it('compara publicId sem diferenciar maiúsculas', async () => {
    const { db, uc } = world([{ projectId: 'v2-1', title: 't', publicId: PUB(1).toUpperCase() }]);
    db.add({ id: 'jp-1', talentum_project_id: 'v1-1', talentum_public_id: PUB(1) });
    expect((await uc.plan()).report.linkedByPublicId).toBe(1);
  });

  it('sem publicId: casa por título SÓ se 1:1 (inclui título > 50 truncado como a v2 grava), reportado "por título"', async () => {
    const longTitle = 'EN 999#1 '.padEnd(70, 'x');
    const { db, uc } = world([
      { projectId: 'v2-t', title: 'EN 5#1', publicId: PUB(5), slug: 's5' },
      { projectId: 'v2-long', title: longTitle.slice(0, 50).trimEnd(), publicId: PUB(6), slug: 's6' },
    ]);
    db.add({ id: 'jp-t', title: 'EN 5#1', talentum_project_id: 'v1-t', talentum_whatsapp_url: WA });
    db.add({ id: 'jp-long', title: longTitle, talentum_project_id: 'v1-long' });

    const { changes, report } = await uc.plan();

    expect(changes.map((c) => [c.jobPostingId, c.kind, c.after.projectId, c.after.publicId])).toEqual([
      ['jp-long', 'title', 'v2-long', PUB(6)],
      ['jp-t', 'title', 'v2-t', PUB(5)],
    ]);
    expect(report).toMatchObject({ linkedByPublicId: 0, linkedByTitle: 2, noMatch: 0, ambiguous: 0 });
  });

  it('título AMBÍGUO não liga: 2 projetos v2 com o mesmo nome, ou 2 vagas com o mesmo título', async () => {
    const { db, uc } = world([
      { projectId: 'v2-a', title: 'DUP', publicId: PUB(1) },
      { projectId: 'v2-b', title: 'DUP', publicId: PUB(2) },
      { projectId: 'v2-c', title: 'UNICO', publicId: PUB(3) },
    ]);
    db.add({ id: 'jp-dup', title: 'DUP', talentum_project_id: 'v1-a' });
    db.add({ id: 'jp-u1', title: 'UNICO', talentum_project_id: 'v1-b' });
    db.add({ id: 'jp-u2', title: 'UNICO', talentum_project_id: 'v1-c' });

    const { changes, report } = await uc.plan();

    expect(changes).toEqual([]);
    expect(report.ambiguous).toBe(3);
    expect(report.ambiguousIds.sort()).toEqual(['jp-dup', 'jp-u1', 'jp-u2']);
    expect(report.projectsWithoutVacancy).toBe(3);
  });

  it('SEM PAR: publicId que a v2 não tem, título sem projeto, vaga apagada sem publicId, título nulo', async () => {
    const { db, uc } = world([{ projectId: 'v2-1', title: 'EXISTE', publicId: PUB(1) }]);
    db.add({ id: 'jp-pub', talentum_project_id: 'v1-1', talentum_public_id: PUB(99) });
    db.add({ id: 'jp-tit', title: 'NAO EXISTE', talentum_project_id: 'v1-2' });
    db.add({ id: 'jp-del', title: 'EXISTE', deleted: true, talentum_project_id: 'v1-3' });
    db.add({ id: 'jp-nul', title: null, talentum_project_id: 'v1-4' });

    const { changes, report } = await uc.plan();

    expect(changes).toEqual([]);
    expect(report.noMatch).toBe(4);
    expect(report.noMatchIds.sort()).toEqual(['jp-del', 'jp-nul', 'jp-pub', 'jp-tit']);
  });

  it('publicId repetido na v2, ou 2 vagas com o mesmo publicId: ninguém é ligado (ambígua)', async () => {
    const { db, uc } = world([
      { projectId: 'v2-1', title: 'a', publicId: PUB(1) },
      { projectId: 'v2-2', title: 'b', publicId: PUB(1) },
      { projectId: 'v2-3', title: 'c', publicId: PUB(3) },
    ]);
    db.add({ id: 'jp-a', talentum_project_id: 'v1-a', talentum_public_id: PUB(1) });
    db.add({ id: 'jp-b', talentum_project_id: 'v1-b', talentum_public_id: PUB(3) });
    db.add({ id: 'jp-c', talentum_project_id: 'v1-c', talentum_public_id: PUB(3) });

    const { changes, report } = await uc.plan();

    expect(changes).toEqual([]);
    expect(report.ambiguousIds.sort()).toEqual(['jp-a', 'jp-b', 'jp-c']);
  });

  it('título que aponta para projeto que a vaga de publicId já ocupa: só o do título fica ambíguo', async () => {
    const { db, uc } = world([{ projectId: 'v2-1', title: 'MESMO', publicId: PUB(1) }]);
    db.add({ id: 'jp-pub', title: 'x', talentum_project_id: 'v1-a', talentum_public_id: PUB(1) });
    db.add({ id: 'jp-tit', title: 'MESMO', talentum_project_id: 'v1-b' });
    const { changes, report } = await uc.plan();
    expect(changes.map((c) => c.jobPostingId)).toEqual([]);
    expect(report.ambiguousIds.sort()).toEqual(['jp-pub', 'jp-tit']);
  });

  it('projeto já gravado em OUTRA vaga (índice único): ambígua, nada é ligado', async () => {
    const { db, uc } = world([{ projectId: 'v2-1', title: 't', publicId: PUB(1) }]);
    db.add({ id: 'jp-a', talentum_project_id: 'v1-a', talentum_public_id: PUB(1) });
    db.add({ id: 'jp-dono', title: 'x', talentum_project_id: 'v2-1' });
    const { changes, report } = await uc.plan();
    expect(changes).toEqual([]);
    expect(report.ambiguousIds).toEqual(['jp-a']);
  });

  it('INVÁLIDA: slug > 20 caracteres ou publicId que não é UUID (a coluna recusaria)', async () => {
    const { db, uc } = world([
      { projectId: 'v2-1', title: 'a', publicId: PUB(1), slug: 'x'.repeat(21) },
      { projectId: 'v2-2', title: 'b', publicId: 'nao-e-uuid' },
    ]);
    db.add({ id: 'jp-1', talentum_project_id: 'v1-1', talentum_public_id: PUB(1) });
    db.add({ id: 'jp-2', talentum_project_id: 'v1-2', title: 'b' });
    const { changes, report } = await uc.plan();
    expect(changes).toEqual([]);
    expect(report.invalidIds.sort()).toEqual(['jp-1', 'jp-2']);
    expect(report.invalid).toBe(2);
  });

  it('projeto sem link web (PHONE_CALL / 400): casa por título e MANTÉM o que a vaga já tinha', async () => {
    const { db, client, uc } = world([
      { projectId: 'v2-p', title: 'FONE', type: 'PHONE_CALL' },
      { projectId: 'v2-400', title: 'SEM PRESCREENING', detailError: 'GET: HTTP 400' },
    ]);
    db.add({ id: 'jp-p', title: 'FONE', talentum_project_id: 'v1-p', talentum_whatsapp_url: WA, talentum_slug: 'old' });
    db.add({ id: 'jp-4', title: 'SEM PRESCREENING', talentum_project_id: 'v1-4' });

    const { changes, report } = await uc.plan();

    expect(client.calls).toEqual(['v2-400']); // PHONE_CALL nem gasta GET
    expect(changes.map((c) => [c.jobPostingId, c.after])).toEqual([
      ['jp-4', { projectId: 'v2-400', publicId: null, slug: null, whatsappUrl: null }],
      ['jp-p', { projectId: 'v2-p', publicId: null, slug: 'old', whatsappUrl: WA }],
    ]);
    expect(report.linkedByTitle).toBe(2);
  });

  it('já corretas: nada a mudar; e o 2º run depois de aplicar = 0 mudanças (idempotente)', async () => {
    const { db, uc } = world([
      { projectId: 'v2-1', title: 'a', publicId: PUB(1), slug: 's1' },
      { projectId: 'v2-2', title: 'b', publicId: PUB(2), slug: 's2' },
      { projectId: 'v2-3', title: 'orfao', publicId: PUB(3) },
    ]);
    db.add({ id: 'jp-1', talentum_project_id: 'v2-1', talentum_public_id: PUB(1), talentum_slug: 's1', talentum_whatsapp_url: buildPublicPrescreeningUrl(PUB(1)) });
    db.add({ id: 'jp-2', talentum_project_id: 'v1-2', talentum_public_id: PUB(2), talentum_whatsapp_url: WA });

    const first = await uc.plan();
    expect(first.report).toMatchObject({ alreadyCorrect: 1, linkedByPublicId: 1, projectsWithoutVacancy: 1 });
    expect(await applyReconcile(db, first.changes)).toBe(1);

    const second = await uc.plan();
    expect(second.changes).toEqual([]);
    expect(second.report).toMatchObject({ alreadyCorrect: 2, linkedByPublicId: 0, linkedByTitle: 0 });
  });

  it('detalhe que falha (≠ 400) vai para detailErrors; o plano segue com o resto', async () => {
    const { db, uc } = world([
      { projectId: 'v2-1', title: 'a', publicId: PUB(1) },
      { projectId: 'v2-x', title: 'b', publicId: PUB(2), detailError: 'HTTP 500' },
    ]);
    db.add({ id: 'jp-1', talentum_project_id: 'v1-1', talentum_public_id: PUB(1) });
    const { report } = await uc.plan();
    expect(report.detailErrors).toEqual(['v2-x']);
    expect(report.linkedByPublicId).toBe(1);
  });

  it('plan() nunca escreve: só SHOW/SELECT chegam ao banco', async () => {
    const { db, uc } = world([{ projectId: 'v2-1', title: 'a', publicId: PUB(1) }]);
    db.add({ id: 'jp-1', talentum_project_id: 'v1-1', talentum_public_id: PUB(1) });
    await uc.plan();
    expect(db.sql).toEqual(['SELECT id,']);
    expect(db.released).toBe(0);
  });
});

describe('applyReconcile / restoreRollbackRows', () => {
  async function planned() {
    const { db, uc } = world([{ projectId: 'v2-1', title: 'a', publicId: PUB(1), slug: 's1' }]);
    db.add({ id: 'jp-1', talentum_project_id: 'v1-1', talentum_public_id: PUB(1), talentum_whatsapp_url: WA });
    db.add({ id: 'jp-n', talentum_project_id: 'v1-n' });
    return { db, plan: await uc.plan() };
  }

  it('aplica e o rollback devolve o banco IDÊNTICO ao de antes (inclusive NULL)', async () => {
    const { db, plan } = await planned();
    const before = db.snapshot();
    await applyReconcile(db, plan.changes);
    expect(db.snapshot()).not.toBe(before);
    expect(db.sql.slice(-3)).toEqual(['BEGIN', 'UPDATE job_postings', 'COMMIT']);
    expect(await restoreRollbackRows(db, rollbackRowsOf(plan.changes))).toBe(1);
    expect(db.snapshot()).toBe(before);
    expect(db.released).toBe(2);
  });

  it('a vaga mudou desde o plano: ROLLBACK da transação inteira e erro claro', async () => {
    const { db, plan } = await planned();
    db.rows[0].talentum_project_id = 'alguem-mexeu';
    const before = db.snapshot();
    await expect(applyReconcile(db, plan.changes)).rejects.toThrow('mudou desde o plano');
    expect(db.snapshot()).toBe(before);
    expect(db.sql).toContain('ROLLBACK');
    expect(db.released).toBe(1);
  });

  it('rollback de vaga inexistente: erro e ROLLBACK', async () => {
    const { db } = await planned();
    await expect(restoreRollbackRows(db, [{ jobPostingId: 'sumiu', projectId: null, publicId: null, slug: null, whatsappUrl: null }])).rejects.toThrow('não existe');
    expect(db.sql).toContain('ROLLBACK');
  });
});
