# CoCreate Workflows

Server-side execution of organization-scoped workflow records with CoCreate AST.
Workflow records are selected by their name in the socket method and are independent of API provider records.

## Workflow record

Store records in the `workflows` array:

```json
{
  "_id": "workflow-record-id",
  "name": "notify-users",
  "description": "Loads recipients and sends a workflow message.",
  "enabled": true,
  "actions": {
    "recipients": {
      "$crud.send": {
        "method": "object.read",
        "array": "users",
        "filter": {
          "query": { "_id": "$payload.notify-users.0.userId" },
          "limit": 1
        }
      }
    },
    "$data.recipients": "$actions.recipients.object"
  }
}
```

The record owns its name and AST. It does not require an `api_id`. Workflow
actions execute in declaration order, one at a time. `$actions` holds previous
action results. `$data` refers to the original socket envelope, so assignments
such as `$data.recipients` write directly onto the same object that is returned
to the client. There is no separate `data` mapping or output merge.

## Run a workflow

Initialize the module with the CoCreate server. The method identifies the
workflow; its same-named top-level property contains the input objects:

```js
import Workflows from "@cocreate/workflows";

const workflows = await Workflows.init(Server);
Server.socket.on("workflow", workflows.run);
const result = await workflows.run({
  method: "workflow.notify-users",
  organization_id,
  host,
  "notify-users": [{ userId: "user-record-id" }]
});

// result is the same envelope object, with workflow outputs merged in place.
```

The AST sandbox exposes `$payload`, `$event`, `$workflow`, `$crud`, `$socket`,
`$clientInfo`, and `$api.send` when the corresponding server service is
available. CRUD and socket calls are scoped to the invocation's organization
and host. `run()` mutates and returns the original envelope. Execution errors
are appended to the envelope's `error` array.

Workflow actions can await another workflow using `$workflows.run`:

```json
{
  "vm": {
    "$workflows.run": {
      "method": "workflow.createVM",
      "createVM": [{ "cluster_id": "$payload.orgConnected.0.cluster_id" }]
    }
  },
  "$data.orgConnected.0.server": "$actions.vm.createVM.0.server"
}
```

Nested workflows inherit the caller's top-level organization and host. They execute
internally and return their envelopes to the parent without calling `server.send()`.
Client destinations and the outer request UUID are stripped from child requests.
Only the outer invocation sends a transport response; child errors stop the parent's
remaining actions. `$workflow` still refers to the current workflow definition.
Managed infrastructure workflows must start in a trusted platform context and
build CRUD requests from trusted configuration, including database and storage
selection. Tenant organization IDs are ownership metadata. VM creation alone
does not establish readiness: routing must wait for the server lifecycle to
report a healthy node and a verified public address.

The server sandbox also provides `$fetch` and `$URL` for native server-side
requests and URL parsing. File conversions are shared AST globals:
`$encodeContent`, `$decodeContent`, `$getContentType`, `$getExtension`,
`$getExtensions`, and `$isTextContentType`. Calls to async APIs are awaited by
`astAsync`; methods such as `Response.arrayBuffer()` can be called using object
AST, for example `{ "$actions.response.arrayBuffer": [] }`.

## URL file workflow

[`demo/fileFromUrl.json`](./demo/fileFromUrl.json) defines `fileFromUrl`. Its
ordered AST actions fetch a URL, check the response, read its bytes, encode raw
Base64, fill in file metadata, upsert the file in the `files` array by host and
pathname, and replace the input with the saved record on the same
envelope. The workflow handler sends that envelope once after the actions finish.

The CoCreate App test page is `src/FileUploader.html`. It uses a generic workflow
form and CoCreate File's renderer, with no dependency on CoCreate URL Uploader or
File's special `importUrl` action:

```html
<form workflow="fileFromUrl">
  <input type="url" fileFromUrl-key="src" fileFromUrl-set-data="false"
         value="https://www.w3.org/Icons/w3c_home.png" required>
  <button type="submit" actions="validate, fileFromUrl">Import URL</button>
  <input id="imported-file" type="file" fileFromUrl-key="fileFromUrl"
         fileFromUrl-get-data="false" realtime="false" hidden>
</form>
<template file-for="imported-file">
  <p>{{object.name}} — {{object.size}} bytes</p>
</template>
```

The request key `src` builds the workflow input. The response controller's key
`fileFromUrl` selects the complete returned file from the response envelope.
Direction flags preserve the entered URL and exclude the output from requests.
CoCreate File renders the stored object. The demo accepts a destination directory
and cache/access policy and links to the saved pathname. The current host is used
unless explicitly supplied; files default to public caching when headers are omitted.
Importing the same host and pathname updates the existing record.

The wire format is `{ method: "workflow.fileFromUrl", fileFromUrl: [{ src: url }] }`.
The result replaces `fileFromUrl` with the file object containing `src` (raw
Base64), `name`, `size`, `content-type`, `directory`, `path`, and `pathname`.
The saved record also includes its database ID and host. Existing metadata is retained. Failures use the workflow envelope's `error` array.
Save the workflow record in the target organization and restart the server after
updating the sandbox bindings. The running client bundle must contain the shared
AST globals.

## Client workflow binding

Socket messages use `method: "workflow.<name>"` with the input under the same
top-level name, such as `{ method: "workflow.unique", unique: [...] }`. The
server registers the handler returned by `init()` on the `workflow` socket
event. It executes the selected workflow on the same envelope and sends it
back. Inputs are read from `$payload.<name>`. Since `$data` points to that same
envelope, actions can replace the consumed input with the result under the same
name. If that result is an AST expression string, the client evaluates it
against the triggering element; scalar and data-object results are returned as
values.

The `workflow` attribute declares one or more workflow names on a form scope.
It registers those names as Actions and initializes the workflow method on the
form and descendant elements with an `input` AST. Workflow does not install
native event listeners. Forms remain action-driven and collect `{name}-key`
fields.

Use Events and AST to invoke a workflow from an input or another event source:

```html
<form workflow="unique">
  <input array="organizations" object="" key="host[0].name"
    unique-key="host.name" value-suffix=".CoCreateJS.com"
    input="$workflow('unique', $this)" />
</form>
```

The call sends the input's attributes and `getValue()` result under `unique`.
Here, `key="host[0].name"` describes the input's data path, while
`unique-key="host.name"` independently tells this workflow which database path
to query. The workflow uses `$payload.unique.0.unique-key` as the filter key and
`$payload.unique.0.value` as the search value. This lets the form keep its own
field mapping while the workflow uses a database-appropriate path, such as a
dotted path that matches names inside an array.

`unique-key` is not a reserved Workflows attribute and the client does not give
it special behavior. It is ordinary input metadata included in the submitted
element attributes; the workflow AST decides how to use it. Workflows can accept
other metadata and values in the same way, use them to select arrays, keys,
filters, or actions, and write the result back under the workflow's method key.
That result can be a scalar, a data object, or an AST expression string. The
client evaluates returned AST expression strings against the triggering
element, allowing a workflow to declaratively update the element, for example
with `$this.setAttribute('unique', false)`. Form-level Actions use
`{name}-key` fields to build their request object and map same-key results back
to those fields.

See [`demo/workflow.json`](demo/workflow.json) and the [documentation](docs/index.html).

## HTTP entrance

Inbound workflow payloads use the central Cluster HTTP transport, which resolves organization scope and authorizes before calling `server.workflow.run`. Invoke a workflow with a payload such as `{ "method": "workflow.example", "example": [{ "input": "value" }] }`.

`run()` remains the execution API used by trusted internal calls and socket dispatch, where socket authorization already occurs. Nested workflows retain their existing scoped execution.

`$clientInfo` is a snapshot of the originating connection's existing metadata when
its organization and authenticated user match the invocation. It does not expose a
socket object and is absent when the originating connection is unavailable locally.
Onboarding can use its coordinates, falling back to the user's stored location.
