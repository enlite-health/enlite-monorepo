/**
 * admin-patients-lead-contact.e2e.test.ts
 *
 * O que SÓ este arquivo prova — e por que ele existe.
 *
 * O formulário público não colhe nome (`2026-07-27a#DEC-02`), então todo lead
 * grava o placeholder 'Solicitante' e o Kanban vira N cards idênticos. A
 * listagem passou a devolver o contato MASCARADO para desempatá-los, sob o
 * parecer `lex` de 30/08, CONDICIONADO em 7 pontos.
 *
 * O gate `revisao-pr` de 31/08 reprovou a primeira versão com um achado que a
 * suíte verde escondia: **o SQL novo nunca tinha rodado contra Postgres.** O
 * teste de repositório mocka o `pool`; o de controller mocka o repositório
 * inteiro — e a prova disso é que, sabotando a máscara, a suíte de controller
 * ficava `9 passed`. Ou seja: a condição **C2 do lex (o corte de escopo) estava
 * implementada e não provada**, porque quem corta é o SQL.
 *
 * Aqui não há mock nenhum: Postgres real, API real, rota real. O que se afirma
 * é o EFEITO no corpo da resposta HTTP.
 *
 * ⚠️ A condição C5 (trilha `patient_lead_contact.read`) NÃO é afirmada aqui: o
 * log sai no stdout do container da API, fora do alcance do processo de teste.
 * Ela é coberta em `AdminPatientsController.leadContact.test.ts`, que assere o
 * conteúdo da linha e que o e-mail nunca entra nela.
 *
 * ⚠️ KMS roda em passthrough no e2e (`NODE_ENV=test` — KMSEncryptionService:11),
 * e passthrough NÃO é texto puro: `encrypt` faz base64 e `decrypt` desfaz. A
 * fixture grava `cifrar()` — o mesmo que a produção grava via `encrypt` — porque
 * semear texto cru faz o `decrypt` devolver lixo, a máscara recusar, e o card
 * vir vazio. (Aconteceu comigo na 1ª rodada; quem apontou foi o contador
 * `recusadosPelaMascara` do próprio log de degradação.)
 *
 * O caminho de código é o mesmo de produção: a subquery correlacionada, o corte
 * por placeholder, o `decrypt` e a máscara executam de verdade.
 */

import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

/** Espelha `KMSEncryptionService.encrypt` em testMode (base64). */
function cifrar(valor: string): string {
  return Buffer.from(valor, 'utf8').toString('base64');
}

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('GET /api/admin/patients — contato do lead sem nome', () => {
  const api = createApiClient();
  let pool: Pool;
  let adminToken: string;
  const criados: string[] = [];

  const TAG = `lead-contact-${Date.now()}`;

  async function seed(opts: {
    firstName: string | null;
    lastName?: string | null;
    /** vai para patients.contact_email_encrypted (passthrough no e2e) */
    contactEmail?: string | null;
    /** cria um patient_responsibles primário com este e-mail */
    responsibleEmail?: string | null;
  }): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, status, origin, contact_email_encrypted)
       VALUES ($1, $2, $3, $4, 'SOLICITANTE', 'web_form', $5)`,
      [id, `${TAG}-${id}`, opts.firstName, opts.lastName ?? null, opts.contactEmail ? cifrar(opts.contactEmail) : null],
    );
    if (opts.responsibleEmail) {
      await pool.query(
        // `last_name` é NOT NULL no schema — fato que só o banco real conta.
        // A produção grava '' (CreateLeadUseCase, ramo do responsável).
        `INSERT INTO patient_responsibles (id, patient_id, first_name, last_name, is_primary, display_order, email_encrypted)
         VALUES ($1, $2, 'Solicitante', '', true, 1, $3)`,
        [randomUUID(), id, cifrar(opts.responsibleEmail)],
      );
    }
    criados.push(id);
    return id;
  }

  /** A rota devolve a página inteira; aqui isolamos as linhas que este teste semeou. */
  async function listar(): Promise<Record<string, any>[]> {
    const res = await api.get('/api/admin/patients?limit=200&offset=0', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    return (res.data.data as Record<string, any>[]).filter((p) => criados.includes(p.id));
  }

  let idLeadProprio = '';
  let idLeadResponsavel = '';
  let idComNome = '';
  let idSemContato = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await waitForBackend(api);
    adminToken = await getMockToken(api, {
      uid: 'lead-contact-admin-e2e',
      email: 'lead-contact-admin@e2e.local',
      role: 'admin',
    });

    // 1. lead cujo contato é do PRÓPRIO paciente
    idLeadProprio = await seed({ firstName: 'Solicitante', contactEmail: 'joana@gmail.com' });
    // 2. lead preenchido pelo FAMILIAR: paciente sem e-mail, contato no responsável
    idLeadResponsavel = await seed({ firstName: 'Solicitante', responsibleEmail: 'filha@hotmail.com' });
    // 3. ficha com NOME REAL, e com ciphertext na linha — o controle do corte C2
    idComNome = await seed({ firstName: 'Francisco', lastName: 'Alomon', contactEmail: 'francisco@gmail.com' });
    // 4. lead sem contato nenhum — degrada, não quebra
    idSemContato = await seed({ firstName: 'Solicitante' });
  });

  afterAll(async () => {
    if (criados.length) {
      await pool.query('DELETE FROM patient_responsibles WHERE patient_id = ANY($1::uuid[])', [criados]);
      await pool.query('DELETE FROM patients WHERE id = ANY($1::uuid[])', [criados]);
    }
    await pool.end();
  });

  it('C2 — o corte de escopo é feito pelo SQL: ficha com NOME REAL não expõe contato', async () => {
    const linhas = await listar();
    const comNome = linhas.find((p) => p.id === idComNome)!;

    expect(comNome).toBeDefined();
    expect(comNome.firstName).toBe('Francisco');
    // A linha TEM ciphertext no banco. Se o corte não fosse do servidor, viria mascarado.
    expect(comNome.leadContactEmailMasked).toBeNull();
    expect(comNome.leadContactIsResponsible).toBe(false);
  });

  it('C1 — o lead sem nome vem MASCARADO, e o endereço cru não aparece', async () => {
    const linhas = await listar();
    const lead = linhas.find((p) => p.id === idLeadProprio)!;

    expect(lead.leadContactEmailMasked).toBe('joa•••@gmail.com');
    expect(lead.leadContactIsResponsible).toBe(false);
    expect(JSON.stringify(lead)).not.toContain('joana@gmail.com');
  });

  it('C6 — contato do RESPONSÁVEL vem marcado (a subquery correlacionada roda de verdade)', async () => {
    const linhas = await listar();
    const lead = linhas.find((p) => p.id === idLeadResponsavel)!;

    // Este é o caminho que NENHUM teste com mock exercia: JOIN em
    // patient_responsibles, is_primary, ORDER BY display_order.
    expect(lead.leadContactEmailMasked).toBe('fil•••@hotmail.com');
    expect(lead.leadContactIsResponsible).toBe(true);
  });

  it('lead sem contato nenhum degrada o card, não a listagem', async () => {
    const linhas = await listar();
    const lead = linhas.find((p) => p.id === idSemContato)!;

    expect(lead).toBeDefined();
    expect(lead.leadContactEmailMasked).toBeNull();
  });

  it('⛔ o corpo INTEIRO da resposta não contém nenhum e-mail completo', async () => {
    const res = await api.get('/api/admin/patients?limit=200&offset=0', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const corpo = JSON.stringify(res.data);

    for (const cru of ['joana@gmail.com', 'filha@hotmail.com', 'francisco@gmail.com']) {
      expect(corpo).not.toContain(cru);
    }
    // E a forma geral: nenhum endereço de e-mail íntegro em lugar nenhum.
    expect(corpo).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  });
});
