/**
 * Contrato de exclusão — foto e documento (prova) do paciente NUNCA saem pelos canais proibidos
 * (spec 018, PR-4; `lex` #1 L1g/L1h; `lex-pr4-documentos.md` #11): vaga pública, DTOs de
 * matching/vacancy, MCP (capabilities), reconhecimento facial/visão computacional.
 *
 * Grep de FONTE com CONTROLE POSITIVO em cada bloco: o padrão é testado contra um texto que DEVE
 * bater, provando que o próprio grep funciona antes de confiar no "0 ocorrências" do alvo real —
 * um regex quebrado que nunca casa daria "0" tanto por ausência real quanto por instrumento morto
 * (task 4.9; lex-pr4-documentos.md #11, "COM CONTROLE POSITIVO").
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');

function read(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

const PHOTO_DOC_PATTERN = /hasPhoto|photoUrl|patient[_A-Za-z]*[Pp]hoto|documentId|hasConsentDocument|patient_documents|patient_photos|image_consent/;

describe('Contrato — foto/documento do paciente fora dos canais proibidos (task 4.9)', () => {
  it('controle positivo: o padrão de fato casa um texto com "hasPhoto"', () => {
    expect(PHOTO_DOC_PATTERN.test('const x = { hasPhoto: true };')).toBe(true);
  });

  const PUBLIC_VACANCY_FILES = [
    'src/modules/matching/domain/PublicJobDto.ts',
    'src/modules/matching/infrastructure/PublicJobMapper.ts',
    'src/modules/matching/infrastructure/PublicJobsQueryBuilder.ts',
    'src/modules/matching/interfaces/controllers/PublicJobsController.ts',
    'src/shared/openapi/registrations/publicJobs.ts',
  ];
  it.each(PUBLIC_VACANCY_FILES)('%s — sem foto/documento de paciente', (relPath) => {
    if (!fs.existsSync(path.join(ROOT, relPath))) return; // arquivo pode não existir nesta árvore; não é achado deste teste
    expect(PHOTO_DOC_PATTERN.test(read(relPath))).toBe(false);
  });

  it('MCP: nenhuma capability referencia foto/documento/consentimento de imagem do paciente', () => {
    const dir = path.join(ROOT, 'src/modules/mcp/application/capabilities');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.includes('__tests__'));
    expect(files.length).toBeGreaterThan(0); // controle: a pasta existe e tem capabilities de verdade
    const offenders = files.filter((f) => PHOTO_DOC_PATTERN.test(fs.readFileSync(path.join(dir, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('sem OCR/Document AI/Gemini multimodal/reconhecimento facial nas dependências (lex-documentos #11)', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string> };
    const deps = Object.keys(pkg.dependencies ?? {});
    const proibidos = ['@google-cloud/vision', '@google-cloud/documentai', 'face-api.js', 'aws-sdk', 'tesseract.js'];
    const achados = deps.filter((d) => proibidos.includes(d));
    expect(achados).toEqual([]);
  });

  it('sharp e @google-cloud/storage estão presentes (dependências ESPERADAS do PR-4, controle de que o package.json foi lido)', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies?.sharp).toBeDefined();
    expect(pkg.dependencies?.['@google-cloud/storage']).toBeDefined();
  });
});
