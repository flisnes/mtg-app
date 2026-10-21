import { describe, expect, it } from 'vitest';
import { parseEndpoints, resolveServerBase, serverUrls } from '../src/endpoints.js';

// The server address is picked at run time from endpoints.json, a baked env
// var or the dev default. The precedence and the derived service URLs are
// pure, so they test without a browser.

describe('parseEndpoints', () => {
  it('accepts an https origin and strips trailing slashes', () => {
    expect(parseEndpoints({ server: 'https://79-76-41-163.sslip.io/' })).toEqual({
      server: 'https://79-76-41-163.sslip.io',
    });
    expect(parseEndpoints({ server: ' http://localhost:8080 ', $comment: 'x' })).toEqual({
      server: 'http://localhost:8080',
    });
  });

  it('rejects anything that is not a bare http(s) origin', () => {
    expect(parseEndpoints(null)).toBeNull();
    expect(parseEndpoints('https://host')).toBeNull();
    expect(parseEndpoints({})).toBeNull();
    expect(parseEndpoints({ server: 42 })).toBeNull();
    expect(parseEndpoints({ server: 'wss://host/ws' })).toBeNull();
    expect(parseEndpoints({ server: 'https://host/api' })).toBeNull();
    expect(parseEndpoints({ server: 'https://' })).toBeNull();
    expect(parseEndpoints({ server: 'javascript:alert(1)' })).toBeNull();
  });
});

describe('resolveServerBase', () => {
  const runtime = { server: 'https://new.example' };

  it('prefers the runtime answer over the baked URL and the dev default', () => {
    expect(resolveServerBase({ runtime, bakedWsUrl: 'wss://old.example/ws', dev: true })).toBe('https://new.example');
  });

  it('falls back to the baked relay URL, converting it to an http origin', () => {
    expect(resolveServerBase({ runtime: null, bakedWsUrl: 'wss://old.example/ws', dev: false })).toBe(
      'https://old.example',
    );
    expect(resolveServerBase({ runtime: null, bakedWsUrl: 'ws://localhost:9999/ws', dev: false })).toBe(
      'http://localhost:9999',
    );
  });

  it('uses the dev relay only in dev, and nothing otherwise', () => {
    expect(resolveServerBase({ runtime: null, bakedWsUrl: undefined, dev: true })).toBe('http://localhost:8080');
    expect(resolveServerBase({ runtime: null, bakedWsUrl: undefined, dev: false })).toBeNull();
  });
});

describe('serverUrls', () => {
  it('derives the relay, API and scan-data URLs the way the old env var did', () => {
    expect(serverUrls('https://79-76-41-163.sslip.io')).toEqual({
      ws: 'wss://79-76-41-163.sslip.io/ws',
      api: 'https://79-76-41-163.sslip.io/api',
      scan: 'https://79-76-41-163.sslip.io/scan/',
    });
    expect(serverUrls('http://localhost:8080').ws).toBe('ws://localhost:8080/ws');
  });
});
