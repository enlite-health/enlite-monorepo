/**
 * prescreeningSemDrive.e2e.test.ts @integration — spec 029 (prompts de IA editáveis), T052.
 *
 * O QUE ESTE TESTE PROVA
 *  1. ESTRUTURAL (leitura de arquivo dentro do teste, sem grep externo — morre se alguém reintroduzir):
 *     - `GoogleDocsPromptProvider.ts` não existe em lugar nenhum de `src/`;
 *     - nenhum arquivo de `src/` (inclui os `__tests__`) referencia `GoogleDocsPromptProvider`,
 *       importa o pacote `googleapis`/`@googleapis/*` ou fala com a API do Drive/Docs
 *       (`docs.googleapis.com`, `drive.googleapis.com`, `googleapis.com/drive`);
 *     - `PROMPT_DOC_ID` não aparece em `src/` nem em `.github/workflows/`.
 *     Controle positivo: o varredor enxerga arquivos de verdade (contagem > 0), enxerga
 *     `googleapis.com` onde ele legitimamente existe (Calendar/Routes) e cada regex casa com uma
 *     amostra sintética — contagem zero por varredor cego não passa.
 *  2. RUNTIME: o container da API roda SEM nenhuma variável de ambiente do Drive/Docs
 *     (`PROMPT_DOC_ID*`, nome contendo DRIVE) e mesmo assim `POST /vacancies/:id/generate-ai-content`
 *     (vaga de CUIDADOR → slug PRESCREENING_CAREGIVER) monta o prompt a partir da TABELA: o marcador
 *     gravado em `ai_prompts.body` é o que chega ao "modelo" (log `[VERTEX-STUB] systemInstruction=`).
 *  3. Custo zero: a chamada foi interceptada pelo preload (`NO REAL NETWORK CALL LEFT THIS PROCESS`)
 *     e nenhuma linha `BLOCKED` apareceu.
 *
 * O QUE ESTE TESTE NÃO PROVA
 *  - A formulação original do plano ("invalida as credenciais do Drive e confere que a geração
 *    funciona") NÃO se aplica mais: depois do corte (T051a) não existe cliente, credencial nem env var
 *    do Drive no código. Escrita ao pé da letra ela passaria de graça — por isso a prova aqui é
 *    estrutural (o código não existe) + ambiente sem variável.
 *  - Não prova qualidade da resposta do modelo: o preload devolve um JSON sintético que NÃO tem o
 *    formato de pré-triagem, então o endpoint pode terminar em erro APÓS a chamada ao modelo. O
 *    status HTTP não é asserido (só que a requisição passou de auth/rota); a prova é o que foi ENVIADO.
 *  - Não prova que nenhum OUTRO host foi acessado pelo container: o preload só intercepta Vertex e
 *    bloqueia hosts Google inesperados; tráfego a hosts não-Google não passa por ele.
 *  - Não roda sem docker: sem o container da API, `apiContainer.ts` LANÇA (nunca skip).
 *
 * Restaura a linha de `ai_prompts` no `afterAll`, incondicionalmente.
 */
import { execSync } from 'child_process';
import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth, type StaffAuth } from './helpers/staffAuth';
import { apiContainerLogs, resolveApiContainer } from './helpers/apiContainer';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5529/enlite_e2e';
process.env.DATABASE_URL = DATABASE_URL;

const SLUG = 'PRESCREENING_CAREGIVER';
const BE_ROOT = resolve(__dirname, '..', '..');
const SRC_DIR = join(BE_ROOT, 'src');
const WORKFLOWS_DIR = resolve(BE_ROOT, '..', '.github', 'workflows');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Arquivos (caminho relativo) de `dir` cujo conteúdo casa `re`. */
function filesMatching(files: string[], re: RegExp): string[] {
  return files.filter((f) => re.test(readFileSync(f, 'utf8'))).map((f) => f.replace(BE_ROOT + '/', ''));
}

const RE_PROVIDER = /GoogleDocsPromptProvider/;
const RE_GOOGLEAPIS_PKG = /(?:from\s+|require\(\s*)['"](?:googleapis|@googleapis\/[^'"]+)['"]/;
const RE_DRIVE_API = /docs\.googleapis\.com|drive\.googleapis\.com|googleapis\.com\/(?:upload\/)?drive/;
const RE_DOC_ID = /PROMPT_DOC_ID/;

describe('Pré-triagem sem Drive — a fonte do prompt é só a tabela (spec 029, T052) @integration', () => {
  describe('prova estrutural (leitura de arquivo)', () => {
    const srcFiles = walk(SRC_DIR).filter((f) => /\.(ts|js|json)$/.test(f));
    const workflowFiles = walk(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f));

    it('controle positivo: o varredor enxerga o código e as regexes casam com amostra sintética', () => {
      expect(srcFiles.length).toBeGreaterThan(200);
      expect(workflowFiles.length).toBeGreaterThan(3);
      // googleapis.com existe em src (Calendar/Routes via fetch) — varredor não está cego para o host.
      expect(filesMatching(srcFiles, /googleapis\.com/).length).toBeGreaterThan(0);
      // O serviço que lê a tabela está no conjunto varrido.
      expect(srcFiles.some((f) => f.endsWith('GeminiVacancyParserService.ts'))).toBe(true);

      expect(RE_PROVIDER.test('new GoogleDocsPromptProvider()')).toBe(true);
      expect(RE_GOOGLEAPIS_PKG.test(`import { google } from 'googleapis';`)).toBe(true);
      expect(RE_GOOGLEAPIS_PKG.test(`const g = require("@googleapis/drive")`)).toBe(true);
      expect(RE_GOOGLEAPIS_PKG.test(`import { GoogleAuth } from 'google-auth-library';`)).toBe(false);
      expect(RE_DRIVE_API.test('https://docs.googleapis.com/v1/documents/x')).toBe(true);
      expect(RE_DRIVE_API.test('https://www.googleapis.com/drive/v3/files')).toBe(true);
      expect(RE_DRIVE_API.test('https://www.googleapis.com/calendar/v3/calendars')).toBe(false);
      expect(RE_DOC_ID.test('PROMPT_DOC_ID_PRESCREENING_AT=abc')).toBe(true);
    });

    it('GoogleDocsPromptProvider.ts não existe em lugar nenhum de src/', () => {
      expect(srcFiles.filter((f) => /GoogleDocsPromptProvider/.test(f))).toEqual([]);
      expect(existsSync(join(SRC_DIR, 'modules/integration/infrastructure/GoogleDocsPromptProvider.ts'))).toBe(false);
    });

    it('nenhum arquivo de src/ referencia o provider, importa googleapis ou usa a API do Drive/Docs', () => {
      expect(filesMatching(srcFiles, RE_PROVIDER)).toEqual([]);
      expect(filesMatching(srcFiles, RE_GOOGLEAPIS_PKG)).toEqual([]);
      expect(filesMatching(srcFiles, RE_DRIVE_API)).toEqual([]);
    });

    it('PROMPT_DOC_ID não aparece em src/ nem em .github/workflows/', () => {
      expect(filesMatching(srcFiles, RE_DOC_ID)).toEqual([]);
      expect(filesMatching(workflowFiles, RE_DOC_ID)).toEqual([]);
    });
  });

  describe('runtime (container da API)', () => {
    const api = createApiClient();
    let asAdmin: StaffAuth;
    let pool: Pool;
    let jobPostingId: string;
    let originalBody: string;

    beforeAll(async () => {
      await waitForBackend(api);
      asAdmin = await staffAuth('prescreening-sem-drive-admin', 'admin');
      pool = new Pool({ connectionString: DATABASE_URL });

      const seeded = await pool.query<{ body: string }>(`SELECT body FROM ai_prompts WHERE slug = $1`, [SLUG]);
      if (seeded.rows.length === 0) {
        throw new Error(`Pré-condição ausente: ai_prompts não tem linha ${SLUG} (migration de seed não aplicada?)`);
      }
      originalBody = seeded.rows[0].body;

      const jp = await pool.query<{ id: string }>(
        `INSERT INTO job_postings (title, description, country, status, required_professions)
         VALUES ($1, 'T052 e2e — sem Drive', 'AR', 'SEARCHING', ARRAY['CUIDADOR']) RETURNING id`,
        [`T052-JP-${Date.now()}`],
      );
      jobPostingId = jp.rows[0].id;
    });

    afterAll(async () => {
      // Incondicional: afterAll roda mesmo se a asserção falhar.
      await pool.query(`UPDATE ai_prompts SET body = $1, updated_at = NOW() WHERE slug = $2`, [originalBody, SLUG]);
      await pool.query(`DELETE FROM job_postings WHERE id = $1`, [jobPostingId]).catch(() => {});
      await pool.end();
    });

    it('o container não tem nenhuma env var do Drive, o preload está ativo e o texto enviado ao modelo é o da tabela', async () => {
      // 1) ambiente do processo vivo: nenhuma variável do Drive/Docs.
      const envLines = execSync(`docker exec ${resolveApiContainer()} env`).toString().split('\n');
      expect(envLines.length).toBeGreaterThan(5); // controle: o `env` devolveu algo de verdade
      expect(envLines.filter((l) => /^PROMPT_DOC_ID|^[A-Z0-9_]*DRIVE[A-Z0-9_]*=/i.test(l))).toEqual([]);
      // a interceptação do Vertex precisa estar de pé, senão "custo zero" não está provado.
      expect(envLines.some((l) => /^NODE_OPTIONS=.*vertexInterceptPreload\.js/.test(l))).toBe(true);

      // 2) a tabela é a fonte: marcador único gravado em ai_prompts.body.
      const marker = `T052-MARKER-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await pool.query(`UPDATE ai_prompts SET body = $1, updated_at = NOW() WHERE slug = $2`, [marker, SLUG]);

      const before = apiContainerLogs();
      const res = await api.post(`/api/admin/vacancies/${jobPostingId}/generate-ai-content`, {}, asAdmin);
      // Passou de auth e de rota. O status final NÃO é asserido (o stub não devolve o formato de
      // pré-triagem — ver cabeçalho); o que vale é o que foi enviado ao modelo.
      expect([401, 403, 404]).not.toContain(res.status);

      const delta = apiContainerLogs().slice(before.length);
      expect(delta).toContain('[VERTEX-STUB] intercepted call');
      expect(delta).toContain(JSON.stringify(marker));
      // 3) custo zero: toda chamada ao modelo foi barrada no preload; nada foi bloqueado como inesperado.
      expect(delta).toContain('NO REAL NETWORK CALL LEFT THIS PROCESS');
      expect(delta).not.toContain('[VERTEX-STUB] BLOCKED');
    });
  });
});
