/**
 * conferir-seed-prompt.ts — SOMENTE LEITURA no banco (nenhum INSERT/UPDATE/DELETE).
 *
 * Prova que `ai_prompts.body` para um slug é IDÊNTICO, byte a byte, à origem canônica desse
 * prompt (spec 029, T017/T050):
 *   - `VACANCY_DESCRIPTION` → a constante `DESCRIPTION_SYSTEM_PROMPT` do código
 *     (`talentumDescriptionHelpers.ts`), importada diretamente — nunca transcrita à mão aqui,
 *     para não reintroduzir o mesmo risco de divergência que este script existe para pegar.
 *   - `PRESCREENING_AT` / `PRESCREENING_CAREGIVER` não têm constante de código (vêm do Drive,
 *     T047/T049) — exigem `--origem <arquivo>` com o texto extraído.
 *
 * Por que resumo criptográfico (SHA-256) em vez de comparar string e dizer só "igual/diferente":
 * é o que o aceite de T017/T050 pede ("imprime os dois resumos"), e permite colar em evidência
 * sem reproduzir milhares de caracteres do prompt inteiro — com a mesma força de prova (SHA-256
 * não tem colisão prática conhecida: hash igual ⇒ conteúdo igual, byte a byte).
 *
 * Uso:
 *   npx tsx scripts/conferir-seed-prompt.ts VACANCY_DESCRIPTION
 *   npx tsx scripts/conferir-seed-prompt.ts PRESCREENING_AT --origem /tmp/prompts-drive/PRESCREENING_AT.txt
 *
 * Saída: linha `IGUAIS` + código de saída 0 quando os resumos batem. `DIFERENTES` + código 1
 * quando não batem — sem a palavra `IGUAIS` nesse caminho, para que nenhuma leitura automatizada
 * (grep, CI) confunda os dois desfechos.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { AI_PROMPT_SLUGS, isAiPromptSlug, type AiPromptSlug } from '../src/modules/integration/domain/AiPromptSlug';
import { normalizar } from './extrair-prompts-do-drive';
import { DESCRIPTION_SYSTEM_PROMPT } from '../src/modules/integration/infrastructure/talentumDescriptionHelpers';

/**
 * Origem canônica de cada slug que ainda vive em constante de código. Os demais (hoje,
 * PRESCREENING_AT e PRESCREENING_CAREGIVER — Fase 6/T049-T050) não entram aqui: exigem
 * `--origem` porque a fonte deles é um documento do Drive, não algo importável.
 */
const CODE_CONSTANTS: Partial<Record<AiPromptSlug, string>> = {
  VACANCY_DESCRIPTION: DESCRIPTION_SYSTEM_PROMPT,
};

function sha256(texto: string): string {
  return createHash('sha256').update(texto, 'utf8').digest('hex');
}

function lerArgumentos(argv: string[]): { slug: AiPromptSlug; origemPath: string | null } {
  const slugArg = argv[2];
  if (!slugArg || !isAiPromptSlug(slugArg)) {
    throw new Error(
      `slug obrigatório, um de: ${AI_PROMPT_SLUGS.join(', ')}. Recebido: ${slugArg ?? '(nenhum)'}`,
    );
  }
  const origemIdx = argv.indexOf('--origem');
  const origemPath = origemIdx !== -1 ? argv[origemIdx + 1] ?? null : null;
  if (origemIdx !== -1 && !origemPath) {
    throw new Error('--origem exige um caminho de arquivo logo em seguida');
  }
  return { slug: slugArg, origemPath };
}

function resolverOrigem(slug: AiPromptSlug, origemPath: string | null): { texto: string; rotulo: string } {
  if (origemPath) {
    // Mesma normalização canônica da extração (BOM → CRLF em LF → trim): origem e banco comparam iguais.
    return { texto: normalizar(readFileSync(origemPath, 'utf8')), rotulo: `arquivo normalizado (${origemPath})` };
  }
  const constante = CODE_CONSTANTS[slug];
  if (constante !== undefined) {
    return { texto: constante, rotulo: 'constante de código (talentumDescriptionHelpers.ts)' };
  }
  throw new Error(
    `${slug} não tem constante de código conhecida — passe --origem <arquivo> ` +
      '(ex.: T050, conteúdo extraído do Drive por scripts/extrair-prompts-do-drive.ts).',
  );
}

async function lerBanco(slug: AiPromptSlug): Promise<string> {
  const DATABASE_URL =
    process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
  const db = new Pool({ connectionString: DATABASE_URL });
  try {
    const { rows } = await db.query<{ body: string }>('SELECT body FROM ai_prompts WHERE slug = $1', [slug]);
    if (rows.length === 0) {
      throw new Error(`nenhuma linha em ai_prompts para slug='${slug}' — rode a migration de seed primeiro.`);
    }
    return rows[0].body;
  } finally {
    await db.end();
  }
}

async function main(): Promise<void> {
  const { slug, origemPath } = lerArgumentos(process.argv);
  const origem = resolverOrigem(slug, origemPath);
  const bancoTexto = await lerBanco(slug);

  const hashOrigem = sha256(origem.texto);
  const hashBanco = sha256(bancoTexto);

  console.log(`slug: ${slug}`);
  console.log(`origem (${origem.rotulo}): ${hashOrigem}`);
  console.log(`banco  (ai_prompts.body):  ${hashBanco}`);

  if (hashOrigem === hashBanco) {
    console.log('IGUAIS');
    process.exit(0);
  }

  // Divergiu: localizar o primeiro ponto de diferença sem colar os dois textos inteiros no log
  // (prompt de sistema, não dado clínico de paciente — mas ainda assim não há motivo para
  // despejar milhares de caracteres numa evidência).
  console.log('DIFERENTES');
  console.log(`  tamanho origem: ${origem.texto.length} · tamanho banco: ${bancoTexto.length}`);
  const max = Math.min(origem.texto.length, bancoTexto.length);
  let i = 0;
  while (i < max && origem.texto[i] === bancoTexto[i]) i++;
  console.log(`  primeira diferença no índice ${i}`);
  console.log(`    origem: ${JSON.stringify(origem.texto.slice(Math.max(0, i - 20), i + 20))}`);
  console.log(`    banco : ${JSON.stringify(bancoTexto.slice(Math.max(0, i - 20), i + 20))}`);
  process.exit(1);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
