/* eslint-disable no-console */

import { Pool } from 'pg';
import {
  TAG,
  POST_WAIT_MS,
  DEFAULT_TASK_ID,
  type SmokeContext,
  type SmokeResult,
  type PatientRow,
} from './types';
import { signPayload, buildPayload, postWebhook, fetchClickUpTask, sleep, timer } from './http-helpers';

// ── DB helpers ────────────────────────────────────────────────────────────────

async function getPatientUpdatedAt(pool: Pool, taskId: string): Promise<Date | null> {
  const { rows } = await pool.query<PatientRow>(
    'SELECT updated_at FROM patients WHERE clickup_task_id = $1 AND deleted_at IS NULL LIMIT 1',
    [taskId],
  );
  return rows[0]?.updated_at ?? null;
}

// ── Test 1: happy path ────────────────────────────────────────────────────────

export async function runTest1_HappyPath(ctx: SmokeContext, taskId: string): Promise<SmokeResult> {
  const elapsed  = timer();
  const testName = 'Test 1 — taskUpdated happy path';

  try {
    let taskName = '';
    try {
      const task = await fetchClickUpTask(taskId, ctx.clickupApiToken);
      taskName = task.name ? ` ("${task.name}")` : '';
    } catch (err) {
      return {
        test: testName,
        pass: false,
        message: `Failed to GET task from ClickUp: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: elapsed(),
      };
    }

    console.log(`${TAG} Test 1: using task ${taskId}${taskName}`);

    const beforeUpdatedAt = await getPatientUpdatedAt(ctx.pool, taskId);
    if (beforeUpdatedAt === null) {
      return {
        test: testName,
        pass: false,
        message: `No patient found in DB with clickup_task_id=${taskId}. Try a different --task-id.`,
        durationMs: elapsed(),
      };
    }

    const { payload, rawBody } = buildPayload(taskId);
    const signature = signPayload(rawBody, ctx.secret);

    let httpResult: { status: number; body: unknown };
    try {
      httpResult = await postWebhook(ctx.endpoint, payload, signature);
    } catch (err) {
      return {
        test: testName,
        pass: false,
        message: `Network error — server offline? ${err instanceof Error ? err.message : String(err)}`,
        durationMs: elapsed(),
      };
    }

    if (httpResult.status !== 200) {
      return {
        test: testName,
        pass: false,
        message: `Expected HTTP 200, got ${httpResult.status}. Body: ${JSON.stringify(httpResult.body)}`,
        durationMs: elapsed(),
      };
    }

    console.log(`${TAG} Test 1: waiting ${POST_WAIT_MS}ms for server processing...`);
    await sleep(POST_WAIT_MS);

    const afterUpdatedAt = await getPatientUpdatedAt(ctx.pool, taskId);
    if (afterUpdatedAt === null) {
      return {
        test: testName,
        pass: false,
        message: 'Patient disappeared from DB after sync — unexpected.',
        durationMs: elapsed(),
      };
    }

    if (afterUpdatedAt.getTime() <= beforeUpdatedAt.getTime()) {
      return {
        test: testName,
        pass: false,
        message:
          `updated_at did not advance (before=${beforeUpdatedAt.toISOString()}, ` +
          `after=${afterUpdatedAt.toISOString()}). ` +
          `Possible causes: server is offline, DB URL points to a stale copy, ` +
          `geocoding took >5s (try re-running), or the upsert skipped this record.`,
        durationMs: elapsed(),
      };
    }

    return {
      test: testName,
      pass: true,
      message: `updated_at advanced from ${beforeUpdatedAt.toISOString()} → ${afterUpdatedAt.toISOString()}`,
      durationMs: elapsed(),
    };
  } catch (err) {
    return {
      test: testName,
      pass: false,
      message: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: elapsed(),
    };
  }
}

// ── Test 2: invalid HMAC → 401 ────────────────────────────────────────────────

export async function runTest2_InvalidHmac(ctx: SmokeContext): Promise<SmokeResult> {
  const elapsed  = timer();
  const testName = 'Test 2 — invalid HMAC → 401';

  try {
    const { payload } = buildPayload(DEFAULT_TASK_ID);
    const invalidSig  = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

    let httpResult: { status: number; body: unknown };
    try {
      httpResult = await postWebhook(ctx.endpoint, payload, invalidSig);
    } catch (err) {
      return {
        test: testName,
        pass: false,
        message: `Network error: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: elapsed(),
      };
    }

    if (httpResult.status === 401) {
      return { test: testName, pass: true, message: 'HTTP 401 as expected', durationMs: elapsed() };
    }

    return {
      test: testName,
      pass: false,
      message: `Expected HTTP 401, got ${httpResult.status}. Body: ${JSON.stringify(httpResult.body)}`,
      durationMs: elapsed(),
    };
  } catch (err) {
    return {
      test: testName,
      pass: false,
      message: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: elapsed(),
    };
  }
}

// ── Test 3: wrong list_id → skipped_other_list ────────────────────────────────

export async function runTest3_WrongList(ctx: SmokeContext): Promise<SmokeResult> {
  const elapsed  = timer();
  const testName = 'Test 3 — wrong list_id → skipped_other_list';

  try {
    const { payload, rawBody } = buildPayload(DEFAULT_TASK_ID, { listId: '000000' });
    const signature = signPayload(rawBody, ctx.secret);

    let httpResult: { status: number; body: unknown };
    try {
      httpResult = await postWebhook(ctx.endpoint, payload, signature);
    } catch (err) {
      return {
        test: testName,
        pass: false,
        message: `Network error: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: elapsed(),
      };
    }

    if (httpResult.status !== 200) {
      return {
        test: testName,
        pass: false,
        message: `Expected HTTP 200, got ${httpResult.status}`,
        durationMs: elapsed(),
      };
    }

    const body = httpResult.body as Record<string, unknown> | null;
    if (body?.action === 'skipped_other_list') {
      return {
        test: testName,
        pass: true,
        message: 'HTTP 200 { action: "skipped_other_list" } as expected',
        durationMs: elapsed(),
      };
    }

    return {
      test: testName,
      pass: false,
      message: `Expected action="skipped_other_list", got: ${JSON.stringify(httpResult.body)}`,
      durationMs: elapsed(),
    };
  } catch (err) {
    return {
      test: testName,
      pass: false,
      message: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: elapsed(),
    };
  }
}

// ── Test 4: fake task_id → fetch_failed ──────────────────────────────────────

export async function runTest4_TaskNotFound(ctx: SmokeContext): Promise<SmokeResult> {
  const elapsed  = timer();
  const testName = 'Test 4 — fake task_id → fetch_failed';

  try {
    const fakeTaskId = 'cu-smoke-test-fake-9999999';
    const { payload, rawBody } = buildPayload(fakeTaskId);
    const signature = signPayload(rawBody, ctx.secret);

    let httpResult: { status: number; body: unknown };
    try {
      httpResult = await postWebhook(ctx.endpoint, payload, signature);
    } catch (err) {
      return {
        test: testName,
        pass: false,
        message: `Network error: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: elapsed(),
      };
    }

    if (httpResult.status !== 200) {
      return {
        test: testName,
        pass: false,
        message: `Expected HTTP 200, got ${httpResult.status}`,
        durationMs: elapsed(),
      };
    }

    const body = httpResult.body as Record<string, unknown> | null;
    if (body?.action === 'fetch_failed') {
      return {
        test: testName,
        pass: true,
        message: 'HTTP 200 { action: "fetch_failed" } as expected',
        durationMs: elapsed(),
      };
    }

    return {
      test: testName,
      pass: false,
      message: `Expected action="fetch_failed", got: ${JSON.stringify(httpResult.body)}`,
      durationMs: elapsed(),
    };
  } catch (err) {
    return {
      test: testName,
      pass: false,
      message: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: elapsed(),
    };
  }
}
