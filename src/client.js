import Actions from "@cocreate/actions";
import Observer from "@cocreate/observer";
import Socket from "@cocreate/socket-client";
import { astAsync, getData, setData } from "@cocreate/utils";

const registeredWorkflows = new Set();

function getWorkflowNames(element) {
	return (element?.getAttribute("workflow") || "")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
}

function getWorkflowContainer(element, name) {
	let container = element?.closest?.("[workflow]");

	while (container) {
		if (getWorkflowNames(container).includes(name)) return container;
		container = container.parentElement?.closest?.("[workflow]");
	}

	return null;
}

function hasWorkflowKeys(form, name) {
	const keyAttribute = `${name}-key`;
	if (form?.hasAttribute?.(keyAttribute)) return true;
	const elements = [
		...(form?.elements || []),
		...(form?.querySelectorAll?.("*") || [])
	];
	return elements.some((element) => element.hasAttribute?.(keyAttribute));
}

function getErrorMessage(error) {
	const lastError = Array.isArray(error) ? error.at(-1) : error;
	if (typeof lastError === "string") return lastError;
	return lastError?.message || (lastError ? String(lastError) : "Workflow request failed.");
}

async function resolveWorkflowResult(name, response, element) {
	const result = response?.[name];
	if (typeof result !== "string" || !result.trim().startsWith("$")) return result;

	return astAsync({
		executeAST: result,
		node: element,
		sandbox: {
			$this: element,
			$payload: response,
			payload: response,
			$response: response,
			response
		}
	});
}

async function invokeWorkflow(name, value, element) {
	if (!name) throw new Error("A workflow name is required.");
	if (!getWorkflowContainer(element, name)) {
		throw new Error(`No workflow container declares '${name}'.`);
	}

	if (value === element || value === element?.attributes) {
		const attributes = {};
		for (const attribute of element.attributes) {
			if (["workflow", "input"].includes(attribute.name)) continue;
			attributes[attribute.name] = await element.getAttributeAsync(attribute.name);
		}
		if (typeof element.getValueAsync === "function") {
			attributes.value = await element.getValueAsync();
		} else if (typeof element.getValue === "function") {
			attributes.value = await element.getValue();
		}
		value = attributes;
	}

	const workflowInput = Array.isArray(value) ? value : [value];
	const response = await Socket.send({
		method: `workflow.${name}`,
		[name]: workflowInput,
		broadcast: false,
		broadcastClient: false
	});

	if (response?.error) throw new Error(getErrorMessage(response.error));

	return resolveWorkflowResult(name, response, element);
}

function attachWorkflowMethod(element) {
	if (typeof element.workflow === "function") return;

	Object.defineProperty(element, "workflow", {
		configurable: true,
		enumerable: false,
		value: (name, value) => invokeWorkflow(name, value, element)
	});
}

function finishWorkflowTrigger(action, type, detail) {
	if (typeof action[type] === "function") {
		action[type](detail);
		return;
	}

	action.element.dispatchEvent(new CustomEvent(type === "abort" ? "workflowAbort" : "workflowEnd", {
		bubbles: true,
		detail
	}));
}

async function runWorkflow(name, action) {
	const container = getWorkflowContainer(action.element, name);
	if (!container) {
		finishWorkflowTrigger(action, "abort", {
			code: "workflow-container-not-found",
			message: `No workflow container declares '${name}'.`
		});
		return;
	}

	try {
		const dataElement = action.dataElement;
		const dataForm = dataElement || container;
		const shouldSetData = hasWorkflowKeys(dataForm, name);
		const payload = await getData({ form: dataForm, prefix: name });
		const response = await Socket.send({
			method: `workflow.${name}`,
			[name]: [payload],
			broadcast: false,
			broadcastClient: false
		});

		if (response?.error) {
			finishWorkflowTrigger(action, "abort", {
				code: "workflow-request-failed",
				message: getErrorMessage(response.error)
			});
			return;
		}

		const result = await resolveWorkflowResult(
			name,
			response,
			dataElement || action.element
		);

		if (shouldSetData && result !== undefined) {
			setData({
				form: container,
				prefix: name,
				data: { [name]: result }
			});
		}
		finishWorkflowTrigger(action, "end", { [name]: result });
	} catch (error) {
		finishWorkflowTrigger(action, "abort", {
			code: "workflow-request-failed",
			message: error?.message || String(error),
			cause: error
		});
	}
}

function registerWorkflow(name) {
	if (!name) return;

	if (!registeredWorkflows.has(name)) {
		registeredWorkflows.add(name);
		Actions.init({
			name,
			callback: (action) => runWorkflow(name, action)
		});
	}
}

/**
 * Registers workflow Actions and initializes the workflow method on existing or supplied workflow scopes and descendant input AST elements.
 *
 * @public
 * @environment client
 */
function init(elements) {
	if (!elements) elements = document.querySelectorAll("[workflow]");
	else if (!Array.isArray(elements) && !elements[Symbol.iterator]) elements = [elements];

	for (const element of elements) {
		attachWorkflowMethod(element);

		for (const name of getWorkflowNames(element)) {
			registerWorkflow(name);
		}
	}
}

Observer.init({
	name: "workflowNodeObserver",
	types: ["addedNodes"],
	selector: "[workflow]",
	callback: (mutation) => init(mutation.target)
});

Observer.init({
	name: "workflowAttributeObserver",
	types: ["attributes"],
	selector: "[workflow]",
	attributeFilter: ["workflow"],
	callback: (mutation) => init(mutation.target)
});

init();

const WorkflowsClient = { init };

export { init };
export default WorkflowsClient;

/**
 *
 * @name default
 * @kind member
 * @public
 * @environment client
 */

/**
 * Available on initialized workflow elements and callable from AST as $workflow(name, value). Sends the value under the workflow name and evaluates AST expression strings returned under that same key.
 *
 * @name element.workflow
 * @kind member
 * @public
 * @signature workflow(name, value)
 * @environment client
 */

/**
 * Declares workflow names on a form scope and initializes workflow methods on the form and descendant input-AST elements.
 *
 * @name workflow
 * @kind attribute
 * @valueType comma-separated string
 * @environment client
 */

/**
 * Maps element values into the workflow request envelope using the named prefix. If keyed values were collected, the same-key workflow result is passed to setData.
 *
 * @name {name}-key
 * @kind attribute
 * @valueType string
 * @environment client
 */

/**
 * Loads and executes organization-scoped workflow records using CoCreate AST.
 *
 * @module workflows
 * @environment client
 */

/**
 * Declarative actions supported or registered by this module.
 *
 * @name declarative-actions
 * @kind member
 * @actions
 * @environment client
 * @example
 * ```json
 * [
 *   {
 *     "name": "{workflowName}",
 *     "description": "Runs the named workflow for its nearest declaring container."
 *   }
 * ]
 * ```
 */

/**
 * Declarative binding behavior for this module.
 *
 * @name declarative-binding
 * @kind member
 * @binding
 * @environment client
 * @example
 * ```json
 * {
 *   "selectors": [
 *     "[workflow]"
 *   ],
 *   "triggers": [
 *     "Actions invocation"
 *   ],
 *   "initializesExistingElements": true,
 *   "observesAddedNodes": true,
 *   "observesWorkflowAttribute": true
 * }
 * ```
 */

/**
 * Default export contract for this module.
 *
 * @name api-default-export
 * @kind member
 * @default-export
 * @environment client
 * @example
 * ```json
 * "WorkflowsClient"
 * ```
 */
