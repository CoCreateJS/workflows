import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Workflows from "../src/server.js";

const uniqueWorkflow = JSON.parse(
	await readFile(new URL("../demo/workflow.json", import.meta.url), "utf8")
);

function createServer(existingRecords) {
	const listeners = new Map();
	const sent = [];
	const crudRequests = [];

	return {
		crudRequests,
		sent,
		server: {
			crud: {
				async send(request) {
					crudRequests.push(request);
					if (request.array === "workflows") {
						return { object: [structuredClone(uniqueWorkflow)] };
					}
					if (request.array === "users") {
						return { object: existingRecords };
					}
					throw new Error(`Unexpected CRUD array: ${request.array}`);
				}
			},
			wsManager: {
				on(method, callback) {
					listeners.set(method, callback);
				},
				async send(envelope) {
					sent.push(envelope);
					return envelope;
				}
			},
			listener(method) {
				return listeners.get(method);
			}
		}
	};
}

async function initializeWorkflow(server) {
	const workflow = await Workflows.init(server);
	server.wsManager.on("workflow", workflow.run);
}

test("workflow socket handler runs AST with workflow data at the named top-level key", async () => {
	const { server, sent, crudRequests } = createServer([]);
	await initializeWorkflow(server);
	const envelope = {
		method: "workflow.unique",
		uuid: "request-1",
		socket: { organization_id: "org-1", host: "example.test" },
		unique: [{
			array: "users",
			key: "email",
			value: "person@example.test"
		}]
	};

	const response = await server.listener("workflow")(envelope);

	assert.equal(response, envelope);
	assert.equal(sent[0], envelope);
	assert.equal(envelope.unique, true);
	assert.deepEqual(crudRequests[1].filter.query, {
		email: "person@example.test"
	});
	assert.equal(crudRequests[1].organization_id, "org-1");
	assert.equal(crudRequests[1].host, "example.test");
});

test("unique workflow marks a match owned by another object as unavailable", async () => {
	const { server } = createServer([{ _id: "another-user" }]);
	await initializeWorkflow(server);
	const envelope = {
		uuid: "request-2",
		socket: { organization_id: "org-1", host: "example.test" },
		method: "workflow.unique",
		unique: [{
			array: "users",
			key: "email",
			value: "person@example.test",
			object: "current-user"
		}]
	};

	await server.listener("workflow")(envelope);

	assert.equal(envelope.unique, false);
});

test("unique workflow allows the current object's own value", async () => {
	const { server } = createServer([{ _id: "current-user" }]);
	await initializeWorkflow(server);
	const envelope = {
		uuid: "request-3",
		socket: { organization_id: "org-1", host: "example.test" },
		method: "workflow.unique",
		unique: [{
			array: "users",
			key: "email",
			value: "person@example.test",
			object: "current-user"
		}]
	};

	await server.listener("workflow")(envelope);

	assert.equal(envelope.unique, true);
});

test("unique workflow rejects another match even when the first belongs to the current object", async () => {
	const { server } = createServer([{ _id: "current-user" }, { _id: "another-user" }]);
	await initializeWorkflow(server);
	const envelope = {
		method: "workflow.unique",
		organization_id: "org-1", host: "example.test",
		unique: [{ array: "users", key: "email", value: "person@example.test", object: "current-user" }]
	};
	await Workflows.run(envelope);
	assert.equal(envelope.error, undefined);
	assert.equal(envelope.unique, false);
});
