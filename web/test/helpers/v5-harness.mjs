// Test helpers around the real v5 logic (see lib/v5-model.mjs for the evaluator).
export { loadV5, createMemoryStorage, extractLogicSource, builtinWorkspaces, DC_FILE } from '../../lib/v5-model.mjs';

export const STORAGE_KEY = 'wsconfig_v5_custom';

/** Drive the real v5 "new workspace" flow (picker → New workspace → Create). */
export function createWorkspaceVia(c, { name, slug, start = 'template' }) {
  c.setState({ newWs: { name, slug, start, slugTouched: true } });
  c.createWorkspace();
  return c.state.ws;
}

/** Drive the real v5 publish flow (Publish sheet → type a reason → "Publish vN"). */
export function publishVia(c, reason) {
  c.setState({ publishReason: reason });
  c.publishVals().onConfirmPublish();
}

export function readBlob(storage) {
  const raw = storage.getItem(STORAGE_KEY);
  return raw ? JSON.parse(raw) : null;
}
