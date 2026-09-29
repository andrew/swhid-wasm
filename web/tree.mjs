export function indexTree(entries) {
  const nodes = new Map(entries.map(entry => [entry.path, { entry, children: [], files: entry.type === 'directory' ? 0 : 1, bytes: entry.size ?? 0 }]));
  for (const node of nodes.values()) {
    if (!node.entry.path) continue;
    const path = node.entry.path;
    node.parent = nodes.get(path.slice(0, Math.max(0, path.lastIndexOf('/'))));
    node.parent.children.push(node);
  }
  const order = [];
  function visit(node) {
    order.push(node);
    node.children.sort((a, b) => Number(b.entry.type === 'directory') - Number(a.entry.type === 'directory')
      || a.entry.path.localeCompare(b.entry.path));
    for (const child of node.children) {
      visit(child); node.files += child.files; node.bytes += child.bytes;
    }
  }
  visit(nodes.get(''));
  return { nodes, order };
}

export function treeView(index, known, query = '', unknownOnly = false) {
  query = query.trim().toLowerCase();
  const visible = new Set();
  const expanded = new Set();
  const unknown = new Map();
  for (const node of [...index.order].reverse()) {
    const { path, swhid } = node.entry;
    const missing = known.get(swhid) === false;
    const descendants = node.children.reduce((sum, child) => sum + unknown.get(child.entry.path)
      + Number(known.get(child.entry.swhid) === false), 0);
    unknown.set(path, descendants);
    const matches = path.toLowerCase().includes(query) && (!unknownOnly || missing);
    const childVisible = node.children.some(child => visible.has(child.entry.path));
    if (matches || childVisible) visible.add(path);
    if ((query || unknownOnly) && childVisible) expanded.add(path);
  }
  return { visible, expanded, unknown };
}
