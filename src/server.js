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

function createTenantProxy(target, organization_id, host) {
	if (!target) return undefined;

	return new Proxy(target, {
		get(targetObject, property) {
			const original = targetObject[property];
			if (typeof original !== "function") return original;

			return function (...args) {
				if (args.length === 0) {
					args.push({ organization_id, host });
				} else if (typeof args[0] === "object" && args[0] !== null) {
					args[0].organization_id = organization_id;
					args[0].host = host;
				}

				return original.apply(targetObject, args);
			};
		}
	});
}

function createSandbox(envelope, workflowDefinition, organization_id, host) {
	const crud = createTenantProxy(server.crud, organization_id, host);
	const socket = createTenantProxy(server.wsManager, organization_id, host);
	const context = { organization_id, host, crud, wsManager: socket };
	const api = server.api?.send
		? { send: (request) => server.api.send(request, context) }
		: undefined;
	const workflows = {
		async run(request = {}) {
			const child = { ...request, organization_id, host };
			// Nested calls return to their caller; only the outer call sends a socket response.
			delete child.socket;
			const result = await run(child);
			if (result.error?.length) {
				throw new Error(result.error.map(error => error?.message || String(error)).join('; '));
			}
			return result;
		}
	};

	const sandbox = {
		payload: envelope,
		event: envelope.event,
		workflow: workflowDefinition,
		actions: Array.isArray(workflowDefinition.actions) ? [] : {},
		crud,
		socket,
		wsManager: socket,
		api,
		workflows,
		fetch: (...args) => globalThis.fetch(...args),
		URL: globalThis.URL,
		organization_id,
		host
	};

	Object.assign(sandbox, {
		/**
		 *
 * @public
 * @environment server
 */
		$payload: sandbox.payload,
		$event: sandbox.event,
		/**
		 *
 * @public
 * @environment server
 */
		$workflow: sandbox.workflow,
		/**
		 *
 * @public
 * @environment server
 */
		$data: envelope,
		/**
		 *
 * @public
 * @environment server
 */
		$actions: sandbox.actions,
		/**
		 *
 * @public
 * @environment server
 */
		$crud: sandbox.crud,
		/**
		 *
 * @public
 * @environment server
 */
		$socket: sandbox.socket,
		/**
		 *
 * @public
 * @environment server
 */
		$wsManager: sandbox.wsManager,
		/**
		 *
 * @public
 * @environment server
 */
		$api: sandbox.api,
		$workflows: sandbox.workflows,
		/**
		 *
 * @public
 * @environment server
 */
		$fetch: sandbox.fetch,
		/**
		 *
 * @public
 * @environment server
 */
		$URL: sandbox.URL,
		$organization_id: organization_id,
		$host: host
	});

	return sandbox;
}

async function executeWorkflowActions(actions, sandbox) {
	if (!Array.isArray(actions) && (!actions || typeof actions !== "object")) {
		throw new Error("Workflow actions must be an object or an array of action objects.");
	}

	const results = Array.isArray(actions) ? [] : {};
	sandbox.actions = results;
	sandbox.$actions = results;

	const steps = Array.isArray(actions)
		? actions
		: Object.entries(actions).map(([name, action]) => ({ [name]: action }));

	for (const [index, step] of steps.entries()) {
		const result = await astAsync({ executeAST: step, sandbox });
		if (Array.isArray(results)) results[index] = result;
		else if (result && typeof result === "object") Object.assign(results, result);
	}

	return results;
}

/**
 * Loads a workflow record by the workflow name in the method or by ID,
 * evaluates its AST actions and output mapping, and writes the evaluated data
 * back to the same invocation envelope.
 * Errors are appended to the envelope's error array.
 *
 * Invocation shape: { method: "workflow.<name>", <name>: [ ...inputs ], organization_id, host }
 * Workflow record shape: { _id, name, enabled, actions }
 * @public
 * @environment server
 */
async function run(envelope = {}) {
	try {
		if (!server?.crud?.send) {
			throw new Error("CoCreate Workflows has not been initialized with a server.");
		}

		const methodParts = String(envelope.method || "").split(".");
		const workflowName = methodParts[0] === "workflow"
			? methodParts.slice(1).join(".")
			: "";
		if (!workflowName) {
			throw new Error("A workflow name is required in method workflow.<name>.");
		}

		const organization_id = envelope.socket?.organization_id || envelope.organization_id;
		const host = envelope.socket?.host || envelope.host;
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

		const sandbox = createSandbox(envelope, workflowDefinition, organization_id, host);
		await executeWorkflowActions(workflowDefinition.actions, sandbox);
	} catch (error) {
		if (!Array.isArray(envelope.error)) {
			envelope.error = envelope.error ? [envelope.error] : [];
		}
		envelope.error.push(error?.message || String(error));
	}

	if (envelope.socket && server?.send) {
		return server.send(envelope);
	}
	return envelope;
}

/**
 * Handles inbound workflow HTTP requests and authorizes the named invocation before execution.
 * @param {object} req - Native HTTP request.
 * @param {object} res - Native HTTP response.
 * @returns {Promise<void>}
 * @public
 * @environment server
 */
async function http(req, res) {
    const reply = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return reply(405, { error: 'Use POST for this operation.' });
    }
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return reply(415, { error: 'An application/json body is required.' });
    }
    let input;
    try {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
            const buffer = Buffer.from(chunk);
            size += buffer.length;
            if (size > 1024 * 1024) return reply(413, { error: 'Request body exceeds 1 MiB.' });
            chunks.push(buffer);
        }
        input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
    } catch {
        return reply(400, { error: 'A JSON object is required.' });
    }

    const bearer = req.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const apikey = bearer || input.apikey;
    if ((apikey !== undefined && (typeof apikey !== 'string' || !apikey.trim())) ||
        (bearer && input.apikey !== undefined && input.apikey !== bearer)) {
        return reply(401, { error: 'A valid API key is required.' });
    }

    try {
        const host = new URL(`https://${req.headers.host}`).hostname;
        const organization = await server.crud.getOrganization({ host });
        if (!organization?._id || organization.error) return reply(404, { error: 'Organization not found.' });
        const path = (req.url || '').split('?')[0];
        const name = decodeURIComponent(path.slice('/workflows/'.length));
        if (!name || name.includes('/') || (input.method !== undefined && input.method !== `workflow.${name}`)) {
            return reply(400, { error: 'A matching workflow name is required.' });
        }
        const envelope = { method: `workflow.${name}`, ...pickHttpFields(input, [name]) };
        // Scope and identity are server-resolved, never supplied by the caller.
        Object.assign(envelope, { organization_id: organization._id, host, apikey });
        const request = await server.authorize?.request(envelope);
        if (!request) return reply(403, { error: 'Operation is not authorized.' });
        const result = await server.workflow.run(request);
        const failed = result?.success === false || hasHttpErrors(result?.error);
        return reply(failed ? 400 : 200, result);
    } catch (error) {
        if (error.code === 'AUTHORIZATION_DENIED') return reply(403, { error: error.message });
        return reply(500, { error: 'Unable to process the operation.' });
    }
}

function hasHttpErrors(error) {
    return Array.isArray(error) ? error.length > 0 : Boolean(error);
}

function pickHttpFields(input, fields) {
    return Object.fromEntries(fields.filter(field => Object.hasOwn(input, field)).map(field => [field, input[field]]));
}

const API = { run, http };

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

const Workflows = { init, run, http };

export { init, run, http };
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
