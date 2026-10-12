import { solveAction } from './solver.js';

self.onmessage = ({ data }) => {
  try {
    const result = solveAction(data.input, data.catalog, data.items, {
      beamWidth: data.beamWidth,
      onProgress: progress => self.postMessage({ type: 'progress', progress }),
    });
    self.postMessage({ type: 'result', result });
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message });
  }
};
