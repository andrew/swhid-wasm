import '../build/go-wasm_exec.js';
import { fetchWithProxy } from './core.mjs';

self.onmessage = async ({ data }) => {
  try {
    const response = await fetch('/build/resolver.wasm');
    if (!response.ok) throw new Error('Build the resolver with make build.');
    const go = new globalThis.Go();
    const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), go.importObject);
    const directFetch = self.fetch.bind(self);
    let metadataViaProxy = false;
    self.fetch = async (url, options = {}) => {
      const result = await fetchWithProxy(url, { ...options, credentials: 'omit' }, data.proxy, directFetch);
      metadataViaProxy ||= result.viaProxy;
      return result.response;
    };
    go.run(instance).catch(error => self.postMessage({ error: error.message }));
    const result = await globalThis.resolvePackage(data.ecosystem, data.name, data.version);
    result.metadataViaProxy = metadataViaProxy;
    self.postMessage({ result });
  } catch (error) { self.postMessage({ error: error.message }); }
};
