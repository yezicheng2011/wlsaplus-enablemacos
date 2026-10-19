import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {createPublicKey, verify} from 'node:crypto';
import test from 'node:test';

const fixture = new URL('./Fixtures/legacy-update-manifest.json', import.meta.url);
test('existing release signature uses the new updater trust anchor and envelope', {skip: !existsSync(fixture)}, () => {
  const envelope = JSON.parse(readFileSync(fixture, 'utf8'));
  const key = createPublicKey('-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAFdlAH6S/8HdZHKQ8MR0OnzWFUtAerd/mfJwy0jVsoNM=\n-----END PUBLIC KEY-----');
  assert.equal(envelope.format, 1);
  assert.equal(verify(null, Buffer.from(envelope.payload, 'utf8'), key, Buffer.from(envelope.signature, 'base64')), true);
  const payload = JSON.parse(envelope.payload);
  assert.equal(payload.product, 'wlsaplus-macos');
  assert.ok(payload.files.arm64 && payload.files.x64);
  assert.equal(verify(null, Buffer.from(envelope.payload + ' ', 'utf8'), key, Buffer.from(envelope.signature, 'base64')), false);
});
