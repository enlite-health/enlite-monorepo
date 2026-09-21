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
import { crc32 } from 'zlib';

export interface ZipEntryInput {
  name: string;
  content: Buffer;
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
    const size = entry.content.length;

    const local = Buffer.concat([
      u32(0x04034b50), // local file header signature
      u16(20), // version needed to extract
      u16(0), // flags
      u16(0), // compression method: 0 = stored
      u16(0), // mod time
      u16(0), // mod date
      u32(crc),
      u32(size), // compressed size
      u32(size), // uncompressed size
      u16(nameBuf.length),
      u16(0), // extra field length
    ]);
    localChunks.push(local, nameBuf, entry.content);

    const central = Buffer.concat([
      u32(0x02014b50), // central directory file header signature
      u16(20), // version made by
      u16(20), // version needed to extract
      u16(0), // flags
      u16(0), // compression method
      u16(0), // mod time
      u16(0), // mod date
      u32(crc),
      u32(size),
      u32(size),
      u16(nameBuf.length),
      u16(0), // extra field length
      u16(0), // comment length
      u16(0), // disk number start
      u16(0), // internal file attributes
      u32(0), // external file attributes
      u32(offset), // relative offset of local header
    ]);
    centralChunks.push(central, nameBuf);

    offset += local.length + nameBuf.length + entry.content.length;
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
