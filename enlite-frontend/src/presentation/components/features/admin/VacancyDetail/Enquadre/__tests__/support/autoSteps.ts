/**
 * autoSteps — o que cada estado "abre sozinho" depois de montar: cliques REAIS na tela (pelos data-testid), como o
 * Gabriel faria. Sem prop de produção só para o harness. Usado pelo `PreviewShell` e pelo teste dos 17 estados.
 */
const POLL_MS = 20;
const TIMEOUT_MS = 4000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

export async function waitFor(testId: string): Promise<HTMLElement> {
  const start = Date.now();
  for (;;) {
    const el = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    if (el) return el;
    if (Date.now() - start > TIMEOUT_MS) throw new Error(`não apareceu: ${testId} (tela: ${(document.body.textContent ?? "").slice(0, 160)})`);
    await sleep(POLL_MS);
  }
}

export async function clickTestId(testId: string): Promise<void> {
  (await waitFor(testId)).click();
  await sleep(POLL_MS);
}

/** Digita num campo controlado do React (setter nativo + evento `input`). */
export async function typeInto(testId: string, value: string): Promise<void> {
  const el = (await waitFor(testId)) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(POLL_MS);
}

async function fillDrawerBasics(): Promise<void> {
  await clickTestId('enquadre-create-button');
  await clickTestId('enquadre-create-host-radio-h-a');
  await typeInto('enquadre-create-date-input', '2026-10-16');
  await waitFor('enquadre-create-slot-15:00');
}

async function openOpenEvent(): Promise<void> {
  await clickTestId('enquadre-event-row-ev-01');
  await waitFor('enquadre-kanban-board');
}

async function openConvokedPanel(): Promise<void> {
  await openOpenEvent();
  await clickTestId('enquadre-kanban-manage');
  await waitFor('enquadre-convoked-panel');
}

const STEPS: Record<string, () => Promise<void>> = {
  '06': fillDrawerBasics,
  '07': async () => {
    await fillDrawerBasics();
    await clickTestId('enquadre-create-slot-15:00');
    await clickTestId('enquadre-create-worker-checkbox-w-21');
    await clickTestId('enquadre-create-worker-checkbox-w-22');
    await clickTestId('enquadre-create-submit');
    await waitFor('enquadre-create-error');
  },
  '08': async () => {
    await fillDrawerBasics();
    await clickTestId('enquadre-create-worker-checkbox-w-21');
    await waitFor('enquadre-create-worker-reason-w-26');
  },
  '09': openOpenEvent,
  '10': async () => { await clickTestId('enquadre-event-row-ev-04'); await waitFor('enquadre-kanban-board'); },
  '11': async () => {
    await clickTestId('enquadre-event-row-ev-03');
    await waitFor('enquadre-kanban-board');
    await clickTestId('enquadre-kanban-close');
    await waitFor('enquadre-close-dialog');
  },
  '14': async () => { await openOpenEvent(); await clickTestId('enquadre-kanban-cancel'); await waitFor('enquadre-cancel-dialog'); },
  '15': async () => {
    await openOpenEvent();
    await clickTestId('enquadre-kanban-cancel');
    await clickTestId('enquadre-cancel-dialog-confirm');
    await waitFor('enquadre-events-table');
  },
  '16': async () => {
    await openConvokedPanel();
    await clickTestId('enquadre-convoked-worker-checkbox-w-11');
    await clickTestId('enquadre-convoked-worker-checkbox-w-12');
  },
  '17': async () => {
    await openConvokedPanel();
    await clickTestId('enquadre-convoked-remove-p-03');
    await waitFor('enquadre-convoked-remove-dialog');
  },
};

/** Estados sem passo (a tela já nasce como o print) resolvem na hora. */
export async function runAutoSteps(id: string): Promise<void> {
  await STEPS[id]?.();
}
