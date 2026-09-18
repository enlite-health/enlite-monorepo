/**
 * IAxonicoApiClient — porta de domínio para o sistema do pagador argentino Axonico, onde a
 * Enlite lança prestações de acompanhamento terapêutico (AT) para faturamento.
 *
 * Fluxo medido por HTTP real em 18/09/2026 (`docs/funcionalidades/integracao-axonico/
 * estado-integracao-axonico.md`): login → achar paciente por DNI → dedupe → `PUT /api/comprobante`.
 * Porta separada da implementação (`infrastructure/AxonicoApiClient.ts`), mesmo padrão de
 * `ITalentumApiClient`/`TalentumApiClient`.
 *
 * `AxonicoSubmitResult` carrega SÓ `numeroComprobante`/`codAutorizacion` (D367) — a resposta real
 * do `PUT` traz blocos `paciente`/`diagnostico` com PII do paciente que a API do Axonico não
 * filtra; o parse que extrai os 2 campos e descarta o resto vive dentro do próprio
 * `AxonicoApiClient`, nunca chega a quem chama a porta.
 */

/** Resultado de `findPatientByDni` — o vínculo Axonico do paciente (D367: nada de PII aqui). */
export interface AxonicoPatientMatch {
  /** Identificador do paciente no Axonico (`historia_clinica`, resposta de `paciente/filter`). */
  historiaClinica: string;
  /** Identificador da cobertura/plano ativa do paciente (`nro_afiliado` da 1ª cobertura ativa). */
  nroCobertura: string;
}

/**
 * Campos do mapeamento de tipo de serviço (D369 — `AxonicoServiceMapping.ts`), reaproveitados
 * tanto pelo dedupe (`checkExistingComprobante`) quanto pelo envio (`submitComprobante`): os dois
 * passos filtram/enviam pela MESMA prestação (`servicio_origen`/`codigo_especialidad`/`codigo`/
 * `subcodigo`), medido nos passos 3 e 4 do fluxo.
 */
export interface AxonicoServiceCodes {
  servicioOrigen: string;
  codigoEspecialidad: string;
  codigo: string;
  subcodigo: string;
}

/** Parâmetros de `checkExistingComprobante` — o filtro `POST /api/comprobante/filter` (passo 3). */
export interface DedupeParams {
  historiaClinica: string;
  nroCobertura: string;
  serviceCodes: AxonicoServiceCodes;
  /** Data da prestação (só a data importa — o filtro cobre o dia inteiro, `00:00:00`–`23:59:59`). */
  serviceDate: Date;
}

/** Parâmetros de `submitComprobante` — o `PUT /api/comprobante` (passo 4). */
export interface SubmitComprobanteParams {
  historiaClinica: string;
  nroCobertura: string;
  serviceCodes: AxonicoServiceCodes;
  /**
   * Data da prestação escolhida pelo chamador. `fecha` é montado pelo cliente como esta data +
   * a hora do INSTANTE do envio (D370) — nunca uma hora fixa nem a hora real do plantão.
   */
  serviceDate: Date;
  /** Quantidade — SEMPRE inteiro positivo (D366: 1 hora = `cantidad` 1, nunca hora quebrada). */
  cantidad: number;
}

/** Resultado do envio — SÓ os 2 campos que a Enlite persiste (D367). */
export interface AxonicoSubmitResult {
  numeroComprobante: string;
  codAutorizacion: string;
}

export interface IAxonicoApiClient {
  /** `POST /api/paciente/filter` (`doc_tipo: "0"`). `null` quando não encontra o paciente. */
  findPatientByDni(dni: string): Promise<AxonicoPatientMatch | null>;

  /**
   * `POST /api/comprobante/filter` — existe pelo menos um comprobante ativo (`estado` A/P) para
   * a mesma prestação no dia. Devolve `boolean`; a política de dedupe (nossa tabela primeiro,
   * este método só depois) é decisão do use case (F3), não do cliente.
   */
  checkExistingComprobante(params: DedupeParams): Promise<boolean>;

  /**
   * `PUT /api/comprobante`. `matricula` SHALL vir da sessão autenticada (nunca constante
   * literal) — ver `AxonicoApiClient`. Sucesso = status 200 + `data.numero_comprobante` presente.
   */
  submitComprobante(params: SubmitComprobanteParams): Promise<AxonicoSubmitResult>;

  /**
   * `POST /api/medicoParametroPortal/filter` — teto de `cantidad` permitido por prestação
   * (`cantidad_max_prestaciones`), medido em 18/09/2026
   * (`docs/funcionalidades/integracao-axonico/estado-integracao-axonico.md:185-188`). `matricula`
   * SHALL vir da sessão autenticada, nunca constante literal — mesma regra de `submitComprobante`.
   *
   * `null` quando a resposta vier sem o campo `cantidad_max_prestaciones` (dado do Axonico ausente
   * — o guard 2 do use case (F3, D371) trata isso como recusa, nunca como "sem teto"). LANÇA
   * quando a chamada HTTP falhar (mesmos erros tipados dos outros métodos) — o use case nunca usa
   * um número cravado no lugar de uma leitura que falhou.
   */
  getCantidadMaxPrestaciones(): Promise<number | null>;
}
