import http from 'http';
import { AddressInfo } from 'net';

/**
 * axonicoStubServer — servidor HTTP local que imita os 5 endpoints do Axonico medidos por HTTP
 * real em 18/09/2026 (`docs/funcionalidades/integracao-axonico/estado-integracao-axonico.md`).
 *
 * ⚠️ ESCOPO — mesmo aviso de `periskopeStubServer.ts`: este stub prova O NOSSO LADO (que a nossa
 * API monta o corpo certo, respeita o dedupe local ANTES de tocar rede, e traduz cada resposta
 * medida corretamente), nunca o contrato real com o Axonico. Não existe sandbox do Axonico — TODO
 * `PUT /api/comprobante` real GERA FATURAMENTO em produção de terceiro, por isso nenhum teste
 * desta suíte pode, em hipótese alguma, tocar `api.apiws.axonico.ar`/`api.his.axonico.ar`.
 *
 * `requestCounts` — o espião: conta requisições recebidas POR ROTA, prova exigida pela F4 (ex.:
 * "no caso duplicado local, o stub recebe ZERO requisições" só é prova se o mesmo contador for
 * >0 no caso feliz).
 */

interface StubPatient {
  dni: string;
  historiaClinica: string;
  nroCobertura: string;
}

export interface AxonicoStub {
  port: number;
  requestCounts: Record<
    'login' | 'pacienteFilter' | 'comprobanteFilter' | 'comprobantePut' | 'medicoParametroPortalFilter',
    number
  >;
  /** DNIs com comprobante já existente no Axonico (dedupe REMOTO) — `checkExistingComprobante`
   *  devolve `count > 0` para eles. */
  dnisComComprobanteExistente: Set<string>;
  cantidadMaxPrestacoes: number;
  close: () => Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
    req.on('end', () => resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {}));
  });
}

/**
 * @param patients cadastro sintético DNI → historia_clinica/nro_cobertura (`doc_tipo: '0'` = DNI).
 *   DNI ausente deste array → `paciente/filter` devolve lista vazia (paciente não encontrado).
 * @param cantidadMaxPrestacoes teto devolvido por `medicoParametroPortal/filter` — default alto
 *   o bastante para não bloquear os testes que não miram o guard 3 especificamente.
 */
export async function startAxonicoStub(
  patients: StubPatient[],
  port: number,
  cantidadMaxPrestacoes = 24,
): Promise<AxonicoStub> {
  const requestCounts: AxonicoStub['requestCounts'] = {
    login: 0,
    pacienteFilter: 0,
    comprobanteFilter: 0,
    comprobantePut: 0,
    medicoParametroPortalFilter: 0,
  };
  const dnisComComprobanteExistente = new Set<string>();

  const server = http.createServer((req, res) => {
    void readBody(req).then((body) => {
      const url = req.url ?? '';

      if (req.method === 'POST' && url === '/api/login') {
        requestCounts.login++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { accessToken: 'stub-token-e2e-only' }, medico: { matricula: '54321' } }));
        return;
      }

      if (req.method === 'POST' && url === '/api/paciente/filter') {
        requestCounts.pacienteFilter++;
        const filters = body.filters as { nro_doc?: string } | undefined;
        const dni = filters?.nro_doc;
        const match = patients.find((p) => p.dni === dni);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: match
              ? [
                  {
                    historia_clinica: match.historiaClinica,
                    // `nro_cobertura` é o campo que o client usa (medido 24/09/2026); `nro_afiliado`
                    // fica também presente para espelhar o formato real e provar que NÃO é essa a
                    // fonte lida. `estado.descripcion: 'Activo'` — cobertura sem estado ativo não
                    // é escolhida (ver `isCoberturaAtiva` em `AxonicoApiClient.ts`).
                    coberturas: [
                      {
                        nro_cobertura: match.nroCobertura,
                        nro_afiliado: `AFILIADO-${match.nroCobertura}`,
                        estado: { descripcion: 'Activo' },
                      },
                    ],
                  },
                ]
              : [],
          }),
        );
        return;
      }

      if (req.method === 'POST' && url === '/api/comprobante/filter') {
        requestCounts.comprobanteFilter++;
        const filters = body.filters as { historia_clinica?: string } | undefined;
        const historiaClinica = filters?.historia_clinica;
        const patient = patients.find((p) => p.historiaClinica === historiaClinica);
        const jaExiste = patient ? dnisComComprobanteExistente.has(patient.dni) : false;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: jaExiste ? [{ id: 999 }] : [] }));
        return;
      }

      if (req.method === 'PUT' && url === '/api/comprobante') {
        requestCounts.comprobantePut++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: {
              numero_comprobante: `CMP-${requestCounts.comprobantePut}`,
              cod_autorizacion: `AUT-${requestCounts.comprobantePut}`,
            },
          }),
        );
        return;
      }

      if (req.method === 'POST' && url === '/api/medicoParametroPortal/filter') {
        requestCounts.medicoParametroPortalFilter++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ cantidad_max_prestaciones: cantidadMaxPrestacoes }] }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { message: `stub: rota desconhecida ${req.method} ${url}` } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(port, '0.0.0.0', resolve));
  const bound = (server.address() as AddressInfo).port;

  return {
    port: bound,
    requestCounts,
    dnisComComprobanteExistente,
    cantidadMaxPrestacoes,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
