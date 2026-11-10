import assert from 'node:assert/strict';
import test from 'node:test';
import { init } from '../src/server.js';

test('later steps can update and return an earlier named result', async () => {
    const definition = {
        name: 'cluster-config', enabled: true,
        actions: {
            cluster: { name: '$data.name' },
            script: 'ready',
            '$cluster.startupScript': '$script',
            '$payload.data': '$cluster'
        }
    };
    const service = await init({
        send: payload => payload,
        crud: { send: async () => ({ object: [definition] }) }
    });
    const result = await service.run({
        method: 'workflow.cluster-config', organization_id: 'platform', host: 'platform.test',
        data: { name: 'Production' }
    });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.data, { name: 'Production', startupScript: 'ready' });
    assert.deepEqual(definition.actions.cluster, { name: '$data.name' });
});
