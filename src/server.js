/********************************************************************************
 * Copyright (C) 2026 CoCreate and Contributors.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 ********************************************************************************/

import { astAsync } from "@cocreate/utils";

let server;

function createTenantProxy(target, organization_id, host, allowOrganizationOverride = false) {
	if (!target) return undefined;

	return new Proxy(target, {
		get(targetObject, property) {
			const original = targetObject[property];
			if (typeof original !== "function") return original;

			return function (...args) {
				if (args.length === 0) {
					args.push({ organization_id, host });
				} else if (typeof args[0] === "object" && args[0] !== null) {
					if (!allowOrganizationOverride || !args[0].organization_id) {
						args[0].organization_id = organization_id;
					}
					args[0].host = allowOrganizationOverride ? (args[0].host || host) : host;
				}

				return original.apply(targetObject, args);
			};
		}
	});
}

function createWorkflowData(payload, workflowName) {
	const source = payload[workflowName] ?? payload.data ?? {};
	const data = source && typeof source === "object" ? source : {};

	return new Proxy(data, {
		get(data, property, receiver) {
			if (property in data) return Reflect.get(data, property, receiver);
			return property === workflowName ? payload[workflowName] : undefined;
		},
		set(data, property, value, receiver) {
			if (property === workflowName) payload[property] = value;
			else Reflect.set(data, property, value, receiver);
			return true;
		}
	});
}

function createSandbox(payload, workflowDefinition, workflowName, organization_id, host) {
	const allowOrganizationOverride =
		!server.manager?.organization_id && organization_id === server.organization_id;
	const crud = createTenantProxy(server.crud, organization_id, host, allowOrganizationOverride);
	const secureSocket = createTenantProxy({ send: payload => server.send(payload) }, organization_id, host);
	const context = { organization_id, host, crud, socket: secureSocket };
	const api = server.api?.send
		? { send: (request) => server.api.send(request, context) }
		: undefined;
	const workflows = {
		async run(request = {}, { throwOnError = true } = {}) {
			const child = { ...request, organization_id, host };
			// Nested work returns to its caller without inheriting client reply destinations.
			for (const field of ["socketId", "clientId", "uuid", "frameId", "replyOrganizationId",
				"broadcast", "broadcastClient", "broadcastSender", "subscription", "subscriptionKeys",
				"server", "worker", "cluster", "master", "serverId", "workerId", "clusterId", "response"]) {
				delete child[field];
			}
			const result = await execute(child);
			if (throwOnError && result.error?.length) {
				throw new Error(result.error.map(error => error?.message || String(error)).join('; '));
			}
			return result;
		}
	};

	const origin = server.socket?.sockets?.get(payload.socketId);
	const clientInfo = origin?.organization_id === organization_id && origin?.user_id === payload.user_id
		? structuredClone(origin.clientInfo) : undefined;

	const sandbox = {
		payload,
		clientInfo,
		data: createWorkflowData(payload, workflowName),
		event: payload.event,
		workflow: workflowDefinition,
		actions: Array.isArray(workflowDefinition.actions) ? [] : {},
		crud,
		socket: secureSocket,
		api,
		workflows,
		fetch: (...args) => globalThis.fetch(...args),
		URL: globalThis.URL,
		organization_id,
		host
	};

	return sandbox;
}

async function executeWorkflowActions(actions, sandbox) {
	if (!Array.isArray(actions) && (!actions || typeof actions !== "object")) {
		throw new Error("Workflow actions must be an object or an array of action objects.");
	}

	const results = Array.isArray(actions) ? [] : {};
	sandbox.actions = results;

	const steps = Array.isArray(actions)
		? actions
		: Object.entries(actions).map(([name, action]) => ({ [name]: action }));

	for (const [index, step] of steps.entries()) {
		const result = await astAsync({ executeAST: step, sandbox });
		if (Array.isArray(results)) results[index] = result;
		else if (result && typeof result === "object") {
			Object.assign(results, result);
			Object.assign(sandbox, result);
		}
	}

	return results;
}

/**
 * Loads a workflow record by the workflow name in the method or by ID,
 * evaluates its AST actions and output mapping, and writes the evaluated data
 * back to the same invocation payload.
 * Errors are appended to the payload's error array.
 *
 * Invocation shape: { method: "workflow.<name>", <name>: [ ...inputs ] | data, organization_id, host }
 * Workflow record shape: { _id, name, enabled, actions }
 * @private
 * @environment server
 */
async function execute(payload = {}) {
	try {
		if (!server?.crud?.send) {
			throw new Error("CoCreate Workflows has not been initialized with a server.");
		}

		const methodParts = String(payload.method || "").split(".");
		const workflowName = methodParts[0] === "workflow"
			? methodParts.slice(1).join(".")
			: "";
		if (!workflowName) {
			throw new Error("A workflow name is required in method workflow.<name>.");
		}

		const organization_id = payload.organization_id;
		const host = payload.host;
		if (!organization_id || !host) {
			throw new Error("organization_id and host are required to run a workflow.");
		}

		const workflowQuery = {
			method: "object.read",
			array: "workflows",
			organization_id,
			host
		};
		workflowQuery.filter = {
			query: { name: workflowName },
			limit: 2
		};

		const response = await server.crud.send(workflowQuery);

		const workflowDefinitions = Array.isArray(response?.object)
			? response.object
			: response?.object ? [response.object] : [];
		if (workflowDefinitions.length > 1) {
			throw new Error(`Workflow name '${workflowName}' is ambiguous; workflow names must be unique within an organization.`);
		}
		const workflowDefinition = workflowDefinitions[0];

		if (!workflowDefinition) {
			throw new Error(`Workflow '${workflowName}' was not found.`);
		}
		if (workflowDefinition.enabled === false) {
			throw new Error(`Workflow '${workflowName}' is disabled.`);
		}
		if (!workflowDefinition.actions || typeof workflowDefinition.actions !== "object") {
			throw new Error(`Workflow '${workflowName}' has no actions object.`);
		}

		const sandbox = createSandbox(payload, workflowDefinition, workflowName, organization_id, host);
		await executeWorkflowActions(workflowDefinition.actions, sandbox);
	} catch (error) {
		if (!Array.isArray(payload.error)) {
			payload.error = payload.error ? [payload.error] : [];
		}
		payload.error.push(error?.message || String(error));
	}

	return payload;
}

/**
 * Execute a workflow transport invocation and send its single final response.
 * Nested workflows execute internally; they do not send intermediate responses.
 * @public
 * @environment server
 */
async function run(payload = {}) {
	await execute(payload);
	try {
		Promise.resolve(server.send(payload)).catch(error => {
			console.error("[@cocreate/workflows] Response delivery failed:", error);
		});
	} catch (error) {
		console.error("[@cocreate/workflows] Response delivery failed:", error);
	}
	return payload;
}

const API = { run };

/**
 * Binds server services and returns the workflow handler for registration on the workflow socket event.
 *
 * @public
 * @environment server
 */
async function init(Server) {
	if (!Server?.crud?.send) {
		throw new Error("CoCreate Workflows requires Server.crud.send.");
	}
	server = Server;
	return API;
}

const Workflows = { init, run };

export { init, run };
export default Workflows;

/**
 *
 * @name default
 * @kind member
 * @public
 * @environment server
 */

/**
 * Loads and executes organization-scoped workflow records using CoCreate AST.
 *
 * @module workflows
 * @environment server
 */

/**
 * Default export contract for this module.
 *
 * @name api-default-export
 * @kind member
 * @default-export
 * @environment server
 * @example
 * ```json
 * "Workflows"
 * ```
 */
