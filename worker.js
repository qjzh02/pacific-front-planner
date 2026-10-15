import { solveActionAsync } from './solver.js';

let paused = false, resume = null, running = false;

async function waitForTurn() {
  await new Promise(resolve => setTimeout(resolve, 16));
  if (paused) {
    self.postMessage({ type: 'paused', paused: true });
    while (paused) await new Promise(resolve => { resume = resolve; });
    self.postMessage({ type: 'paused', paused: false });
  }
}

self.onmessage = async ({ data }) => {
  if (data.type === 'pause') {
    paused = Boolean(data.paused);
    if (!paused && resume) { const wake = resume; resume = null; wake(); }
    return;
  }
  if (running) return;
  running = true;
  try {
    await waitForTurn();
    const seconds = data.input.computeBudget ?? 0;
    if (![0, 30, 60].includes(seconds)) throw new Error('计算预算设置无效。');
    const result = await solveActionAsync(data.input, data.catalog, data.items, {
      beamWidth: data.beamWidth,
      maxTimeMs: seconds ? seconds * 1000 : Infinity,
      schedule: waitForTurn,
      onProgress: progress => self.postMessage({ type: 'progress', progress }),
      onBudget: budget => self.postMessage({ type: 'budget', ...budget }),
    });
    self.postMessage({ type: 'result', result });
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message });
  } finally { running = false; }
};
