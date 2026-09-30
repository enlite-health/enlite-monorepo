/**
 * prescreeningIgnoraDrive.e2e.test.ts @integration — spec 029 (prompts de IA editáveis), T052a.
 *
 * O QUE ESTE TESTE PROVA
 *  A fonte viva do prompt de pré-triagem (slug PRESCREENING_AT) é a tabela `ai_prompts`, e SÓ ela.
 *  Com dois lados, na mesma suíte:
 *   - CONTROLE POSITIVO: com a linha da tabela no estado original, o texto enviado ao "modelo"
 *     (log `[VERTEX-STUB] systemInstruction=`) CONTÉM a linha-âncora do conteúdo que estava no
 *     Google Doc. Isso prova que o detector do contraexemplo enxerga o texto do Doc quando ele está lá.
 *   - ALTERAÇÃO: troca `ai_prompts.body` por um marcador único e gera de novo. O texto enviado é o
 *     NOVO (contém o marcador) e NÃO contém a linha-âncora do Doc — que continua existindo, inalterada,
 *     no Drive. Se alguém religasse o Drive, a âncora reapareceria e o teste morreria.
 *  Contraexemplo: primeira linha (não vazia) de `/tmp/prompts-drive/PRESCREENING_AT.txt` (extração do
 *  Doc feita na T047/T049). Se o arquivo não existir, cai em um marcador sintético equivalente e o
 *  controle positivo o injeta na tabela antes — o teste vale, mas a âncora deixa de ser o texto real.
 *
 * O QUE ESTE TESTE NÃO PROVA
 *  - A formulação do plano ("aponta as credenciais do Drive para um documento de conteúdo DIFERENTE")
 *    NÃO se aplica mais: não há credencial nem cliente do Drive depois do corte (T051a), e apontar
 *    algo inexistente passaria de graça. A prova estrutural de que o código do Drive não existe está
 *    em `prescreeningSemDrive.e2e.test.ts`.
 *  - Não prova nada sobre o Google Doc em si (não é lido nem editado aqui): prova que a saída do
 *    sistema acompanha a TABELA e ignora o texto que o Doc tinha.
 *  - O preload devolve resposta sintética fora do formato de pré-triagem, então o endpoint pode
 *    terminar em erro APÓS a chamada ao modelo; o status HTTP não é asserido (só que passou de
 *    auth/rota). A prova é o que foi ENVIADO.
 *  - Custo: a chamada é interceptada pelo preload (nenhuma rede para o Vertex); tráfego a hosts
 *    não-Google não passa por ele.
 *
 * Restaura a linha de `ai_prompts` no `afterAll`, incondicionalmente.
 */
import { existsSync, readFileSync } from 'fs';
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth, type StaffAuth } from './helpers/staffAuth';
import { apiContainerLogs } from './helpers/apiContainer';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5529/enlite_e2e';
process.env.DATABASE_URL = DATABASE_URL;

const SLUG = 'PRESCREENING_AT';
const DOC_EXTRACT = '/tmp/prompts-drive/PRESCREENING_AT.txt';

/** Forma como a âncora aparece dentro do log: o preload loga `JSON.stringify(systemInstruction)`. */
function asLogged(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}

describe('Pré-triagem ignora o Drive — o texto usado é o da tabela (spec 029, T052a) @integration', () => {
  const api = createApiClient();
  let asAdmin: StaffAuth;
  let pool: Pool;
  let jobPostingId: string;
  let originalBody: string;
  let docAnchor: string;
  let anchorIsRealDocText: boolean;

  async function generate(): Promise<string> {
    const before = apiContainerLogs();
    const res = await api.post(`/api/admin/vacancies/${jobPostingId}/generate-ai-content`, {}, asAdmin);
    expect([401, 403, 404]).not.toContain(res.status);
    return apiContainerLogs().slice(before.length);
  }

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = await staffAuth('prescreening-ignora-drive-admin', 'admin');
    pool = new Pool({ connectionString: DATABASE_URL });

    const seeded = await pool.query<{ body: string }>(`SELECT body FROM ai_prompts WHERE slug = $1`, [SLUG]);
    if (seeded.rows.length === 0) {
      throw new Error(`Pré-condição ausente: ai_prompts não tem linha ${SLUG} (migration de seed não aplicada?)`);
    }
    originalBody = seeded.rows[0].body;

    anchorIsRealDocText = existsSync(DOC_EXTRACT);
    const firstLine = anchorIsRealDocText
      ? readFileSync(DOC_EXTRACT, 'utf8').split('\n').map((l) => l.trim()).find((l) => l.length >= 20)
      : undefined;
    docAnchor = firstLine ?? `T052A-DOC-ANCHOR-${Date.now()}`;
    anchorIsRealDocText = anchorIsRealDocText && firstLine !== undefined;

    const jp = await pool.query<{ id: string }>(
      `INSERT INTO job_postings (title, description, country, status, required_professions)
       VALUES ($1, 'T052a e2e — ignora Drive', 'AR', 'SEARCHING', ARRAY['AT']) RETURNING id`,
      [`T052a-JP-${Date.now()}`],
    );
    jobPostingId = jp.rows[0].id;
  });

  afterAll(async () => {
    // Incondicional: afterAll roda mesmo se a asserção falhar.
    await pool.query(`UPDATE ai_prompts SET body = $1, updated_at = NOW() WHERE slug = $2`, [originalBody, SLUG]);
    await pool.query(`DELETE FROM job_postings WHERE id = $1`, [jobPostingId]).catch(() => {});
    await pool.end();
  });

  it('controle positivo: com a tabela no estado original, a âncora do Doc chega ao modelo', async () => {
    if (!anchorIsRealDocText) {
      // Sem a extração do Doc: injeta o marcador sintético na tabela para o detector poder provar que enxerga.
      await pool.query(`UPDATE ai_prompts SET body = $1 || $2, updated_at = NOW() WHERE slug = $3`, [
        docAnchor,
        originalBody,
        SLUG,
      ]);
    }
    const delta = await generate();
    expect(delta).toContain('[VERTEX-STUB] intercepted call');
    expect(delta).toContain(asLogged(docAnchor));
    await pool.query(`UPDATE ai_prompts SET body = $1, updated_at = NOW() WHERE slug = $2`, [originalBody, SLUG]);
  });

  it('depois de alterar a tabela, o texto enviado é o NOVO e a âncora do Doc some', async () => {
    const marker = `T052A-MARKER-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await pool.query(`UPDATE ai_prompts SET body = $1, updated_at = NOW() WHERE slug = $2`, [marker, SLUG]);

    const delta = await generate();
    expect(delta).toContain('[VERTEX-STUB] intercepted call');
    // Ancorada em `systemInstruction="`: o serviço anexa o bloco de formato depois do marcador, então a aspa
    // de fechamento não vem logo após ele — `JSON.stringify(marker)` (2 aspas) nunca casaria.
    expect(delta).toContain(`systemInstruction="${asLogged(marker)}`);
    expect(delta).toContain('NO REAL NETWORK CALL LEFT THIS PROCESS');
    expect(delta).not.toContain('[VERTEX-STUB] BLOCKED');
    // O Doc segue existindo, inalterado — e nada dele chega ao modelo.
    expect(delta).not.toContain(asLogged(docAnchor));
  });
});
