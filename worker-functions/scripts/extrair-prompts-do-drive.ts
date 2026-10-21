/**
 * extrair-prompts-do-drive.ts — SOMENTE LEITURA no Drive (spec 029, T047).
 *
 * Exporta os dois prompts de preselección (hoje em Google Docs) para arquivos de texto, para
 * que a migration de seed (T049) e a conferência do banco (T050, conferir-seed-prompt.ts)
 * partam do MESMO texto. Mesmo caminho que o antigo `GoogleDocsPromptProvider` usava (apagado no
 * corte T051a; hoje o serviço lê de `ai_prompts`): export `text/plain` da Drive API, escopo
 * `drive.readonly`. Script mantido como registro/ferramenta de conferência da origem no Drive.
 *
 * Uso:
 *   npx tsx scripts/extrair-prompts-do-drive.ts --out /tmp/prompts-drive/ --min-chars 500 \
 *     --exigir-marcador 'Regla'
 *
 * IDs dos documentos: env PROMPT_DOC_ID_AT e PROMPT_DOC_ID_CUIDADOR (as mesmas do Cloud Run).
 * Credencial: ADC (GoogleAuth) — ou, fora do Cloud Run, `DRIVE_ACCESS_TOKEN` com um token
 * de acesso já emitido (ex.: `gcloud auth print-access-token --impersonate-service-account=...`).
 *
 * NORMALIZAÇÃO CANÔNICA (nesta ordem): 1) remover o BOM (U+FEFF) · 2) converter CRLF e CR solto em LF ·
 * 3) `.trim()`. A MESMA transformação é aplicada na extração, na migration 491 e na conferência
 * (conferir-seed-prompt.ts, que importa `normalizar` daqui). Por quê a etapa 2: a 491 seria a única
 * migration com CRLF do repo, sem `.gitattributes` que a proteja — qualquer editor/config que normalize
 * quebraria a conferência; para o modelo LF × CRLF é indiferente. O hash do texto CRU (antes de
 * normalizar) também é impresso, para a cadeia ser auditável (evidencias/hashes-origem.txt).
 * Nunca grava o BOM: ele seria um caractere invisível no editor da tela.
 *
 * VALIDAÇÃO (falha com código ≠ 0): arquivo com menos de `--min-chars` OU sem o marcador
 * `--exigir-marcador`. Razão: sem isso, uma página de erro do Drive gravada como texto passaria
 * por conteúdo válido — e o hash da T050 bateria com o banco, aprovando o prompt errado.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GoogleAuth } from 'google-auth-library';

export interface DocumentoAlvo {
  arquivo: string;
  envDocId: string;
}

export const DOCUMENTOS: readonly DocumentoAlvo[] = [
  { arquivo: 'PRESCREENING_AT.txt', envDocId: 'PROMPT_DOC_ID_AT' },
  { arquivo: 'PRESCREENING_CAREGIVER.txt', envDocId: 'PROMPT_DOC_ID_CUIDADOR' },
];

export interface Opcoes {
  out: string;
  minChars: number;
  marcador: string;
}

/** Normalização canônica: remove BOM → CRLF/CR em LF → `.trim()`. Ver o comentário do topo. */
export function normalizar(bruto: string): string {
  return bruto.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
}

export function sha256(texto: string): string {
  return createHash('sha256').update(texto, 'utf8').digest('hex');
}

/** Devolve a lista de motivos de reprovação (vazia = válido). Pura: testável sem rede. */
export function validarConteudo(arquivo: string, texto: string, minChars: number, marcador: string): string[] {
  const motivos: string[] = [];
  if (texto.length < minChars) {
    motivos.push(`${arquivo}: ${texto.length} chars < mínimo ${minChars}`);
  }
  if (!texto.includes(marcador)) {
    motivos.push(`${arquivo}: marcador '${marcador}' ausente`);
  }
  return motivos;
}

export function lerArgumentos(argv: string[]): Opcoes {
  const valor = (flag: string): string => {
    const i = argv.indexOf(flag);
    const v = i === -1 ? undefined : argv[i + 1];
    if (!v || v.startsWith('--')) throw new Error(`${flag} é obrigatório e exige um valor`);
    return v;
  };
  const minChars = Number(valor('--min-chars'));
  if (!Number.isInteger(minChars) || minChars < 0) {
    throw new Error('--min-chars deve ser um inteiro >= 0');
  }
  return { out: valor('--out'), minChars, marcador: valor('--exigir-marcador') };
}

/** Bytes CRUS do export (com BOM, se houver): `fetch().text()` descartaria o BOM e falsearia o hash cru. */
async function exportarTextoPuro(docId: string): Promise<Buffer> {
  const url = `https://www.googleapis.com/drive/v3/files/${docId}/export?mimeType=text/plain`;
  const token = process.env.DRIVE_ACCESS_TOKEN;
  if (token) {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) throw new Error(`Drive respondeu HTTP ${resp.status} (doc ${docId})`);
    return Buffer.from(await resp.arrayBuffer());
  }
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
  const client = await auth.getClient();
  const resp = await client.request<ArrayBuffer>({ url, responseType: 'arraybuffer' });
  return Buffer.from(resp.data);
}

async function main(): Promise<void> {
  const opcoes = lerArgumentos(process.argv);
  mkdirSync(opcoes.out, { recursive: true });

  const motivos: string[] = [];
  for (const doc of DOCUMENTOS) {
    const docId = process.env[doc.envDocId];
    if (!docId) throw new Error(`env ${doc.envDocId} não definida`);
    const bytesCrus = await exportarTextoPuro(docId);
    const texto = normalizar(bytesCrus.toString('utf8'));
    const caminho = join(opcoes.out, doc.arquivo);
    writeFileSync(caminho, texto, 'utf8');
    console.log(`${doc.arquivo}: ${Buffer.byteLength(texto, 'utf8')} bytes · ${texto.length} chars · sha256 cru ${createHash('sha256').update(bytesCrus).digest('hex')} · sha256 normalizado ${sha256(texto)}`);
    motivos.push(...validarConteudo(doc.arquivo, texto, opcoes.minChars, opcoes.marcador));
  }

  if (motivos.length > 0) {
    console.error('FALHOU — conteúdo inválido:');
    motivos.forEach((m) => console.error(`  ${m}`));
    process.exit(1);
  }
  console.log('OK — todos os arquivos passaram na validação');
}

/* istanbul ignore next -- entrypoint do CLI: só roda fora de teste (require.main === module) */
if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
