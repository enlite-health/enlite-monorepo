/**
 * ClickUpTaskListGateway
 *
 * I/O puro contra a API do ClickUp para a lista "Estado de Pacientes".
 * Sem regra de negócio: só busca e pagina. Quem interpreta a task é o
 * ClickUpPatientMapper / SyncPatientFromClickUpTaskUseCase.
 *
 * Três leituras:
 *   - fetchUpdatedSince(sinceMs) → janela incremental (date_updated_gt)
 *   - fetchAll()                 → varredura completa (modo full)
 *   - fetchById(taskId)          → um card (modo orphans; mesma chamada do webhook)
 *
 * Os filtros de lista replicam os do import batch e do webhook:
 * `archived=false&subtasks=false&include_closed=true`.
 */

import type { ClickUpTask } from './ClickUpTask';

export const PATIENT_LIST_ID = '901304883903'; // Estado de Pacientes
const CLICKUP_API_BASE = 'https://api.clickup.com/api/v2';

/**
 * Trava de segurança contra loop de paginação: a lista tem ~350 tasks
 * (100/página), então 50 páginas é ordens de grandeza acima do real.
 */
const MAX_PAGES = 50;

interface TasksPage {
  tasks: ClickUpTask[];
  last_page: boolean;
}

export class ClickUpTaskListGateway {
  constructor(
    private readonly token: string,
    private readonly listId: string = PATIENT_LIST_ID,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /**
   * Tasks da lista modificadas depois de `sinceMs` (epoch ms).
   * É a rede de segurança contra eventos de webhook perdidos: em regime
   * normal devolve pouquíssimas tasks, então o ciclo é barato.
   */
  async fetchUpdatedSince(sinceMs: number): Promise<ClickUpTask[]> {
    return this.paginate({ date_updated_gt: String(Math.floor(sinceMs)) });
  }

  /** Todas as tasks da lista (modo full — caro, ~12 min em produção). */
  async fetchAll(): Promise<ClickUpTask[]> {
    return this.paginate({});
  }

  /**
   * Uma task por id. Devolve null quando a task não pertence à lista de
   * pacientes (mesma checagem da camada 5 do webhook) — evita reprocessar
   * um card que foi movido para outra lista.
   */
  async fetchById(taskId: string): Promise<ClickUpTask | null> {
    const res = await this.fetchFn(`${CLICKUP_API_BASE}/task/${taskId}`, {
      headers: { Authorization: this.token },
    });
    if (!res.ok) {
      throw new Error(`ClickUp GET /task/${taskId} falhou: HTTP ${res.status} ${res.statusText}`);
    }
    const task = (await res.json()) as ClickUpTask;
    return task.list?.id === this.listId ? task : null;
  }

  private async paginate(extraParams: Record<string, string>): Promise<ClickUpTask[]> {
    const all: ClickUpTask[] = [];

    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        page: String(page),
        archived: 'false',
        subtasks: 'false',
        include_closed: 'true',
        ...extraParams,
      });

      const url = `${CLICKUP_API_BASE}/list/${this.listId}/task?${params.toString()}`;
      const res = await this.fetchFn(url, { headers: { Authorization: this.token } });

      if (!res.ok) {
        throw new Error(
          `ClickUp GET /list/${this.listId}/task falhou: HTTP ${res.status} ${res.statusText} (página ${page})`,
        );
      }

      const body = (await res.json()) as TasksPage;
      const tasks = body.tasks ?? [];
      all.push(...tasks);

      if (body.last_page || tasks.length === 0) break;
    }

    return all;
  }
}
