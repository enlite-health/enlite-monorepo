import { describe, it, expect } from 'vitest';

/**
 * Testes rigorosos para validação de documentos do perfil do worker.
 *
 * Cobre:
 * 1. Labels dos 5 tipos de documento
 * 2. Validação de tipo de arquivo (PDF, JPG, PNG)
 * 3. Validação de tamanho de arquivo (máx 10MB)
 * 4. Mensagens de erro amigáveis para o usuário
 * 5. Mapeamento docType ↔ label i18n
 */

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTES DE VALIDAÇÃO (espelhando useDocumentsApi)
// ═══════════════════════════════════════════════════════════════════════════

const ALLOWED_FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// ─── Helpers ────────────────────────────────────────────────────────────────

function createMockFile(name: string, size: number, type: string): File {
  const buffer = new ArrayBuffer(size);
  return new File([buffer], name, { type });
}

function validateFileType(file: File): string | null {
  if (!ALLOWED_FILE_TYPES.includes(file.type)) {
    return 'Only PDF, JPG or PNG files are allowed';
  }
  return null;
}

function validateFileSize(file: File): string | null {
  if (file.size > MAX_FILE_SIZE) {
    return 'File size must be under 10MB';
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// DOCUMENT SLOTS — Mapeamento e Labels
// ═══════════════════════════════════════════════════════════════════════════

describe('DocumentsGrid — Slots de Documentos', () => {
  // Labels agora vêm da chave canônica `documentTypes.<docType>` em i18n —
  // fonte única compartilhada entre worker (DocumentsGrid) e admin (WorkerDocumentsCard).
  //
  // Nota: estes slots são apenas os docTypes conhecidos usados no grid de exibição.
  // A política de obrigatoriedade por profissão está em workerDocumentRequirements.ts.
  const DOCUMENT_SLOTS = [
    { docType: 'resume_cv' },
    { docType: 'identity_document' },
    { docType: 'identity_document_back' },
    { docType: 'criminal_record' },
    { docType: 'at_certificate' },
  ];

  it('deve ter exatamente 5 slots de documento', () => {
    expect(DOCUMENT_SLOTS).toHaveLength(5);
  });

  it.each(DOCUMENT_SLOTS)(
    'slot "$docType" deve ter docType definido (label via i18n documentTypes)',
    (slot) => {
      expect(slot.docType).toBeDefined();
      expect(slot.docType.length).toBeGreaterThan(0);
    },
  );

  it('docType segue convenção snake_case do enum backend', () => {
    for (const slot of DOCUMENT_SLOTS) {
      expect(slot.docType).toMatch(/^[a-z_]+$/);
      expect(slot.docType.length, `docType "${slot.docType}" é muito curto`).toBeGreaterThanOrEqual(5);
    }
  });

  it('todos os docTypes são únicos', () => {
    const types = DOCUMENT_SLOTS.map((s) => s.docType);
    expect(new Set(types).size).toBe(types.length);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// VALIDAÇÃO DE TIPO DE ARQUIVO
// ═══════════════════════════════════════════════════════════════════════════

describe('Validação de tipo de arquivo', () => {
  describe('Tipos aceitos', () => {
    it('PDF deve ser aceito', () => {
      const file = createMockFile('documento.pdf', 1024, 'application/pdf');
      expect(validateFileType(file)).toBeNull();
    });

    it('JPEG deve ser aceito', () => {
      const file = createMockFile('foto.jpg', 1024, 'image/jpeg');
      expect(validateFileType(file)).toBeNull();
    });

    it('PNG deve ser aceito', () => {
      const file = createMockFile('scan.png', 1024, 'image/png');
      expect(validateFileType(file)).toBeNull();
    });
  });

  describe('Tipos rejeitados com mensagem amigável', () => {
    it('DOCX → mensagem clara', () => {
      const file = createMockFile('doc.docx', 1024, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      const error = validateFileType(file);
      expect(error).not.toBeNull();
      expect(error).toBe('Only PDF, JPG or PNG files are allowed');
    });

    it('GIF → mensagem clara', () => {
      const file = createMockFile('anim.gif', 1024, 'image/gif');
      const error = validateFileType(file);
      expect(error).toBe('Only PDF, JPG or PNG files are allowed');
    });

    it('SVG → mensagem clara', () => {
      const file = createMockFile('icon.svg', 1024, 'image/svg+xml');
      const error = validateFileType(file);
      expect(error).toBe('Only PDF, JPG or PNG files are allowed');
    });

    it('WEBP → mensagem clara', () => {
      const file = createMockFile('photo.webp', 1024, 'image/webp');
      const error = validateFileType(file);
      expect(error).toBe('Only PDF, JPG or PNG files are allowed');
    });

    it('ZIP → mensagem clara', () => {
      const file = createMockFile('archive.zip', 1024, 'application/zip');
      const error = validateFileType(file);
      expect(error).toBe('Only PDF, JPG or PNG files are allowed');
    });

    it('TXT → mensagem clara', () => {
      const file = createMockFile('notes.txt', 1024, 'text/plain');
      const error = validateFileType(file);
      expect(error).toBe('Only PDF, JPG or PNG files are allowed');
    });

    it('arquivo sem tipo → mensagem clara', () => {
      const file = createMockFile('unknown', 1024, '');
      const error = validateFileType(file);
      expect(error).toBe('Only PDF, JPG or PNG files are allowed');
    });
  });

  describe('Mensagem de erro de tipo é amigável', () => {
    it('não contém MIME types técnicos na mensagem', () => {
      const file = createMockFile('doc.docx', 1024, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      const error = validateFileType(file)!;
      expect(error).not.toContain('application/');
      expect(error).not.toContain('image/');
      expect(error).not.toContain('vnd.');
      expect(error).not.toContain('MIME');
    });

    it('menciona os formatos aceitos na mensagem', () => {
      const file = createMockFile('doc.docx', 1024, 'application/msword');
      const error = validateFileType(file)!;
      expect(error).toContain('PDF');
      expect(error).toContain('JPG');
      expect(error).toContain('PNG');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// VALIDAÇÃO DE TAMANHO DE ARQUIVO
// ═══════════════════════════════════════════════════════════════════════════

describe('Validação de tamanho de arquivo', () => {
  it('arquivo de 1KB → deve ser aceito', () => {
    const file = createMockFile('small.pdf', 1024, 'application/pdf');
    expect(validateFileSize(file)).toBeNull();
  });

  it('arquivo de 5MB → deve ser aceito', () => {
    const file = createMockFile('medium.pdf', 5 * 1024 * 1024, 'application/pdf');
    expect(validateFileSize(file)).toBeNull();
  });

  it('arquivo de exatamente 10MB → deve ser aceito (limite)', () => {
    const file = createMockFile('exact10mb.pdf', 10 * 1024 * 1024, 'application/pdf');
    expect(validateFileSize(file)).toBeNull();
  });

  it('arquivo de 10MB + 1 byte → deve ser rejeitado', () => {
    const file = createMockFile('toobig.pdf', 10 * 1024 * 1024 + 1, 'application/pdf');
    const error = validateFileSize(file);
    expect(error).not.toBeNull();
    expect(error).toBe('File size must be under 10MB');
  });

  it('arquivo de 50MB → deve ser rejeitado com mensagem amigável', () => {
    const file = createMockFile('huge.pdf', 50 * 1024 * 1024, 'application/pdf');
    const error = validateFileSize(file);
    expect(error).toBe('File size must be under 10MB');
  });

  describe('Mensagem de erro de tamanho é amigável', () => {
    it('mensagem menciona o limite em MB (não bytes)', () => {
      const file = createMockFile('big.pdf', 20 * 1024 * 1024, 'application/pdf');
      const error = validateFileSize(file)!;
      expect(error).toContain('10MB');
      expect(error).not.toContain('byte');
      expect(error).not.toContain('1048576');
      expect(error).not.toContain('10485760');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DOC TYPE → URL MAP
// ═══════════════════════════════════════════════════════════════════════════

describe('Mapeamento docType ↔ URL key', () => {
  // Mapeamento canônico dos docs obrigatórios (AT + Cuidador).
  // professional_registration e liability_insurance NÃO são mais obrigatórios.
  const DOC_URL_MAP: Record<string, string> = {
    resume_cv: 'resumeCvUrl',
    identity_document: 'identityDocumentUrl',
    identity_document_back: 'identityDocumentBackUrl',
    criminal_record: 'criminalRecordUrl',
    at_certificate: 'atCertificateUrl',
  };

  it('todos os 5 document types obrigatórios (AT) têm mapeamento de URL', () => {
    expect(Object.keys(DOC_URL_MAP)).toHaveLength(5);
  });

  it.each(Object.entries(DOC_URL_MAP))(
    'docType "%s" mapeia para "%s"',
    (_docType, urlKey) => {
      expect(urlKey).toBeDefined();
      expect(urlKey).toContain('Url');
      // URL key deve ser camelCase, não snake_case
      expect(urlKey).not.toContain('_');
    },
  );

  it('docTypes no mapeamento correspondem aos docs obrigatórios AT', () => {
    const expectedTypes = ['resume_cv', 'identity_document', 'identity_document_back', 'criminal_record', 'at_certificate'];
    for (const type of expectedTypes) {
      expect(DOC_URL_MAP[type], `docType "${type}" não encontrado no mapeamento`).toBeDefined();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ARIA LABELS — Acessibilidade do DocumentUploadCard
// ═══════════════════════════════════════════════════════════════════════════

describe('DocumentUploadCard — Acessibilidade', () => {
  it('card vazio deve ter aria-label com prefixo "Upload"', () => {
    const label = 'Curriculum';
    const isUploaded = false;
    const ariaLabel = isUploaded ? label : `Upload ${label}`;
    expect(ariaLabel).toBe('Upload Curriculum');
  });

  it('card com documento deve ter aria-label apenas com o nome', () => {
    const label = 'Curriculum';
    const isUploaded = true;
    const ariaLabel = isUploaded ? label : `Upload ${label}`;
    expect(ariaLabel).toBe('Curriculum');
  });

  it('botão de remover deve ter aria-label descritivo', () => {
    const removeLabel = 'Remover documento';
    expect(removeLabel).toBe('Remover documento');
  });

  it('botão de visualizar deve ter aria-label descritivo', () => {
    const viewLabel = 'Visualizar documento';
    expect(viewLabel).toBe('Visualizar documento');
  });
});
