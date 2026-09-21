/**
 * buildZip.ts — construtor de ZIP mínimo, método STORED (sem compressão), só para FIXTURE de
 * teste (spec 022, Bloco 3, T307). Nenhuma lib de escrita de zip está instalada no projeto
 * (`yauzl` só LÊ; `file-type`/`sharp` não escrevem zip) — este helper existe para gerar, em
 * memória, um `.docx` sintético válido o bastante para `file-type` (via header LOCAL, não pelo
 * diretório central — `file-type/core.js` lê sequencialmente os headers locais) e `yauzl` (via
 * diretório central, que TAMBÉM escrevemos aqui, corretamente) reconhecerem.
 *
 * Formato STORED (method 0) escolhido de propósito: sem compressão, `compressedSize ===
 * uncompressedSize` sempre bate, sem precisar de `deflateRawSync`/CRC de fluxo comprimido.
 */
import { crc32, deflateRawSync } from 'zlib';

export interface ZipEntryInput {
  name: string;
  content: Buffer;
  /**
   * Só para fixture de ataque (spec 022, B3, conserto do gate revisao-pr): declara no header
   * (local + diretório central) um `uncompressedSize` DIFERENTE do tamanho real de `content`.
   * `yauzl` VALIDA `compressedSize === uncompressedSize` para método STORED (`index.js:412` —
   * `validateEntrySizes && compressionMethod === 0`) e recusa como zip corrompido ANTES de emitir
   * `entry` — por isso essa "mentira" só é aceita (e só então é interceptável pelo conserto, ANTES
   * de `openReadStream`) com `method: 'deflate'`, onde compressed≠uncompressed é o normal (mesmo
   * vetor real de um zip bomb: poucos bytes comprimidos que decompactam pra um tamanho gigante).
   */
  declaredUncompressedSize?: number;
  /** 'stored' (padrão, sem compressão) ou 'deflate' — necessário para poder declarar um
   *  `declaredUncompressedSize` que o `yauzl` não recuse de cara (ver doc acima). */
  method?: 'stored' | 'deflate';
}

function u16(value: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value, 0);
  return b;
}

function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value, 0);
  return b;
}

export function buildStoredZip(entries: ZipEntryInput[]): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.content) >>> 0;
    const isDeflate = entry.method === 'deflate';
    const storedBytes = isDeflate ? deflateRawSync(entry.content) : entry.content;
    const compressedSize = storedBytes.length;
    // `declaredUncompressedSize` só existe em fixture de ataque (ver doc de `ZipEntryInput`) —
    // no caminho normal é sempre `undefined` e o header declara o tamanho REAL do `content`.
    const declaredSize = entry.declaredUncompressedSize ?? entry.content.length;
    const methodField = isDeflate ? 8 : 0;

    const local = Buffer.concat([
      u32(0x04034b50), // local file header signature
      u16(20), // version needed to extract
      u16(0), // flags
      u16(methodField), // compression method: 0 = stored, 8 = deflate
      u16(0), // mod time
      u16(0), // mod date
      u32(crc),
      u32(compressedSize), // compressed size (real — tamanho dos bytes efetivamente gravados)
      u32(declaredSize), // uncompressed size — pode "mentir" em fixture de ataque (só aceito por yauzl com deflate)
      u16(nameBuf.length),
      u16(0), // extra field length
    ]);
    localChunks.push(local, nameBuf, storedBytes);

    const central = Buffer.concat([
      u32(0x02014b50), // central directory file header signature
      u16(20), // version made by
      u16(20), // version needed to extract
      u16(0), // flags
      u16(methodField),
      u16(0), // mod time
      u16(0), // mod date
      u32(crc),
      u32(compressedSize),
      u32(declaredSize),
      u16(nameBuf.length),
      u16(0), // extra field length
      u16(0), // comment length
      u16(0), // disk number start
      u16(0), // internal file attributes
      u32(0), // external file attributes
      u32(offset), // relative offset of local header
    ]);
    centralChunks.push(central, nameBuf);

    offset += local.length + nameBuf.length + storedBytes.length;
  }

  const centralDirectory = Buffer.concat(centralChunks);
  const centralOffset = offset;
  const end = Buffer.concat([
    u32(0x06054b50), // end of central directory signature
    u16(0), // disk number
    u16(0), // disk with central directory
    u16(entries.length), // entries on this disk
    u16(entries.length), // total entries
    u32(centralDirectory.length),
    u32(centralOffset),
    u16(0), // comment length
  ]);

  return Buffer.concat([...localChunks, centralDirectory, end]);
}

/** `.docx` sintético mínimo — só as entradas que os detectores olham (`file-type`/`yauzl`). */
export function buildMinimalDocx(options: { withMacro?: boolean } = {}): Buffer {
  const contentTypesXml = options.withMacro
    ? '<?xml version="1.0"?><Types xmlns="ct"><Override PartName="/word/document.xml" ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/></Types>'
    : '<?xml version="1.0"?><Types xmlns="ct"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';

  const entries: ZipEntryInput[] = [
    { name: '[Content_Types].xml', content: Buffer.from(contentTypesXml, 'utf8') },
    { name: '_rels/.rels', content: Buffer.from('<?xml version="1.0"?><Relationships xmlns="r"/>', 'utf8') },
    { name: 'word/document.xml', content: Buffer.from('<?xml version="1.0"?><w:document xmlns:w="w"><w:body/></w:document>', 'utf8') },
  ];
  if (options.withMacro) {
    entries.push({ name: 'word/vbaProject.bin', content: Buffer.from('fake-vba-project-binary-content', 'utf8') });
  }
  return buildStoredZip(entries);
}

/**
 * `.docx` cujo header MENTE sobre o `uncompressedSize` de `[Content_Types].xml` — fixture de
 * ataque (spec 022, B3, conserto do gate revisao-pr): simula um zip bomb, onde o CONTEÚDO real da
 * entrada é minúsculo mas o header declara um tamanho gigante. `readZipEntries` real confia no
 * header (nunca decodifica pra conferir) — o conserto checa `entry.uncompressedSize` ANTES de
 * `openReadStream`, então esta fixture nunca precisa de bytes de verdade gigantes.
 */
export function buildDocxWithLyingContentTypesSize(declaredUncompressedSize: number): Buffer {
  const contentTypesXml = '<?xml version="1.0"?><Types xmlns="ct"/>'; // conteúdo REAL minúsculo
  const entries: ZipEntryInput[] = [
    {
      name: '[Content_Types].xml',
      content: Buffer.from(contentTypesXml, 'utf8'),
      declaredUncompressedSize,
      method: 'deflate', // `yauzl` só aceita compressed≠uncompressed pra método deflate (ver doc de ZipEntryInput)
    },
    { name: '_rels/.rels', content: Buffer.from('<?xml version="1.0"?><Relationships xmlns="r"/>', 'utf8') },
    { name: 'word/document.xml', content: Buffer.from('<?xml version="1.0"?><w:document xmlns:w="w"><w:body/></w:document>', 'utf8') },
  ];
  return buildStoredZip(entries);
}

/**
 * `.docx` com `[Content_Types].xml` GENUÍNO (sem mentira nenhuma — `content.length === sizeBytes`
 * de verdade, padding em comentário XML) — usado para provar o limite `>` (estritamente maior,
 * não `>=`) do teto com um arquivo real, sem depender da checagem de `yauzl` sobre stream mentiroso
 * (essa só entra em jogo pra fixture de ATAQUE, ver `buildDocxWithLyingContentTypesSize`).
 */
export function buildDocxWithContentTypesXmlOfSize(sizeBytes: number): Buffer {
  const prefix = '<?xml version="1.0"?><Types xmlns="ct"><!--';
  const suffix = '--></Types>';
  const padLength = Math.max(0, sizeBytes - prefix.length - suffix.length);
  const contentTypesXml = `${prefix}${'p'.repeat(padLength)}${suffix}`;
  const entries: ZipEntryInput[] = [
    { name: '[Content_Types].xml', content: Buffer.from(contentTypesXml, 'utf8') },
    { name: '_rels/.rels', content: Buffer.from('<?xml version="1.0"?><Relationships xmlns="r"/>', 'utf8') },
    { name: 'word/document.xml', content: Buffer.from('<?xml version="1.0"?><w:document xmlns:w="w"><w:body/></w:document>', 'utf8') },
  ];
  return buildStoredZip(entries);
}
