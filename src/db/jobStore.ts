import { randomUUID } from 'node:crypto';

import type { Db } from './db.js';

export type JobRow = {
  jobId: string;
  bindingKey: string;
  cronExpr: string;
  promptTemplate: string;
  enabled: number;
  createdAt: number;
  updatedAt: number;
};

export function listJobsForBinding(db: Db, bindingKey: string): JobRow[] {
  return db
    .prepare(
      `
      SELECT job_id as jobId,
             binding_key as bindingKey,
             cron_expr as cronExpr,
             prompt_template as promptTemplate,
             enabled,
             created_at as createdAt,
             updated_at as updatedAt
        FROM jobs
       WHERE binding_key = ?
       ORDER BY created_at DESC
      `,
    )
    .all(bindingKey) as JobRow[];
}

export function createJob(
  db: Db,
  params: {
    bindingKey: string;
    cronExpr: string;
    promptTemplate: string;
  },
): string {
  const jobId = randomUUID();
  const now = Date.now();

  db.prepare(
    `
    INSERT INTO jobs(job_id, binding_key, cron_expr, prompt_template, enabled, created_at, updated_at)
    VALUES(?, ?, ?, ?, 1, ?, ?)
    `,
  ).run(
    jobId,
    params.bindingKey,
    params.cronExpr,
    params.promptTemplate,
    now,
    now,
  );

  return jobId;
}

export function deleteJob(db: Db, jobId: string): void {
  db.prepare('DELETE FROM jobs WHERE job_id = ?').run(jobId);
}

export function setJobEnabled(db: Db, jobId: string, enabled: boolean): void {
  db.prepare(
    'UPDATE jobs SET enabled = ?, updated_at = ? WHERE job_id = ?',
  ).run(enabled ? 1 : 0, Date.now(), jobId);
}
