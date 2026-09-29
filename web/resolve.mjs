export function resolvePackage(ecosystem, name, version, proxy = '') {
  return new Promise((resolve, reject) => {
    const worker = new Worker('/resolve-worker.mjs', { type: 'module' });
    const timeout = setTimeout(() => finish(new Error('Registry resolution exceeded one minute.')), 65000);
    function finish(error, result) {
      clearTimeout(timeout); worker.terminate(); error ? reject(error) : resolve(result);
    }
    worker.onmessage = ({ data }) => finish(data.error ? new Error(data.error) : null, data.result);
    worker.onerror = event => finish(new Error(event.message));
    worker.postMessage({ ecosystem, name, version, proxy });
  });
}
