import path from 'node:path';

export function resolveWorkspacePath(
  workspaceRoot: string,
  requestedPath: string,
): string {
  if (!path.isAbsolute(requestedPath)) {
    throw new Error(`ACP path must be absolute: ${requestedPath}`);
  }

  const resolved = path.resolve(requestedPath);
  const root = path.resolve(workspaceRoot);

  if (resolved === root) return resolved;
  if (resolved.startsWith(root + path.sep)) return resolved;

  throw new Error(`Path escapes WORKSPACE_ROOT: ${requestedPath}`);
}
