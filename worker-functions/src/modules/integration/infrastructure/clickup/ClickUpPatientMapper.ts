import type { PatientServiceUpsertInput } from '@modules/case';
import type { PatientResponsibleInput } from '@modules/case';
import { sourceLabelsRead, sourceLabelsUnreadable } from '@modules/case';
import type { PatientSourceLabelsRead } from '@modules/case';
import type { PatientAddress, PatientProfessional } from '../../../../infrastructure/repositories/PatientRepository';
import { ClickUpFieldResolver } from './ClickUpFieldResolver';
import type { ClickUpTask, ClickUpTaskCustomField } from './ClickUpTask';
import {
  mapClickUpDependencyLevel,
  mapClickUpSex,
  mapClickUpDocumentType,
  mapClickUpRelationship,
  mapClickUpClinicalSpecialty,
  mapClickUpService,
} from './mappings';
import { mapClickUpVacancyStatus } from './mappings/vacancyStatusMap';
import {
  extractStateFromLocation,
  extractStateFromLocationStrict,
  extractCityFromLocation,
  extractCityFromLocationStrict,
  extractNeighborhood,
  extractNeighborhoodFromLocation,
} from './helpers/locationHelpers';
import { normalizeProvince, stripPostalCodePrefix } from '@shared/utils/argentinaLocationNormalizer';
import { asIndexable } from './helpers/asIndexable';
import {
  assertReadableDropdownFields,
  normalizeExpectation,
  type CatalogFieldExpectation,
} from './helpers/dropdownCatalogGuard';
import { resolveCatalogValue, CATALOG_TYPES_SUPPORTED } from './helpers/resolveCatalogValue';

type CustomFieldMap = Record<string, unknown>;

/**
 * Uma leitura crua de campo de catálogo, pronta para `PatientSourceLabelRepository`.
 * `fieldName` é o nome NA ORIGEM — metadado de schema, nunca valor de paciente.
 */
export interface ClickUpSourceLabelRead {
  fieldName: string;
  read: PatientSourceLabelsRead;
}

/**
 * Every drop_down field this mapper asks ClickUp for, by the name it asks for.
 *
 * Task 1.11: before mapping anything, the catalog is asked whether each of these still
 * exists as a drop_down (`assertReadableDropdownFields`). A field renamed or deleted in
 * ClickUp makes `cf['<old name>']` undefined, `asIndexable` return null SILENTLY (that
 * null is legitimate for the 1424 of 1690 tasks that simply have no value), and the
 * `UPDATE` erase what was stored. Reading the catalog is what tells the two nulls apart.
 *
 * Drift guard: `tests/unit/__tests__/clickup-1.11-campo-renomeado.test.ts` reads this file and
 * fails if any dropdown resolved below names a field that is missing from this list.
 */
export const PATIENT_CATALOG_FIELDS: readonly CatalogFieldExpectation[] = [
  'Dependencia',
  'Sexo Asignado al Nacer (Uso Clínico)',
  'Tipo de Documento Paciente',
  // ⚠️ O ÚNICO campo com DOIS tipos aceitos, e isto é uma decisão, não folga.
  // D-C da change `campos-admissao`: a Fase 2 transforma `Segmentos Clínicos` em MÚLTIPLO,
  // o que no ClickUp significa trocar o tipo do campo de `drop_down` para `labels`. Com a
  // lista antiga (só `drop_down` para todo mundo), o dia dessa virada — que é o plano
  // declarado desta fase, não um acidente — fazia o preflight marcar `wrong_type` e o sync
  // de pacientes PARAR INTEIRO, mudo na origem. Medido pelo QA-caça da 2.2 (defeito 1).
  // Declarar os dois só é legítimo porque o leitor sabe ler os dois: `resolveCatalogValue`
  // despacha pelo tipo VIVO do catálogo. Sem esse par, isto seria abrir a porta para o
  // `null` de "não consegui ler" apagar dado (D167/F41).
  { field: 'Segmentos Clínicos', accepts: CATALOG_TYPES_SUPPORTED },
  // Task 3.2 — `Cobertura Verificada` passa a ser LIDA. Ela é `labels` com 33 opções no
  // catálogo vivo, e o mapper nunca a leu (F7): 345 de 349 pacientes têm cobertura no
  // ClickUp e o nosso banco tem ZERO. É a maior lacuna medida da change.
  // Declarada com os DOIS tipos pela mesma razão do segmento: quem declara que sabe ler os
  // dois formatos tem de ler os dois, e `resolveCatalogValue` despacha pelo tipo VIVO.
  { field: 'Cobertura Verificada', accepts: CATALOG_TYPES_SUPPORTED },
  // Task 4.2 — `Tipo de Dispositivo` passa a ser LIDO. Medido: **253 de 349** pacientes o têm
  // preenchido no ClickUp e o nosso banco tem **0 de 408** (F35/F64). O mapper nunca o leu —
  // `grep -rn "Dispositivo"` no `src/` não achava uma linha aqui.
  // Declarado com os DOIS tipos pela mesma razão do segmento e da cobertura: quem declara que
  // sabe ler os dois formatos tem de ler os dois, e `resolveCatalogValue` despacha pelo tipo
  // VIVO do catálogo. Sem o par, o dia em que a operação virar o campo para `labels` faria o
  // preflight marcar `wrong_type` e PARAR o sync inteiro.
  { field: 'Tipo de Dispositivo', accepts: CATALOG_TYPES_SUPPORTED },
  'Servicio',
  'Relación con el Paciente',
  'Tipo de Documento Responsable',
  // Task 1.12: o 8º. É `drop_down` vivo no catálogo e o mapper depende dele
  // (`buildProfessionals` → `isTeam`), mas ele NÃO é lido por `resolveDropdown` — e por isso
  // escapou da lista quando ela foi escrita à mão na 1.11. A trava de deriva desta task passou
  // a ser dirigida pelo CATÁLOGO (que tipo o campo tem), não pela função que o lê.
  'Equipo Tratante Multidisciplinario',
];

/**
 * Só os NOMES dos campos acima, derivados — nunca escritos duas vezes. Duas listas à mão
 * divergem em silêncio, que é o F20/F49/F51 desta casa. Consumido pelo controller
 * (`declaredFields` do refresher) e pelas travas de deriva das tasks 1.11/1.12.
 */
/**
 * Campos que ficam no preflight mas NÃO são persistidos no cru genérico — C-H do parecer do
 * `lex` da Fase 3.
 *
 * ── O efeito colateral que esta lista fecha ─────────────────────────────────
 * `PATIENT_CATALOG_FIELDS` tem DOIS consumidores: `assertReadableDropdownFields` (o preflight
 * fail-closed da 1.11) e `readSourceLabels` (a persistência do cru da 2.3). Declarar
 * `Cobertura Verificada` para o primeiro — que era o necessário — inscreveu o campo no segundo
 * de brinde, sem que ninguém decidisse. Resultado não declarado em nenhuma task da Fase 3:
 * a mesma cobertura passava a viver em DUAS tabelas, com regras diferentes.
 *
 * ── Por que a cobertura sai daqui, e não a tabela específica ────────────────
 * `patient_insurance_verified` (migration 285) é a fonte da cobertura, e é a forma certa:
 * **sem teto**, porque o limite é o catálogo de 33 opções. `patient_source_labels` tem
 * **teto 3** por campo (D-C, decisão sobre segmento clínico). Manter as duas significaria uma
 * cobertura truncada no 4º valor numa tabela e íntegra na outra — divergência silenciosa entre
 * duas cópias do mesmo dado. Hoje a folga é 1 (F34: máximo 2 valores observados), então nada
 * trunca; guardar duas cópias esperando a folga acabar é o oposto de desenhar.
 *
 * E há o argumento legal, que é o mais forte: art. 4º inc. 1 da Ley 25.326 exige dado
 * *"no excesivo en relación a la finalidad"*. Duas cópias da mesma cobertura, com ciclos de
 * vida distintos, é excesso por construção — não por volume, por governança.
 *
 * ⚠️ O campo CONTINUA em `PATIENT_CATALOG_FIELDS`: sair de lá o tiraria do preflight, e aí
 * renomeá-lo no ClickUp voltaria a gravar `null` em silêncio. Preflight e persistência são
 * perguntas diferentes, e esta lista é o que as separa.
 */
export const PATIENT_FIELDS_SEM_CRU_GENERICO: readonly string[] = [
  'Cobertura Verificada',
  // Task 4.2, pela MESMA razão da cobertura: `patient_device_types` (migration 287) é a fonte
  // do conjunto, com FK para o catálogo. Deixar o campo também no cru genérico criaria duas
  // cópias com regras diferentes — e aqui seria pior que na cobertura, porque o cru guarda o
  // rótulo em espanhol e a tabela guarda o CÓDIGO em inglês: duas cópias que nem se parecem.
  // ⚠️ O que VAI para `patient_source_labels` é só a QUARENTENA do que o ConceptMap não
  // traduziu (`source = 'clickup-quarentena'`), escrita pelo `PatientDeviceTypeRepository`.
  // Isso não é uma segunda cópia: é o que não coube na primeira.
  'Tipo de Dispositivo',
];

export const PATIENT_DROPDOWN_FIELDS: readonly string[] =
  PATIENT_CATALOG_FIELDS.map(f => normalizeExpectation(f).field);

/**
 * ClickUpPatientMapper — converts a ClickUp task from "Estado de Pacientes" list
 * into a PatientServiceUpsertInput ready for PatientService.upsertFromClickUp().
 *
 * Mapping strategy:
 *   - Drop-down fields → resolved via ClickUpFieldResolver (orderindex → label)
 *   - Labels fields    → resolved via ClickUpFieldResolver (uuid → label)
 *   - Text/number/date → value used directly from custom_fields[].value
 *   - Unknown drop-down labels → null (never persist raw external values)
 */
export class ClickUpPatientMapper {
  constructor(private readonly resolver: ClickUpFieldResolver) {}

  /**
   * Nomes de custom field que o mapper PEDIU na última chamada de `map()` — pedidos, não
   * encontrados: um nome que não existe no catálogo é registrado do mesmo jeito, e é
   * exatamente esse o caso que interessa. Alimentado pelo `Proxy` de `buildCustomFieldMap`.
   */
  private readonly requestedFieldNames = new Set<string>();

  /** Leitura da anotação acima. Usado pela trava de deriva da task 1.12. */
  getRequestedFieldNames(): readonly string[] {
    return [...this.requestedFieldNames];
  }

  /**
   * Task 1.13b — QUEM PERGUNTA é quem sabe responder "este campo importa ao mapper?".
   *
   * O harvester da 1.12 (o `Proxy` de `buildCustomFieldMap`) já anota o nome de CADA leitura,
   * inclusive nome vindo de variável ou de laço. O que faltava era poder consultá-lo ANTES de
   * decidir escrever. Isto roda a mesma varredura de `map()` só para colher os nomes: não
   * escreve nada, não faz rede, e o resultado é DESCARTADO.
   *
   * Por que uma varredura de verdade, e não uma lista: lista escrita à mão nasce desatualizada
   * (F20/F49/F51) — foi assim que `Equipo Tratante Multidisciplinario` escapou da 1.11. Aqui o
   * conjunto é o que o código ACABOU de ler, para ESTA tarefa.
   *
   * Dois cuidados:
   *   - `status` é zerado na cópia para que o `console.warn` de status desconhecido, que carrega
   *     `task.id`, NÃO seja emitido por causa da sonda (C1 do parecer do `lex`: `task.id` é
   *     proibido na linha). A cópia é rasa e `status` não é custom field: nenhuma leitura muda.
   *   - `map()` pode lançar antes da varredura (o preflight da 1.11 roda primeiro). Nesse caso o
   *     conjunto volta VAZIO — e vazio significa "não sei", nunca "nada importa". Quem decide
   *     trata a contagem zero como falha (F19).
   *
   * LIMITE DECLARADO: `extractCaseNumber` lê `task.custom_fields` direto, sem passar pelo mapa,
   * então `Caso Número` não aparece aqui. Não é buraco desta decisão: aquele campo é lido da
   * TAREFA por nome, não do catálogo — recarregar o catálogo não muda nada para ele.
   */
  fieldNamesReadFor(task: ClickUpTask): readonly string[] {
    const semStatus: ClickUpTask = { ...task, status: { ...task.status, status: '' } };
    try {
      this.map(semStatus);
    } catch {
      // Deliberadamente silencioso: a sonda não decide nada sozinha, e o erro que importa
      // (campo ilegível) já é gritado por `assertReadableDropdownFields` no caminho real.
    }
    return this.getRequestedFieldNames();
  }

  /**
   * Task 2.3 — as LEITURAS CRUAS dos campos de catálogo, para persistir o rótulo literal ao
   * lado do derivado (D-B). Uma entrada por campo de `PATIENT_CATALOG_FIELDS`, na ordem em
   * que eles estão declarados.
   *
   * ── Por que TODOS os 8, e não só `Segmentos Clínicos` ───────────────────────
   * A task 2.2 absorveu a antiga 1.4 e trouxe a generalidade junto: o cru é persistido para
   * TODO mapa blindado na 1.3. Restringir a segmento deixaria os outros 7 exatamente como
   * estavam — derivado gravado, literal perdido —, que é a perda que esta fase existe para
   * fechar. O teto de 3 e a recusa registrada valem por campo, não por paciente.
   *
   * ── Por que uma passada PRÓPRIA, e não a de `map()` ─────────────────────────
   * `map()` deriva com `resolveDropdown` desde antes desta change e é o caminho vivo de 1978
   * testes. Reescrevê-lo para derivar A PARTIR daqui mudaria o comportamento de 7 campos numa
   * task cujo critério é o 8º — e a régua de FORMA não pegaria (D155). Esta passada é
   * ADITIVA: `map()` continua byte a byte o que era, e o cru sai daqui.
   *
   * O custo é resolver duas vezes o mesmo campo. É busca em `Record` já carregado, sem rede e
   * sem banco, e `resolveCatalogValue` é pura: mesma entrada, mesma saída. O que NÃO se pode
   * pagar duas vezes é o AVISO — por isso `warn: false`. O caminho vivo já gritou; dois avisos
   * para o mesmo fato é ruído, e ruído desliga alarme (critério 9.4).
   *
   * ── O que esta função NÃO faz, de propósito ─────────────────────────────────
   * Não decide o que gravar. Devolve `readable:false` quando a origem mandou valor que o
   * catálogo não traduziu — e quem recebe isso não escreve e não apaga (D167/F41). Traduzir
   * ilegível em lista vazia aqui seria reabrir o apagamento pela porta que a 2.2 fechou.
   *
   * ⚠️ Roda DEPOIS do preflight, como `map()`: se um campo sumiu do catálogo,
   * `assertReadableDropdownFields` lança e nada disto é alcançado — o sync inteiro para, que
   * é o comportamento da 1.11 e é o correto.
   */
  readSourceLabels(task: ClickUpTask): ClickUpSourceLabelRead[] {
    assertReadableDropdownFields(this.resolver, PATIENT_CATALOG_FIELDS, 'ClickUpPatientMapper');

    const cf = this.buildCustomFieldMap(task.custom_fields);

    return PATIENT_CATALOG_FIELDS
      .filter(e => !PATIENT_FIELDS_SEM_CRU_GENERICO.includes(normalizeExpectation(e).field))
      .map(expectation => {
      const { field } = normalizeExpectation(expectation);
      const leitura = resolveCatalogValue(this.resolver, field, cf[field], { warn: false });
      return {
        fieldName: field,
        read: leitura.readable
          ? sourceLabelsRead(leitura.labels)
          : sourceLabelsUnreadable(leitura.reason),
      };
    });
  }

  /**
   * Converts a ClickUp task to PatientServiceUpsertInput.
   * Returns null if the task has no usable patient data (no first or last name).
   */
  map(task: ClickUpTask): PatientServiceUpsertInput | null {
    // Fail closed BEFORE deriving anything: a drop_down field that the catalog no longer
    // knows resolves to null for EVERY task, and that null is written over stored data.
    // Throws ClickUpUnreadableFieldError — SyncPatientFromClickUpTaskUseCase turns it into
    // kind='ERROR' + clickup_patient_sync.error and writes nothing. (Task 1.11; NOT COALESCE,
    // which D-E forbids: a legitimately empty field keeps writing its emptiness, below.)
    assertReadableDropdownFields(this.resolver, PATIENT_CATALOG_FIELDS, 'ClickUpPatientMapper');

    const cf = this.buildCustomFieldMap(task.custom_fields);

    // Identity: prefer custom fields; fall back to parsing task.name when empty.
    // Many ClickUp tasks carry the patient name only in the title (e.g. "Castillo, Priscila"
    // or "BUZZALINO, ANA - Caso 644" or "Falieres, Candela (Cod 433)").
    let firstName = this.asString(cf['Nombre de Paciente']);
    let lastName  = this.asString(cf['Apellido del Paciente']);

    if (!firstName && !lastName) {
      const parsed = this.parseNameFromTitle(task.name);
      if (parsed) {
        firstName = parsed.firstName;
        lastName  = parsed.lastName;
      }
    }

    if (!firstName && !lastName) return null;

    const dependencyLabel    = this.resolver.resolveDropdown('Dependencia', asIndexable('Dependencia', cf['Dependencia']));
    const sexLabel           = this.resolver.resolveDropdown('Sexo Asignado al Nacer (Uso Clínico)', asIndexable('Sexo Asignado al Nacer (Uso Clínico)', cf['Sexo Asignado al Nacer (Uso Clínico)']));
    const docTypeLabel       = this.resolver.resolveDropdown('Tipo de Documento Paciente', asIndexable('Tipo de Documento Paciente', cf['Tipo de Documento Paciente']));
    // `Segmentos Clínicos` é lido PELO TIPO VIVO do catálogo (defeito 1 do QA-caça da 2.2):
    // `drop_down` hoje, `labels` a partir da virada da Fase 2 (D-C). O derivado da D-B segue
    // sendo UM valor — no mundo `drop_down` a lista tem no máximo 1 item, então o
    // comportamento de hoje é idêntico, byte a byte.
    // LIMITE DECLARADO para o mundo múltiplo: o derivado vem do PRIMEIRO rótulo, sem escolher
    // o "melhor". Escolher o primeiro que mapeia esconderia um rótulo desconhecido justamente
    // quando ele é a novidade que a D-A manda gritar. Hoje isso não é ambíguo: F36 mediu 263
    // pacientes com 1 valor e ZERO com 2+ (reconferido na 2.1). Quando aparecer o primeiro
    // paciente com 2+, o critério de ORDEM é decisão de produto e já está sinalizado na 2.1.
    const segmentoRead       = resolveCatalogValue(this.resolver, 'Segmentos Clínicos', cf['Segmentos Clínicos']);
    // ⚠️ `specialtyLabel` sozinho não distingue os dois nulos, e essa confusão APAGAVA dado.
    // `segmentoRead` já sabe a diferença (é o que a 2.2 construiu para o CRU); o que faltava era
    // levá-la também ao DERIVADO. Ver `PatientClinicalRepository.clinicalSpecialtyReadable`.
    const specialtyLabel     = segmentoRead.readable ? (segmentoRead.labels[0] ?? null) : null;
    const specialtyReadable  = segmentoRead.readable;
    // Task 3.2 — a cobertura VERIFICADA, múltipla (D-D). Mesma leitura do segmento: pelo tipo
    // vivo do catálogo, com a distinção entre "vazio de verdade" e "não consegui ler" (D167).
    // ⚠️ Não confundir com `Cobertura Informada ` (com ESPAÇO no fim, F15), que é texto livre
    // digitado pela família e segue em `healthInsuranceName`, agora DEPRECADO.
    const coberturaRead      = resolveCatalogValue(this.resolver, 'Cobertura Verificada', cf['Cobertura Verificada']);
    // Task 4.2 — o `Tipo de Dispositivo`, múltiplo (5 opções no catálogo vivo). Mesma leitura
    // da cobertura: pelo tipo VIVO, preservando a distinção entre "vazio de verdade" e "não
    // consegui ler" (D167). O escalar `patients.device_type` NÃO é escrito por aqui: ele é
    // derivado da tabela do conjunto por trigger (migration 290 / F64).
    const dispositivoRead    = resolveCatalogValue(this.resolver, 'Tipo de Dispositivo', cf['Tipo de Dispositivo']);
    const serviceLabel       = this.resolver.resolveDropdown('Servicio', asIndexable('Servicio', cf['Servicio']));

    const serviceTypes = mapClickUpService(serviceLabel);

    // Derive patient status from ClickUp task status.
    // task.status.status is the raw ClickUp label (lowercase, e.g. "busqueda", "admisión").
    // mapClickUpVacancyStatus handles whitespace trimming and lowercasing internally.
    const statusRaw      = task.status?.status;
    const statusMapping  = mapClickUpVacancyStatus(statusRaw);
    const patientStatus  = statusMapping?.patientStatus ?? null;
    if (statusRaw && !statusMapping) {
      // Unknown ClickUp status — ops may have added a new value. Log it so it can be mapped.
      console.warn('[ClickUpPatientMapper] Unknown ClickUp status:', { statusRaw, taskId: task.id });
    }

    const input: PatientServiceUpsertInput = {
      clickupTaskId:      task.id,
      firstName:          firstName ?? '',
      lastName:           lastName  ?? '',
      birthDate:          this.parseClickUpDate(cf['Fecha de Nacimiento']),
      documentType:       mapClickUpDocumentType(docTypeLabel),
      documentNumber:     this.asString(cf['Número de Documento Paciente']),
      sex:                mapClickUpSex(sexLabel),
      phoneWhatsapp:      this.cleanPhone(this.asString(cf['Número de WhatsApp Paciente'])),
      hasCud:             this.parseClickUpBoolean(cf['Posee CUD']),
      hasConsent:         this.parseClickUpBoolean(cf['Consentimiento']),
      hasJudicialProtection: this.parseClickUpBoolean(cf['Amparo Judicial']),
      country:            'AR',

      // Clinical
      diagnosis:          this.asString(cf['Diagnóstico (si lo conoce)']),
      dependencyLevel:    mapClickUpDependencyLevel(dependencyLabel),
      clinicalSpecialty:  mapClickUpClinicalSpecialty(specialtyLabel),
      clinicalSpecialtyReadable: specialtyReadable,
      // Task 3.2/3.3 — o escalar CONTINUA sendo escrito (o 1º rótulo), exatamente como o
      // derivado da D-B na Fase 2: o múltiplo nasce AO LADO, nunca no lugar. Quem lê
      // `insurance_verified` hoje não quebra.
      insuranceVerified:  coberturaRead.readable ? (coberturaRead.labels[0] ?? null) : null,
      insuranceVerifiedReadable: coberturaRead.readable,
      // E a lista inteira, para a tabela nova. `readable:false` NÃO vira lista vazia.
      insuranceVerifiedLabels: coberturaRead.readable
        ? sourceLabelsRead(coberturaRead.labels)
        : sourceLabelsUnreadable(coberturaRead.reason),
      // Task 4.2 — a lista de dispositivos, para `patient_device_types`. Diferente da
      // cobertura, aqui NÃO há escalar equivalente sendo escrito: `patients.device_type` é
      // derivado por trigger, e o tipo `PatientClinicalUpsertInput` nem aceita mais o campo.
      deviceTypeLabels: dispositivoRead.readable
        ? sourceLabelsRead(dispositivoRead.labels)
        : sourceLabelsUnreadable(dispositivoRead.reason),
      serviceType:        serviceTypes.length > 0 ? serviceTypes : null,
      additionalComments: this.asString(cf['Comentarios Adicionales Paciente']),

      // Health insurance (fill-only via COALESCE in PatientIdentityRepository)
      // ClickUp: "Cobertura Informada " — o nome vivo tem ESPAÇO no fim (F15). Pedimos o nome
      // aparado; o alias de `buildCustomFieldMap` faz os dois casarem (task 1.12).
      healthInsuranceName:     this.asString(cf['Cobertura Informada']),
      // ClickUp: "Número ID Afiliado Paciente"
      healthInsuranceMemberId: this.asString(cf['Número ID Afiliado Paciente']),
      // ClickUp: "Caso Número" — PII-safe operational identifier. Migration 164.
      caseNumber:              extractCaseNumber(task),
      // Lifecycle status derived from ClickUp task status (migration 143).
      // null when ClickUp status is unrecognised — loggable above.
      status:                  patientStatus,

      // Related records
      responsibles:  this.buildResponsibles(cf),
      addresses:     this.buildAddresses(cf),
      professionals: this.buildProfessionals(cf, cf['Equipo Tratante Multidisciplinario']),
    };

    return input;
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /**
   * Task 1.12 — duas coisas, além de montar o mapa:
   *
   * 1. ALIAS SEM ESPAÇO. Nome de campo no ClickUp pode carregar espaço nas pontas — medido:
   *    o campo vivo se chama `'Cobertura Informada '`, com espaço no fim (F15/fase 0), e por
   *    isso `cf['Cobertura Informada']` devolvia `undefined` para TODA tarefa, calado. O alias
   *    torna a busca canônica: o mapper sempre pede o nome APARADO e continua funcionando com
   *    ou sem o espaço — inclusive no dia em que o Javier corrigir o nome no ClickUp.
   *
   * 2. REGISTRO DO QUE FOI PEDIDO. O `Proxy` anota o nome de CADA leitura — o que foi PEDIDO,
   *    não o que existe na tarefa. É o que a trava de deriva consulta (`getRequestedFieldNames`).
   *    A trava da 1.11 varria o fonte atrás da chamada de resolveDropdown com nome literal, e
   *    por isso era cega a `Equipo Tratante Multidisciplinario` — que é `drop_down`, mas não
   *    passa por ali. Instrumento
   *    que enxerga um padrão sintático deixa passar o próximo campo pelo mesmo motivo; este vê a
   *    leitura acontecer, inclusive nome vindo de variável (`slot.nameCf`) ou de laço.
   *
   * O `get` não muda valor nenhum: `Reflect.get` devolve exatamente o que o objeto devolveria.
   */
  private buildCustomFieldMap(fields: ClickUpTaskCustomField[]): CustomFieldMap {
    const map: CustomFieldMap = {};
    for (const field of fields) {
      map[field.name] = field.value;
      const trimmed = field.name.trim();
      if (trimmed !== field.name && !Object.prototype.hasOwnProperty.call(map, trimmed)) {
        map[trimmed] = field.value;
      }
    }

    this.requestedFieldNames.clear();
    return new Proxy(map, {
      get: (target, prop, receiver) => {
        if (typeof prop === 'string') this.requestedFieldNames.add(prop);
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  /**
   * Parses patient name from a ClickUp task title. Supports formats:
   *   - "Sobrenome, Nome"                         → "Sobrenome", "Nome"
   *   - "SOBRENOME, NOME - Caso 644"              → "SOBRENOME", "NOME"
   *   - "Falieres, Candela Agostina (Cod 433)"    → "Falieres", "Candela Agostina"
   *   - "Castillo, Priscila"                      → "Castillo", "Priscila"
   * Returns null if title has no recognizable "Sobrenome, Nome" pattern.
   */
  private parseNameFromTitle(title: string): { firstName: string; lastName: string } | null {
    if (!title) return null;
    const cleaned = title
      .replace(/\s*-\s*Caso\s+\d+.*$/i, '')
      .replace(/\s*\(C[oó]d(?:igo)?\.?\s*\d+\)\s*$/i, '')
      .replace(/\s*\([^)]*\)\s*$/, '')
      .trim();

    const parts = cleaned.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) return null;
    const lastName  = parts[0];
    const firstName = parts.slice(1).join(' ');
    if (!lastName || !firstName) return null;
    return { firstName, lastName };
  }

  private buildResponsibles(cf: CustomFieldMap): PatientResponsibleInput[] {
    const firstName = this.asString(cf['Nombre de Responsable']);
    const lastName  = this.asString(cf['Apellido del Responsable']);
    if (!firstName && !lastName) return [];

    const relLabel = this.resolver.resolveDropdown(
      'Relación con el Paciente',
      asIndexable('Relación con el Paciente', cf['Relación con el Paciente']),
    );

    return [{
      firstName:    firstName ?? '',
      lastName:     lastName  ?? '',
      relationship: mapClickUpRelationship(relLabel),
      phone:        this.cleanPhone(this.asString(cf['Número de WhatsApp Responsable'])),
      email:        this.asString(cf['Email Responsable']),
      documentType: mapClickUpDocumentType(
        this.resolver.resolveDropdown(
          'Tipo de Documento Responsable',
          asIndexable('Tipo de Documento Responsable', cf['Tipo de Documento Responsable']),
        ),
      ),
      documentNumber: this.asString(cf['Número do Documento Responsable']),
      isPrimary:    true,
      displayOrder: 1,
      source:       'clickup',
    }];
  }

  private buildAddresses(cf: CustomFieldMap): PatientAddress[] {
    const addresses: PatientAddress[] = [];

    // ClickUp stores structured location values as objects with lat/lng,
    // formatted_address, and (when Google Places returns them) address_components.
    // The "Domicilio Informado" custom fields carry plain text user input.
    //
    // Each address row derives its state/city/neighborhood from the SAME location
    // field that gave the formatted address — this keeps the three derived
    // columns in sync with `address_formatted` even when the operator does not
    // update the legacy patient-level custom fields (Provincia / Ciudad / Zona).
    //
    // Slot 1 (primary) falls back to the legacy patient-level fields when the
    // location object does not include structured `address_components` — this
    // covers historic ClickUp data that arrived as plain string.
    //
    // Slots 2 and 3 (secondary) do NOT use the legacy fallback because those
    // patient-level fields refer to the patient's habitual zone, not a
    // secondary address.
    // Raw formatted-address fallback (used only when the location field lacks
    // address_components entirely, e.g. plain-string legacy values) is dirty
    // by construction — route it through the same normalizer so legacy
    // patient-level fields never bypass the border-of-import cleanup.
    const legacyPatientState        = extractStateFromLocation(cf['Provincia del Paciente'])
                                   ?? normalizeProvince(this.extractFormattedAddress(cf['Provincia del Paciente']));
    const legacyPatientCity         = extractCityFromLocation(cf['Ciudad / Localidad del Paciente'])
                                   ?? stripPostalCodePrefix(this.extractFormattedAddress(cf['Ciudad / Localidad del Paciente']));
    const legacyPatientNeighborhood = extractNeighborhood(cf['Zona o Barrio Paciente']);

    const slots = [
      {
        location: cf['Domicilio 1 Principal Paciente'],
        raw:      this.asString(cf['Domicilio Informado Paciente 1']),
        type:     'primary' as const,
        order:    1,
        useLegacyFallback: true,
      },
      {
        location: cf['Domicilio 2 Paciente'],
        raw:      this.asString(cf['Domicilio Informado Paciente 2']),
        type:     'secondary' as const,
        order:    2,
        useLegacyFallback: false,
      },
      {
        location: cf['Domicilio 3 Paciente'],
        raw:      this.asString(cf['Domicilio Informado Paciente 3']),
        type:     'secondary' as const,
        order:    3,
        useLegacyFallback: false,
      },
    ];

    for (const slot of slots) {
      const formatted = this.extractFormattedAddress(slot.location);
      if (!formatted && !slot.raw) continue;

      // STRICT extraction from the slot's own location: only address_components
      // are honored. Formatted-address fallback is disabled because the
      // slot's formatted_address is a full street address (first comma segment
      // is the street, not the city/state).
      const state = extractStateFromLocationStrict(slot.location)
                 ?? (slot.useLegacyFallback ? legacyPatientState : null);
      const city = extractCityFromLocationStrict(slot.location)
                ?? (slot.useLegacyFallback ? legacyPatientCity : null);
      const neighborhood = extractNeighborhoodFromLocation(slot.location)
                        ?? (slot.useLegacyFallback ? legacyPatientNeighborhood : null);

      addresses.push({
        addressType:      slot.type,
        addressFormatted: formatted ?? undefined,
        addressRaw:       slot.raw   ?? undefined,
        displayOrder:     slot.order,
        state:            state ?? undefined,
        city:             city ?? undefined,
        neighborhood:     neighborhood ?? undefined,
      });
    }

    return addresses;
  }

  private buildProfessionals(cf: CustomFieldMap, isTeamFlag: unknown): PatientProfessional[] {
    const isTeam = this.parseClickUpBoolean(isTeamFlag) || this.asString(isTeamFlag as unknown as string) === 'Sí';
    const slots  = [
      { nameCf: 'Profesional Tratante Principal', phoneCf: 'Tel Profesional Tratante Principal', emailCf: 'Email Profesional Tratante Principal', order: 1 },
      { nameCf: 'Profesional Tratante 2',         phoneCf: 'Tel Profesional Tratante 2',         emailCf: 'Email Profesional Tratante 2',         order: 2 },
      { nameCf: 'Profesional Tratante 3',         phoneCf: 'Tel Profesional Tratante 3',         emailCf: 'Email Profesional Tratante 3',         order: 3 },
    ];

    const professionals: PatientProfessional[] = [];
    for (const slot of slots) {
      const name = this.asString(cf[slot.nameCf]);
      if (!name?.trim()) continue;

      professionals.push({
        name:         name.trim(),
        phone:        this.cleanPhone(this.asString(cf[slot.phoneCf])),
        email:        this.asString(cf[slot.emailCf]),
        displayOrder: slot.order,
        isTeam:       slot.order === 1 ? isTeam : false,
      } as PatientProfessional);
    }

    return professionals;
  }

  /** Returns null for phone-only placeholders (just country code or < 10 digits). */
  private cleanPhone(raw: string | null): string | null {
    if (!raw) return null;
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 10) return null;
    // Strip leading 54 (Argentina country code) if the result is still long enough
    return raw.trim();
  }

  /**
   * Parses a ClickUp checkbox/boolean custom field. ClickUp serializes
   * checkboxes as STRING `"true"`/`"false"` in production payloads, not as
   * native booleans. Accepts both shapes; everything else (null, undefined,
   * unrecognized string) returns false.
   */
  private parseClickUpBoolean(value: unknown): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      return normalized === 'true' || normalized === '1';
    }
    return false;
  }

  /**
   * Parses a ClickUp date custom field. ClickUp serializes Date fields as a
   * STRING containing the ms-epoch in production payloads (e.g. "828082800000"),
   * but some fixtures or other API shapes may send number or ISO string.
   * Returns null for any other shape (boolean, object, NaN, malformed).
   */
  private parseClickUpDate(value: unknown): Date | null {
    if (value == null) return null;
    if (typeof value === 'number') {
      const d = new Date(value);
      return isNaN(d.getTime()) ? null : d;
    }
    if (typeof value === 'string' && value.trim()) {
      const trimmed = value.trim();
      // ClickUp prod: epoch ms as string ("828082800000"); not parseable by Date directly.
      if (/^-?\d+$/.test(trimmed)) {
        const d = new Date(parseInt(trimmed, 10));
        return isNaN(d.getTime()) ? null : d;
      }
      // Otherwise: ISO string or anything Date can parse natively.
      const d = new Date(trimmed);
      return isNaN(d.getTime()) ? null : d;
    }
    return null;
  }

  private asString(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value.trim() || null;
    return null;
  }

  // asIndexable() moved to helpers/asIndexable.ts (C5 do parecer do `lex`, 23/08).
  // The version that lived here was `Number(value)` with a NaN guard, and `Number([])`,
  // `Number('')`, `Number('   ')` and `Number(false)` are all `0` — a valid orderindex.
  // It FABRICATED the first catalog option of a clinical field. See the helper's header.

  private extractFormattedAddress(location: unknown): string | null {
    if (!location || typeof location !== 'object') return null;
    const loc = location as Record<string, unknown>;
    return typeof loc['formatted_address'] === 'string' ? loc['formatted_address'] : null;
  }
}

/**
 * Extracts the operational case number from the ClickUp "Caso Número" custom field.
 * Uses a regex to extract the first digit sequence, so values like "Caso 766" or
 * "766" both yield 766.  Returns null when the field is absent, empty, or contains
 * no digits at all.
 */
export function extractCaseNumber(task: ClickUpTask): number | null {
  const raw = task.custom_fields.find(f => f.name === 'Caso Número')?.value;
  if (raw == null || raw === '') return null;
  const match = String(raw).match(/\d+/);
  return match ? parseInt(match[0], 10) : null;
}
