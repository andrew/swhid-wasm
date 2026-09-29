import { createAnalyzer } from './wasm.mjs';

self.onmessage = async ({ data }) => {
  try {
    const downloadStart = performance.now();
    const response = await fetch('/build/analyzer-go.wasm');
    if (!response.ok) throw new Error('Build the WASM module with make build.');
    const wasmBytes = await response.arrayBuffer();
    const startupStart = performance.now();
    const analyze = await createAnalyzer(wasmBytes);
    const hashStart = performance.now();
    const result = analyze(data.name, new Uint8Array(data.bytes), data.stripRoot);
    self.postMessage({ result, timings: {
      wasmDownload: startupStart - downloadStart,
      wasmStartup: hashStart - startupStart,
      hashing: performance.now() - hashStart,
    } });
  } catch (error) { self.postMessage({ error: error.message }); }
};
