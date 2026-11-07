import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Workflows from '../src/server.js';

const definition = JSON.parse(fs.readFileSync(new URL('../demo/fileFromUrl.json', import.meta.url), 'utf8'));

async function setup() {
    const sent = [];
    const requests = [];
    await Workflows.init({
        crud: { send: async request => { requests.push(request); return { object: [request.method === "object.read" ? structuredClone(definition) : request.object] }; } },
        send: async envelope => { sent.push(envelope); return envelope; },
        wsManager: { send() { assert.fail("Workflow must use server.send"); } }
    });
    return { sent, requests };
}

test('URL workflow preserves bytes, metadata, tenant scope, and the original envelope', async t => {
    const bytes = Uint8Array.from({ length: 100000 }, (_, index) => index % 256);
    t.mock.method(globalThis, 'fetch', async url => {
        assert.equal(url, 'https://example.test/photo.png');
        return new Response(bytes, { headers: { 'content-type': 'image/png; charset=binary' } });
    });
    const { sent, requests } = await setup();
    const file = { src: 'https://example.test/photo.png', name: 'custom.png', path: '/images', custom: 'preserved' };
    const envelope = { method: 'workflow.fileFromUrl', uuid: 'request-1', fileFromUrl: [file], organization_id: 'org', host: 'example.test', socket: { purpose: 'ordinary payload' } };
    const result = await Workflows.run(envelope);
    assert.equal(result, envelope);
    assert.equal(sent[0], envelope);
    assert.equal(sent.length, 1);
    assert.equal(envelope.fileFromUrl, file);
    assert.equal(file.src, Buffer.from(bytes).toString('base64'));
    assert.equal(file.size, bytes.length);
    assert.equal(file['content-type'], 'image/png; charset=binary');
    assert.equal(file.pathname, '/images/custom.png');
    assert.equal(file.custom, 'preserved');
    assert.equal(requests[0].organization_id, 'org');
    assert.equal(requests[0].host, 'example.test');
    assert.equal(requests[0].filter.query.name, 'fileFromUrl');
    assert.equal(requests[1].method, 'object.update');
    assert.equal(requests[1].array, 'files');
    assert.equal(requests[1].upsert, true);
    assert.equal(requests[1].object, file);
    assert.deepEqual(requests[1].filter.query, { pathname: '/images/custom.png', host: 'example.test' });
    assert.equal(requests[1].organization_id, 'org');
    assert.equal(requests[1].host, 'example.test');
    assert.equal(envelope.workflowResponse, undefined);
    assert.equal(envelope.error, undefined);
});

test('URL workflow derives missing name, MIME type, and path without a second payload', async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response(Uint8Array.of(0, 255)));
    await setup();
    const response = await Workflows.run({ method: 'workflow.fileFromUrl', organization_id: 'org', host: 'example.test', fileFromUrl: [{ src: 'https://example.test/image.PNG?download=1' }] });
    assert.deepEqual(response.fileFromUrl, { src: 'AP8=', name: 'image.PNG', size: 2, 'content-type': 'image/png', directory: '/', path: '/', pathname: '/image.PNG', host: 'example.test', headers: { 'cache-control': 'public, max-age=3600' } });
    assert.equal(response.error, undefined);
});

test('URL workflow keeps empty files and applies a filename fallback', async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array()));
    await setup();
    const response = await Workflows.run({ method: 'workflow.fileFromUrl', organization_id: 'org', host: 'example.test', fileFromUrl: [{ src: 'https://example.test/' }] });
    assert.equal(response.fileFromUrl.name, 'downloaded_file');
    assert.equal(response.fileFromUrl.src, '');
    assert.equal(response.fileFromUrl.size, 0);
    assert.equal(response.fileFromUrl.pathname, '/downloaded_file');
});

test('URL workflow sends HTTP failures on the same envelope without replacing input', async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response('Missing', { status: 404, statusText: 'Not Found' }));
    const { sent } = await setup();
    const input = [{ src: 'https://example.test/missing.png' }];
    const envelope = { method: 'workflow.fileFromUrl', fileFromUrl: input, organization_id: 'org', host: 'example.test', socket: { purpose: 'ordinary payload' } };
    await Workflows.run(envelope);
    assert.deepEqual(envelope.error, ['Failed to fetch file: Not Found']);
    assert.equal(envelope.fileFromUrl, input);
    assert.equal(sent[0], envelope);
    assert.equal(sent.length, 1);
});

test('URL workflow validates its URL before fetching', async t => {
    const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Must not fetch'); });
    await setup();
    const response = await Workflows.run({ method: 'workflow.fileFromUrl', organization_id: 'org', host: 'example.test', fileFromUrl: [{ src: 'invalid' }] });
    assert.match(response.error[0], /Invalid URL/);
    assert.equal(fetch.mock.callCount(), 0);
});

 test('URL workflow reports failed persistence instead of returning an unsaved success', async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response('file'));
    await Workflows.init({ send: async data => data, crud: { send: async request => request.method === 'object.read'
        ? { object: [structuredClone(definition)] } : { error: ['Save failed'] } } });
    const response = await Workflows.run({ method: 'workflow.fileFromUrl', organization_id: 'org', host: 'example.test', fileFromUrl: [{ src: 'https://example.test/a.txt' }] });
    assert.deepEqual(response.error, ['Could not save imported file to files.']);
});

test('URL workflow returns the persisted record when an upsert also echoes the input', async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response('file'));
    await Workflows.init({ send: async data => data, crud: { send: async request => request.method === 'object.read'
        ? { object: [structuredClone(definition)] }
        : { object: [request.object, { ...request.object, _id: 'stored-id' }] } } });
    const response = await Workflows.run({ method: 'workflow.fileFromUrl', organization_id: 'org', host: 'example.test', fileFromUrl: [{ src: 'https://example.test/a.txt', headers: { 'cache-control': 'private' } }] });
    assert.equal(response.fileFromUrl._id, 'stored-id');
    assert.equal(response.fileFromUrl.headers['cache-control'], 'private');
    assert.equal(response.error, undefined);
});
