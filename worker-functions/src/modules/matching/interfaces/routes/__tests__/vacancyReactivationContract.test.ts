/**
 * TESTE-CHAVE (b) da spec 084 / R17 — NÃO existe rota nem ação que reative vaga sem serviço.
 *
 * Contrato por inventário (falha se aparecer algo novo, forçando a revisão da R17):
 *   1. as rotas MUTANTES de vaga em `adminVacanciesRoutes` são exatamente as da allowlist — uma rota nova
 *      (ex.: `/vacancies/:id/reactivate`) derruba o teste até alguém provar que ela não tira vaga de DE_BAJA;
 *   2. todo `UPDATE job_postings ... status` do código de produção está num arquivo da allowlist e, onde a
 *      linha pode sair de DE_BAJA, a saída é só a do gatilho do serviço (motivo SERVICE) ou está guardada;
 *   3. o PUT é recusado com 409 para qualquer vaga em DE_BAJA (`authorizeVacancyUpdate`).
 */
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://unit:unit@127.0.0.1:1/unit';

import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import { scanExpressRouter } from '@modules/identity/permissions';
import { authDouble, permissionsDouble } from '@modules/identity/interfaces/middleware/__tests__/permissionFamilyDoubles';
import { createAdminVacanciesRoutes } from '../adminVacanciesRoutes';
import { authorizeVacancyUpdate } from '../../controllers/vacancyCrudHelpers';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
  reportError: jest.fn(),
}));

const responde = (n: string) => (_req: express.Request, res: express.Response) => res.json({ m: n });
const dubleDe = (p: string, ms: string[]) => Object.fromEntries(ms.map((m) => [m, responde(`${p}.${m}`)]));

function build(): express.Router {
  return createAdminVacanciesRoutes(
    dubleDe('vac', ['listVacancies', 'getVacanciesStats', 'getNextVacancyNumber', 'getCasesForSelect', 'getVacancyById']) as never,
    dubleDe('crud', ['createVacancy', 'updateVacancy', 'deleteVacancy']) as never,
    dubleDe('talentum', ['publishToTalentum', 'unpublishFromTalentum', 'generateTalentumDescription', 'updateTalentumDescription',
      'generateAIContent', 'syncFromTalentum', 'getPrescreeningConfig', 'getTalentumStatus', 'savePrescreeningConfig']) as never,
    dubleDe('match', ['getMatchResults', 'triggerMatch', 'updateEncuadreResult']) as never,
    dubleDe('social', ['generateSocialLink', 'getSocialLinksStats']) as never,
    dubleDe('funnel', ['getEncuadreFunnel', 'moveEncuadre', 'rejectBlockedApplication', 'undismissBlockedApplication']) as never,
    dubleDe('dash', ['getCoordinatorCapacity', 'getAlerts', 'getConversionByChannel']) as never,
    dubleDe('slots', ['createSlots', 'getSlots', 'bookSlot', 'cancelSlot']) as never,
    authDouble(),
    permissionsDouble(),
    dubleDe('addr', ['resolveAddressReview']) as never,
    dubleDe('table', ['getEncuadreFunnelTable']) as never,
  );
}

/** Rotas MUTANTES conhecidas. Nenhuma reativa vaga: cada uma foi lida contra a R17. */
const MUTANTES_PERMITIDAS = new Set([
  'DELETE /interview-slots/:slotId',
  'DELETE /vacancies/:id',                       // soft-delete (R2: a baixa é outro caminho)
  'DELETE /vacancies/:id/publish-talentum',
  'DELETE /vacancies/:vacancyId/workers/:workerId/contact-notes/:noteId',
  'POST /interview-slots/:slotId/book',
  'POST /vacancies',
  'POST /vacancies/:id/generate-ai-content',
  'POST /vacancies/:id/generate-talentum-description',
  'POST /vacancies/:id/interview-slots',
  'POST /vacancies/:id/match',
  'POST /vacancies/:id/notes',
  'POST /vacancies/:id/prescreening-config',
  'POST /vacancies/:id/publish-talentum',
  'POST /vacancies/:id/resolve-address-review',
  'POST /vacancies/:id/social-links',
  'POST /vacancies/:id/source-change-notices/:field/ack',
  'POST /vacancies/:vacancyId/workers/:workerId/contact-notes',
  'POST /vacancies/baja',                         // DAR baixa — o sentido único
  'POST /vacancies/blocked-applications/:blockedId/promote',
  'POST /vacancies/blocked-applications/:blockedId/reject',
  'POST /vacancies/blocked-applications/:blockedId/restore',
  'POST /vacancies/sync-talentum',
  'PUT /encuadres/:id/move',
  'PUT /encuadres/:id/result',
  'PUT /vacancies/:id',                           // recusa DE_BAJA (409) — ver o 3º bloco
  'PUT /vacancies/:id/talentum-description',
]);

describe('R17 — nenhuma rota reativa vaga (contrato por inventário)', () => {
  it('as rotas mutantes de vaga são exatamente as revisadas; rota nova (ex.: /reactivate) derruba este teste', () => {
    const mutantes = scanExpressRouter(build())
      .filter((r) => r.method !== 'GET')
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(mutantes).toEqual([...MUTANTES_PERMITIDAS].sort());
  });

  it('nenhuma rota tem nome de reativação/reabertura/restauração DE VAGA', () => {
    const nomes = scanExpressRouter(build()).map((r) => r.path);
    const suspeitas = nomes.filter((p) => /react|reabr|reopen|unbaja|de-baja|undo-baja|reativ/i.test(p));
    expect(suspeitas).toEqual([]);
  });
});

describe('R17 — todo UPDATE que escreve job_postings.status está numa allowlist', () => {
  const SRC = path.resolve(__dirname, '../../../../..');
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : walk(p);
      return /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [p] : [];
    });

  /** Trechos `UPDATE job_postings SET ... ` até o fim do template literal. */
  const updates = (file: string): string[] => {
    const text = fs.readFileSync(file, 'utf8');
    const out: string[] = [];
    const re = /UPDATE\s+job_postings\s+SET([^`]*)`/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) out.push(m[0]);
    return out;
  };
  const escreveStatus = (sql: string): boolean => /(^|[\s,])status\s*=/.test(sql.replace(/status_before_baja\s*=|talentum_pause_state\s*=/g, ''));

  const arquivos = walk(SRC).map((f) => ({ f: path.relative(SRC, f), upd: updates(f).filter(escreveStatus) })).filter((x) => x.upd.length > 0);

  it('só estes arquivos de produção escrevem status de vaga (arquivo novo = revisar a R17)', () => {
    expect(arquivos.map((x) => x.f).sort()).toEqual([
      'modules/case/infrastructure/PatientContractedServiceRepository.ts',   // baixa/volta pelo SERVIÇO (R17)
      'modules/matching/application/BajaVacanciesUseCase.ts',               // DAR baixa
      'modules/matching/infrastructure/JobPostingARRepository.ts',          // import do ClickUp — guardado abaixo
      'modules/matching/interfaces/controllers/vacancyCrudAuditHelpers.ts', // soft-delete (CLOSED + deleted_at)
    ]);
  });

  it('a ÚNICA saída de DE_BAJA é a do serviço, filtrada pelo motivo SERVICE', () => {
    const repo = arquivos.find((x) => x.f.endsWith('PatientContractedServiceRepository.ts'))!;
    const saida = repo.upd.find((u) => /status\s*=\s*COALESCE\(status_before_baja/.test(u))!;
    expect(saida).toBeDefined();
    expect(saida).toContain(`baja_reason = 'SERVICE'`);
    expect(saida).toContain(`status = 'DE_BAJA'`);
  });

  it('o import do ClickUp não tira vaga de DE_BAJA (CASE no status nos dois UPDATEs)', () => {
    const ar = arquivos.find((x) => x.f.endsWith('JobPostingARRepository.ts'))!;
    expect(ar.upd.length).toBe(2);
    for (const u of ar.upd) expect(u).toMatch(/status\s*=\s*CASE WHEN status = 'DE_BAJA' THEN status/);
  });

  it('DAR baixa só entra em DE_BAJA, nunca sai; o soft-delete só escreve CLOSED', () => {
    const baja = arquivos.find((x) => x.f.endsWith('BajaVacanciesUseCase.ts'))!;
    expect(baja.upd.every((u) => /status\s*=\s*'\$\{DE_BAJA_STATUS\}'/.test(u))).toBe(true);
    const del = arquivos.find((x) => x.f.endsWith('vacancyCrudAuditHelpers.ts'))!;
    expect(del.upd.every((u) => /status\s*=\s*'CLOSED'/.test(u))).toBe(true);
  });
});

describe('R17 — PUT /vacancies/:id em vaga DE_BAJA', () => {
  const dbCom = (row: Record<string, unknown>) => ({ query: jest.fn(async () => ({ rows: [row] })) }) as never;

  it.each(['SEARCHING', 'ON_HOLD', 'ACTIVE', 'CLOSED'])('mudar status para %s → 409 e a vaga segue baixada', async (status) => {
    const out = await authorizeVacancyUpdate(
      dbCom({ status: 'DE_BAJA', is_draft: false, patient_id: 'p', contracted_service_id: null, service_active: null }),
      'v1',
      { status },
    );
    expect(out).toMatchObject({ kind: 'error', status: 409, code: 'VACANCY_DE_BAJA_NO_REACTIVATION' });
    expect((out as { messages: { es: string; 'pt-BR': string } }).messages.es).toMatch(/no se reactiva/);
    expect((out as { messages: { es: string; 'pt-BR': string } }).messages['pt-BR']).toMatch(/não é reativada/);
  });

  it('nem outros campos mudam numa vaga baixada (só consulta)', async () => {
    const out = await authorizeVacancyUpdate(
      dbCom({ status: 'DE_BAJA', is_draft: true, patient_id: 'p', contracted_service_id: null, service_active: null }),
      'v1',
      { salary_text: 'x' },
    );
    expect(out).toMatchObject({ kind: 'error', status: 409 });
  });

  it('DE_BAJA nunca é um status aceito no corpo do PUT (400): ninguém baixa por aqui', async () => {
    const out = await authorizeVacancyUpdate(dbCom({ status: 'SEARCHING', is_draft: false, patient_id: 'p', contracted_service_id: null, service_active: null }), 'v1', { status: 'DE_BAJA' });
    expect(out).toMatchObject({ kind: 'error', status: 400 });
  });
});
