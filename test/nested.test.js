import assert from 'node:assert/strict';
import test from 'node:test';
import Workflows from '../src/server.js';

async function initialize(child) {
    const requests = [];
    const sent = [];
    const definitions = {
        orgConnected: {
            name: 'orgConnected',
            actions: {
                vm: {
                    '$workflows.run': {
                        method: 'workflow.createVM',
                        organization_id: 'tenant',
                        host: 'tenant.test',
                        socket: { organization_id: 'tenant', host: 'tenant.test' },
                        createVM: [{ cluster_id: '$payload.orgConnected.0.cluster_id' }]
                    }
                },
                '$data.orgConnected.0.server': '$actions.vm.createVM.0.server',
                '$data.orgConnected.0.finished': true
            }
        },
        createVM: child
    };
    await Workflows.init({
        crud: {
            async send(request) {
                requests.push(structuredClone(request));
                if (request.array === 'workflows') {
                    const definition = definitions[request.filter.query.name];
                    return { object: definition ? [definition] : [] };
                }
                return { object: [{ _id: 'server-1', cluster_id: request.filter.query.cluster_id }] };
            }
        },
        wsManager: { async send(envelope) { sent.push(envelope); return envelope; } }
    });
    return { requests, sent };
}

test('nested workflow returns outputs in platform scope and sends only the outer response', async () => {
    const { requests, sent } = await initialize({
        name: 'createVM',
        actions: {
            servers: { '$crud.send': {
                method: 'object.read', array: 'servers',
                organization_id: 'tenant', host: 'tenant.test',
                filter: { query: { cluster_id: '$payload.createVM.0.cluster_id' } }
            } },
            '$data.createVM.0.server': '$actions.servers.object.0'
        }
    });
    const envelope = {
        method: 'workflow.orgConnected',
        organization_id: 'untrusted-org', host: 'untrusted.test',
        socket: { organization_id: 'platform', host: 'platform.test' },
        orgConnected: [{ cluster_id: 'cluster-1' }]
    };
    const response = await Workflows.run(envelope);
    assert.equal(response, envelope);
    assert.equal(response.error, undefined);
    assert.deepEqual(response.orgConnected[0].server, { _id: 'server-1', cluster_id: 'cluster-1' });
    assert.equal(response.orgConnected[0].finished, true);
    assert.equal(requests.length, 3);
    for (const request of requests) {
        assert.equal(request.organization_id, 'platform');
        assert.equal(request.host, 'platform.test');
    }
    assert.deepEqual(sent, [envelope]);
});

test('a child error stops the parent before its remaining actions', async () => {
    const { sent } = await initialize({ name: 'createVM', enabled: false, actions: {} });
    const response = await Workflows.run({
        method: 'workflow.orgConnected',
        organization_id: 'platform', host: 'platform.test',
        orgConnected: [{ cluster_id: 'cluster-1' }]
    });
    assert.match(response.error[0], /createVM.*disabled/);
    assert.equal(response.orgConnected[0].finished, undefined);
    assert.deepEqual(sent, []);
});
