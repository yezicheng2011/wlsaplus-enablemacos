const assert = require('node:assert/strict');
const test = require('node:test');
const { validateForumTheme, forumThemeCookies, emulateForumColorScheme, applyForumTheme } = require('./forum-theme.cjs');

const NOW = Date.UTC(2026, 9, 6, 2, 0, 0);

test('only light/dark themes are accepted', () => {
  assert.equal(validateForumTheme('light'), 'light');
  assert.equal(validateForumTheme('dark'), 'dark');
  for (const bad of ['system', '', undefined, 'dark; Domain=evil.com', { theme: 'dark' }]) {
    assert.throws(() => validateForumTheme(bad), /Unsupported forum theme/);
  }
});

test('theme + embed cookies are set on both forum origins: Secure, Path=/, SameSite=Lax, host-only', () => {
  const cookies = forumThemeCookies('dark', NOW);
  assert.deepEqual(cookies.map((c) => `${c.url} ${c.name}=${c.value}`), [
    'https://lt.spacehubxyz.hk/ wlsaplus_theme=dark',
    'https://lt.spacehubxyz.hk/ wlsaplus_embed=1',
    'https://lt.spacehubxyz.xn--j6w193g/ wlsaplus_theme=dark',
    'https://lt.spacehubxyz.xn--j6w193g/ wlsaplus_embed=1',
  ]);
  for (const cookie of cookies) {
    assert.equal(cookie.secure, true);
    assert.equal(cookie.path, '/');
    assert.equal(cookie.sameSite, 'lax');
    assert.equal(cookie.httpOnly, false);
    assert.equal(cookie.domain, undefined);
    assert.ok(cookie.expirationDate > NOW / 1000);
  }
});

function fakeGuest({ attached = false, failAttach = false, destroyed = false } = {}) {
  const sent = [];
  const guest = {
    isDestroyed: () => destroyed,
    debugger: {
      attachedVersion: null,
      isAttached: () => attached,
      attach(version) { if (failAttach) throw new Error('Another debugger is already attached'); attached = true; this.attachedVersion = version; },
      sendCommand: async (method, params) => { sent.push({ method, params }); },
    },
  };
  return { guest, sent };
}

test('emulates prefers-color-scheme on the guest (best effort)', async () => {
  const { guest, sent } = fakeGuest();
  assert.equal(await emulateForumColorScheme(guest, 'dark'), true);
  assert.equal(guest.debugger.attachedVersion, '1.3');
  assert.deepEqual(sent, [{ method: 'Emulation.setEmulatedMedia', params: { features: [{ name: 'prefers-color-scheme', value: 'dark' }] } }]);

  const busy = fakeGuest({ failAttach: true });
  assert.equal(await emulateForumColorScheme(busy.guest, 'dark'), false);
  const gone = fakeGuest({ destroyed: true });
  assert.equal(await emulateForumColorScheme(gone.guest, 'dark'), false);
  assert.equal(gone.sent.length, 0);
  assert.equal(await emulateForumColorScheme(null, 'dark'), false);
});

test('applyForumTheme writes cookies into the given (forum) session and updates live guests', async () => {
  const written = [];
  const session = { cookies: { set: async (cookie) => { written.push(cookie); } } };
  const a = fakeGuest();
  const b = fakeGuest({ attached: true });
  assert.equal(await applyForumTheme({ session, guests: new Set([a.guest, b.guest]), theme: 'light', now: NOW }), 'light');
  assert.equal(written.length, 4);
  assert.ok(written.every((c) => c.name === 'wlsaplus_embed' || c.value === 'light'));
  assert.equal(a.sent[0].params.features[0].value, 'light');
  assert.equal(b.sent[0].params.features[0].value, 'light');
  await assert.rejects(applyForumTheme({ session, theme: 'blue' }), /Unsupported forum theme/);
  assert.equal(written.length, 4);
});
