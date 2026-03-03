import fs from 'node:fs';
import path from 'node:path';

export type ProcessLock = {
  path: string;
  release: () => void;
};

export function acquireProcessLock(lockPath: string): ProcessLock {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  try {
    const fd = fs.openSync(lockPath, 'wx');
    try {
      fs.writeFileSync(
        fd,
        JSON.stringify(
          {
            pid: process.pid,
            startedAt: Date.now(),
          },
          null,
          2,
        ) + '\n',
        'utf8',
      );
    } finally {
      fs.closeSync(fd);
    }

    return {
      path: lockPath,
      release: () => {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // ignore
        }
      },
    };
  } catch (err: any) {
    if (err?.code !== 'EEXIST') throw err;

    // If lock exists, verify the process is alive.
    const existing = readLockFile(lockPath);
    if (existing?.pid && isPidAlive(existing.pid)) {
      throw new Error(`Another instance is running (pid=${existing.pid})`, {
        cause: err,
      });
    }

    // Stale lock.
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // ignore
    }

    // Retry once.
    const fd = fs.openSync(lockPath, 'wx');
    try {
      fs.writeFileSync(
        fd,
        JSON.stringify(
          {
            pid: process.pid,
            startedAt: Date.now(),
          },
          null,
          2,
        ) + '\n',
        'utf8',
      );
    } finally {
      fs.closeSync(fd);
    }

    return {
      path: lockPath,
      release: () => {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // ignore
        }
      },
    };
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockFile(lockPath: string): { pid?: number } | null {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as any;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
