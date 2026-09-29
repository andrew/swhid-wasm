import '../build/go-wasm_exec.js';

export async function createAnalyzer(bytes) {
  const go = new globalThis.Go();
  go.env.GOMEMLIMIT = '96MiB';
  const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
  go.run(instance).catch(error => console.error(error));
  const wasm = instance.exports;
  return (name, bytes, stripRoot) => {
    const encodedName = new TextEncoder().encode(name);
    if (encodedName.length === 0 || encodedName.length > 1024) throw new Error('Archive filename is too long or empty.');
    const pointer = wasm.reserve(encodedName.length + bytes.length);
    if (!pointer) throw new Error('Archive exceeds the WASM input limit.');
    const memory = new Uint8Array(wasm.mem.buffer, pointer, encodedName.length + bytes.length);
    memory.set(encodedName);
    memory.set(bytes, encodedName.length);
    const status = wasm.analyze(stripRoot ? 1 : 0, encodedName.length);
    try {
      const result = JSON.parse(new TextDecoder().decode(new Uint8Array(wasm.mem.buffer, wasm.result_ptr(), wasm.result_len())));
      if (status !== 200) throw new Error(result.error);
      return result;
    } finally { wasm.release_result(); }
  };
}
