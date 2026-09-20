/**
 * src/modules/identity/permissions/application/projectWorkerFields.ts
 *
 * A projeção ÚNICA dos campos de prestador — condição C3 do veredito do `lex`
 * sobre a F2. Toda rota que devolve dado de prestador passa por aqui.
 *
 * ⚠️ A REGRA QUE ESTE ARQUIVO EXISTE PARA IMPOR: a célula decide ANTES de o
 * KMS rodar.
 *
 * Hoje o caminho é o inverso — `VacancyMatchController:127`,
 * `GetFunnelTableUseCase:101` e `EncuadreMappers:8` chamam `kms.decrypt` e só
 * depois alguém pensa em quem está olhando. Com isso o texto claro do nome já
 * existiu em memória, já pôde entrar num stack trace de erro do KMS e já pôde
 * cair num log — para um ator que não tem a célula. Redigir DEPOIS de
 * descriptografar não é redigir: é esconder da tela.
 *
 * Por isso a projeção recebe os campos AINDA CIFRADOS e só chama `decrypt` no
 * ramo que a célula autoriza. A prova disso é um espião com ZERO chamadas, não
 * uma leitura do código (`__tests__/projectWorkerFields.test.ts`).
 *
 * ── Os três níveis, e por que não são graus do mesmo acesso ─────────────────
 *  · `worker:read`          id, status, ocupação, zona, etapa — nada que
 *                           identifique a pessoa
 *  · `worker_contact:read`  nome, telefone, whatsapp, e-mail — o instrumento
 *                           diário de quem recruta
 *  · `worker_pii:read`      DNI, nascimento, endereço, foto, raça, religião,
 *                           orientação sexual
 *
 * Telefone e raça não podem compartilhar chave (Ley 25.326 art. 2 e 7.3;
 * LGPD art. 6 III). Dar `worker_pii:read` a toda recrutadora para que ela veja
 * um telefone esvazia a célula: quem abre o Kanban ganha o dossiê de brinde.
 *
 * ── `cells = null` NÃO é "nenhuma célula" ───────────────────────────────────
 * É "o engine não decidiu nesta request" — família fora de
 * `PERMISSION_ENFORCED_ROUTES`, principal de serviço, engine desligado. Nesse
 * estado a projeção devolve o que a rota devolvia antes, porque o contrato do
 * rollout é que engine desligado não muda comportamento (D113). O que NÃO se
 * faz é confundir os dois: `[]` significa ator conhecido e sem nenhuma célula,
 * e aí a redação vale.
 */

import { cellKey } from '../domain/PermissionCell';

/** Só o que a projeção usa do KMS — o serviço inteiro não entra aqui. */
export interface Decryptor {
  decrypt(ciphertext: string | null | undefined): Promise<string>;
}

/** A linha CIFRADA, como sai do banco. Nada aqui já foi descriptografado. */
export interface WorkerRow {
  id?: string | null;
  status?: string | null;
  occupation?: string | null;
  workZone?: string | null;
  stage?: string | null;

  /** contato */
  firstNameEncrypted?: string | null;
  lastNameEncrypted?: string | null;
  phone?: string | null;
  whatsappPhoneEncrypted?: string | null;
  email?: string | null;

  /**
   * ⚠️ Nome em TEXTO CLARO — `encuadres.worker_raw_name`, do import legado, que
   * nunca foi cifrado. Entra aqui, e NÃO no chamador, porque senão a redação
   * seria burlada por todo card legado: um `|| row.worker_raw_name` depois da
   * projeção devolve o nome sem tocar o KMS, e por isso o espião da C3 não veria
   * nada. Fonte diferente, mesmo dado, mesmo portão — nível de CONTATO.
   */
  rawName?: string | null;

  /** dossiê */
  documentNumberEncrypted?: string | null;
  birthDateEncrypted?: string | null;
  addressEncrypted?: string | null;
  profilePhotoUrlEncrypted?: string | null;
  race?: string | null;
  religion?: string | null;
  sexualOrientation?: string | null;
}

export interface ProjectedWorker {
  id?: string | null;
  status?: string | null;
  occupation?: string | null;
  workZone?: string | null;
  stage?: string | null;
  name?: string | null;
  phone?: string | null;
  whatsappPhone?: string | null;
  email?: string | null;
  documentNumber?: string | null;
  birthDate?: string | null;
  address?: string | null;
  profilePhotoUrl?: string | null;
  race?: string | null;
  religion?: string | null;
  sexualOrientation?: string | null;
}

export const CELL_WORKER_READ = cellKey('worker', 'read');
export const CELL_WORKER_CONTACT_READ = cellKey('worker_contact', 'read');
export const CELL_WORKER_PII_READ = cellKey('worker_pii', 'read');
export const CELL_WORKER_DISABLE = cellKey('worker', 'disable');

/**
 * Nome que a tela mostra quando o ator não tem a célula de contato. NÃO é erro
 * e não é vazio: vazio some da tela e a pessoa acha que o cadastro está furado.
 */
export const NOME_REDIGIDO = 'Contato restrito';

function pode(cells: string[] | null, celula: string): boolean {
  // null = engine não decidiu aqui; o rollout exige comportamento inalterado.
  return cells === null || cells.includes(celula);
}

/**
 * Sentinela para "esta rota NÃO tem KMS e mesmo assim chegou campo cifrado" —
 * erro de PROGRAMAÇÃO, não de runtime.
 *
 * Existe porque os dois casos estavam colados e o `catch` abaixo engolia os
 * dois (achado ALTO do gate `revisao-pr`): `GET /vacancies/:id` instala um
 * decryptor que promete "falhar alto", e a promessa era letra morta — o campo
 * virava `null` em silêncio, indistinguível de redação por célula. O nome do
 * prestador sumiria do Kanban e a leitura óbvia seria "faltou permissão".
 */
export class ProjecaoSemDecryptorError extends Error {}

/**
 * `decrypt` resiliente — mas só para o que É runtime.
 *
 * ⚠️ A distinção é o conserto, não o `catch`: falha de KMS (rede, cota, chave
 * rotacionada) NÃO pode derrubar a listagem inteira, e por isso continua
 * virando `null`. Já `ProjecaoSemDecryptorError` significa que alguém passou um
 * campo `*Encrypted` para uma projeção montada sem KMS — isso não se degrada,
 * se conserta, e tem de aparecer.
 */
async function abrir(kms: Decryptor, valor: string | null | undefined): Promise<string | null> {
  if (valor === null || valor === undefined || valor === '') return null;
  try {
    return (await kms.decrypt(valor)) || null;
  } catch (err) {
    if (err instanceof ProjecaoSemDecryptorError) throw err;
    return null;
  }
}

/**
 * Projeta a linha para o que o ator PODE ver.
 *
 * O `kms` só é tocado nos ramos autorizados — é isso que o teste do espião
 * prova. Se você acrescentar campo novo aqui, ele nasce FORA de todos os ramos
 * e portanto invisível; é de propósito, para o padrão ser "declarar o nível",
 * não "esquecer e vazar".
 */
export async function projectWorkerFields(
  cells: string[] | null,
  row: WorkerRow,
  kms: Decryptor,
): Promise<ProjectedWorker> {
  const out: ProjectedWorker = {
    id: row.id ?? null,
    status: row.status ?? null,
    occupation: row.occupation ?? null,
    workZone: row.workZone ?? null,
    stage: row.stage ?? null,
  };

  if (pode(cells, CELL_WORKER_CONTACT_READ)) {
    const [primeiro, ultimo, whatsapp] = await Promise.all([
      abrir(kms, row.firstNameEncrypted),
      abrir(kms, row.lastNameEncrypted),
      abrir(kms, row.whatsappPhoneEncrypted),
    ]);
    out.name = [primeiro, ultimo].filter(Boolean).join(' ') || row.rawName || null;
    out.phone = row.phone ?? null;
    out.whatsappPhone = whatsapp;
    out.email = row.email ?? null;
  } else {
    out.name = NOME_REDIGIDO;
  }

  if (pode(cells, CELL_WORKER_PII_READ)) {
    const [documento, nascimento, endereco, foto] = await Promise.all([
      abrir(kms, row.documentNumberEncrypted),
      abrir(kms, row.birthDateEncrypted),
      abrir(kms, row.addressEncrypted),
      abrir(kms, row.profilePhotoUrlEncrypted),
    ]);
    out.documentNumber = documento;
    out.birthDate = nascimento;
    out.address = endereco;
    out.profilePhotoUrl = foto;
    out.race = row.race ?? null;
    out.religion = row.religion ?? null;
    out.sexualOrientation = row.sexualOrientation ?? null;
  }

  return out;
}
