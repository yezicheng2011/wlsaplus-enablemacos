const assert = require('node:assert/strict');
const test = require('node:test');
const yaml = require('js-yaml');

const { listClashProxyNodes } = require('./mac-clash-controller.cjs');

test('lists Clash proxies without throwing on null document', () => {
  assert.deepEqual(listClashProxyNodes(null), []);
  assert.deepEqual(listClashProxyNodes({}), []);
});

test('lists nodes from a Clash subscription', () => {
  const document = yaml.load(`
proxies:
  - name: NodeA
    type: vmess
    server: 1.2.3.4
    port: 443
`);
  assert.deepEqual(listClashProxyNodes(document), [{
    id: 'NodeA',
    name: 'NodeA',
    type: 'vmess',
    server: '1.2.3.4',
    port: 443,
  }]);
});
