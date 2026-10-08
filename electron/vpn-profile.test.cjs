const assert = require('node:assert/strict');
const test = require('node:test');
const yaml = require('js-yaml');

// Same implementation main.cjs uses.
const { listClashProxyNodes } = require('./mac-clash-controller.cjs');

function selectClashOrThrow(document, nodes, nodeName) {
  if (!nodes.length) throw new Error('no nodes');
  const selected = nodes.some((node) => node.id === nodeName) ? nodeName : nodes[0].id;
  const proxy = Array.isArray(document?.proxies)
    ? document.proxies.find((item) => item?.name === selected)
    : null;
  if (proxy?.type === 'ss' && proxy.server && proxy.port && proxy.cipher && proxy.password) {
    return { kind: 'ss', name: selected };
  }
  if (document && Array.isArray(document.proxies) && document.proxies.length) {
    return { kind: 'clash', name: selected, clashDocument: document };
  }
  throw new Error('nodes without Clash profile');
}

test('lists Clash proxies without throwing on null document', () => {
  assert.deepEqual(listClashProxyNodes(null), []);
  assert.deepEqual(listClashProxyNodes({}), []);
});

test('selects Clash document when proxies exist', () => {
  const document = yaml.load(`
proxies:
  - name: NodeA
    type: vmess
    server: 1.2.3.4
    port: 443
`);
  const nodes = listClashProxyNodes(document);
  const selected = selectClashOrThrow(document, nodes, 'NodeA');
  assert.equal(selected.kind, 'clash');
  assert.equal(selected.name, 'NodeA');
});

test('throws clearly when SS-URI nodes have no Clash document (legacy fallback path)', () => {
  const nodes = [{ id: 'a', name: 'a', type: 'ss', server: '1.2.3.4', port: 8388 }];
  assert.throws(() => selectClashOrThrow(null, nodes, 'a'), /without Clash profile/);
});
