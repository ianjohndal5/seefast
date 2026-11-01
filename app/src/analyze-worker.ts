// Runs the analysis off the main thread so the launcher stays responsive on large monorepos.
import { parentPort, workerData } from 'node:worker_threads';
import { analyze } from 'seefast';

try {
  parentPort!.postMessage({ plan: analyze((workerData as { root: string }).root) });
} catch (e) {
  parentPort!.postMessage({ error: (e as Error).message });
}
