import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import Workflows from '../src/server.js';
import { getData } from '../../utils/src/modules/getData.js';
import { setData } from '../../utils/src/modules/setData.js';

test('generic workflow form maps URL input to a CoCreate File result controller', async t => {
    const definition = JSON.parse(fs.readFileSync(new URL('../demo/fileFromUrl.json', import.meta.url), 'utf8'));
    t.mock.method(globalThis, 'fetch', async () => new Response(Uint8Array.of(0, 255), { headers: { 'content-type': 'image/png' } }));
    await Workflows.init({ crud: { send: async request => ({ object: [request.method === 'object.read' ? definition : request.object] }) } });
    const attributes = values => ({
        nodeType: 1,
        hasAttribute: name => Object.hasOwn(values, name.toLowerCase()),
        getAttribute: name => values[name.toLowerCase()] ?? null,
        closest: () => null
    });
    const input = {
        ...attributes({ 'filefromurl-key': 'src', 'filefromurl-set-data': 'false' }),
        getValue: () => 'https://example.test/image.png',
        setValue: () => assert.fail('URL input must retain its source URL')
    };
    let rendered;
    const controller = {
        ...attributes({ 'filefromurl-key': 'fileFromUrl', 'filefromurl-get-data': 'false' }),
        getValue: () => assert.fail('Output controller must not enter the request'),
        renderValue: value => { rendered = value; }
    };
    const form = {
        ...attributes({ workflow: 'fileFromUrl' }),
        elements: [input, controller],
        querySelectorAll: () => [input, controller]
    };
    const button = { closest: () => form };
    const source = fs.readFileSync(new URL('../src/client.js', import.meta.url), 'utf8');
    const functions = source.slice(source.indexOf('function getWorkflowNames('), source.indexOf('function registerWorkflow('));
    let ended;
    const runWorkflow = vm.runInNewContext(`(() => { ${functions}; return runWorkflow; })()`, {
        getData, setData,
        Socket: { send: async request => {
            assert.equal(request.method, 'workflow.fileFromUrl');
            assert.deepEqual(JSON.parse(JSON.stringify(request.fileFromUrl)), [{ src: 'https://example.test/image.png' }]);
            return Workflows.run({ ...request, organization_id: 'org', host: 'example.test' });
        } }
    });
    await runWorkflow('fileFromUrl', { element: button, end: value => { ended = value; }, abort: error => assert.fail(JSON.stringify(error)) });
    assert.equal(rendered.src, 'AP8=');
    assert.equal(rendered.name, 'image.png');
    assert.equal(rendered.size, 2);
    assert.equal(rendered['content-type'], 'image/png');
    assert.equal(ended.fileFromUrl, rendered);
});
