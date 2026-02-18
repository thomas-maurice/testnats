# Build Guidelines

This document explains how to build, develop, and extend the project. Aimed at developers and AI assistants.

## Prerequisites

- **Go** 1.26+
- **Node.js** 22+ with npm
- **Docker** with Compose (for deployment)
- **buf** CLI (only if regenerating protobuf code)

## Project Structure

```
.
├── cmd/
│   ├── server/main.go        # Lua execution server (NATS listener + glua VM)
│   ├── web/main.go           # Web API server (serves embedded UI + proxies to NATS)
│   └── client/main.go        # CLI demo client
├── web/                       # Frontend (npm + Vite project)
│   ├── package.json
│   ├── vite.config.js
│   ├── index.html             # Vite entry point (HTML template only)
│   ├── embed.go               # Go embed directive for dist/
│   └── src/
│       ├── main.js            # Vue app + highlight.js setup
│       ├── style.css          # All CSS (Tokyo Night theme)
│       └── examples.js        # Lua example scripts
├── proto/lua/v1/lua.proto     # Protobuf service definition
├── gen/lua/v1/                # Generated Go + ConnectRPC code
├── Dockerfile                 # Three-stage build (Node → Go → Alpine)
└── docker-compose.yml
```

## Architecture: NATS as RPC Transport

This project uses **NATS** as the transport layer for RPC calls instead of traditional HTTP/gRPC. This is the key architectural decision that makes the whole system work.

### How ConnectRPC-over-NATS works

Traditional RPC: `Client → HTTP/2 → gRPC Server`
This project: `Client → NATS message → Server subscribes and responds`

The library [natsgrpc](https://github.com/thomas-maurice/natsgrpc) provides this bridge. It implements the `http.RoundTripper` interface on the client side and an `http.Handler`-compatible server, but routes everything through NATS publish/subscribe instead of TCP connections.

**Server side** (`cmd/server/main.go`):
```go
// Connect to NATS
nc, _ := nats.Connect("nats://nats:4222")

// Create a natsgrpc server that listens on NATS subject prefix "rpc"
natsServer := natsrpc.NewServer(nc, "rpc")

// Register the ConnectRPC handler — same API as registering with http.ServeMux
path, handler := luav1connect.NewLuaServiceHandler(&luaService{})
natsServer.Handle(path, handler)
```

The server subscribes to NATS subjects matching the RPC path pattern (`rpc.lua.v1.LuaService.Execute`). When a message arrives, it deserializes the ConnectRPC request, calls the handler, and publishes the response back.

**Client side** (`cmd/web/main.go`):
```go
// Create an HTTP client that routes through NATS instead of TCP
httpClient := natsrpc.NewHTTPClient(nc, "rpc")

// Standard ConnectRPC client — doesn't know it's going over NATS
luaClient := luav1connect.NewLuaServiceClient(httpClient, "http://nats")
```

The `natsrpc.NewHTTPClient()` returns a standard `*http.Client` whose transport publishes HTTP requests as NATS messages and waits for the response on a reply subject. The ConnectRPC client doesn't know it's using NATS — it thinks it's making HTTP calls.

### NATS subject mapping

The NATS subject prefix is configurable (default: `rpc`). RPC calls are mapped to subjects:

```
Subject prefix: "rpc"
RPC method:     lua.v1.LuaService/Execute
NATS subject:   rpc.lua.v1.LuaService.Execute
```

This means you can have multiple independent services on the same NATS cluster by using different subject prefixes.

### Why NATS instead of direct HTTP?

- **Decoupling**: The web server and Lua server don't need to know each other's addresses. They just need to connect to the same NATS cluster.
- **Load balancing**: NATS queue groups automatically distribute requests across multiple server instances. Scale by adding more server pods.
- **Location transparency**: Services can be on different hosts, containers, or even clusters connected via NATS leaf nodes.
- **No service discovery needed**: No need for Consul, DNS, or Kubernetes service objects for inter-service communication.

### The Protobuf service

Defined in `proto/lua/v1/lua.proto`:

```protobuf
service LuaService {
  rpc Execute(ExecuteRequest) returns (ExecuteResponse) {}
}

message ExecuteRequest {
  string script = 1;                  // Lua code to execute
  map<string, string> variables = 2;  // Injected as Lua globals
}

message ExecuteResponse {
  string result = 1;    // Return value (last expression)
  string error = 2;     // Error message if execution failed
  repeated string logs = 3;  // Captured print() output
}
```

Generated Go code lives in `gen/lua/v1/` (protobuf types) and `gen/lua/v1/luav1connect/` (ConnectRPC client/server stubs).

### Data flow for a script execution

```
1. Browser sends HTTP POST /api/execute { script, variables }
2. cmd/web receives the HTTP request
3. cmd/web calls luaClient.Execute() — this is a ConnectRPC call
4. natsgrpc serializes the request and publishes to NATS subject "rpc.lua.v1.LuaService.Execute"
5. NATS routes the message to cmd/server (which is subscribed)
6. natsgrpc on the server side deserializes and calls the LuaService.Execute handler
7. The handler creates a fresh glua VM, injects variables, runs the script
8. Print output is captured, the last expression becomes the result
9. The handler returns ExecuteResponse { result, error, logs }
10. natsgrpc serializes the response and publishes back via NATS reply subject
11. cmd/web receives the response, adds timing info, returns JSON to the browser
```

### Docker Compose topology

```yaml
services:
  nats:     # NATS server — the message bus
  server:   # Lua executor — subscribes to NATS, runs glua VMs
  web:      # HTTP frontend — publishes to NATS, serves embedded UI
```

All three containers connect to the same NATS instance. The web server never talks directly to the Lua server.

## Web UI Architecture

The frontend is a Vue.js 3 single-page application bundled by Vite and embedded into the Go web server binary.

### Tech stack

- **Vue.js 3** (Composition API with `setup()` + `ref()` + `computed()`) — loaded with the full build that includes the runtime template compiler (`vue/dist/vue.esm-bundler.js` aliased in `vite.config.js`)
- **highlight.js** with the Lua language module — syntax highlighting in the editor
- **Vite** — bundler for production, dev server with HMR for development
- No CSS framework, no component library

### Why in-DOM templates (not SFCs)?

The app uses Vue's in-DOM template mode: the HTML template lives in `web/index.html` with Vue directives (`v-for`, `v-model`, `@click`, etc.), and the JS in `web/src/main.js` calls `createApp({ setup() { ... } }).mount('#app')`. This means:

- **No `.vue` single-file components** — no `@vitejs/plugin-vue` needed
- **Vue must include the template compiler** — hence the alias in `vite.config.js`:
  ```js
  resolve: {
    alias: { vue: 'vue/dist/vue.esm-bundler.js' }
  }
  ```
- The tradeoff is a larger bundle (~230KB vs ~130KB) but simpler project structure

### File breakdown

**`web/index.html`** — Pure HTML template with Vue directives. No `<script>` or `<style>` tags (except the Vite entry point `<script type="module" src="/src/main.js">`). This is the Vite entry point.

**`web/src/main.js`** — The entire application logic:
- Imports and registers highlight.js with Lua language support
- Creates the Vue app with reactive state (`ref()`)
- `highlighted` computed property runs `hljs.highlight()` on the script text
- `syncScroll()` keeps the highlight overlay in sync with the textarea
- `execute()` sends POST to `/api/execute` and handles the response
- `startDrag()` / mouse event handlers for resizable panes
- Exports everything to the template via `return { ... }`

**`web/src/style.css`** — All CSS in one file:
- CSS custom properties (`:root`) for the Tokyo Night color palette
- Layout: flexbox-based with sidebar (220px fixed) + editor area (flex: 1)
- Editor uses the "transparent textarea over highlighted pre" technique
- The drag handle between panes is a 5px div with `cursor: col-resize`

**`web/src/examples.js`** — Array of example objects with `name`, `script`, and `variables` fields. Each script is a JS template literal containing Lua code.

### The syntax highlighting technique

The editor is not CodeMirror or Monaco — it's a plain `<textarea>` with a trick:

```
┌─────────────────────────┐
│ <pre><code>  (visible,   │ ← Shows highlighted code, pointer-events: none
│   highlighted text)      │
├─────────────────────────┤
│ <textarea>  (on top,     │ ← Receives input, text is transparent
│   transparent text,      │    caret-color is visible
│   z-index: 1)            │
└─────────────────────────┘
```

- The `<textarea>` has `color: transparent` so its text is invisible, but `caret-color: var(--text)` so the cursor is visible
- The `<pre><code>` behind it shows the highlighted code via `v-html="highlighted"`
- On scroll, `syncScroll()` copies `scrollTop`/`scrollLeft` from textarea to pre
- Selection uses `::selection { background: rgba(...); color: transparent }` for a semi-transparent highlight

### Resizable panes

The editor and output panels can be resized by dragging the separator:

- The left pane uses `flex: 0 0 {editorWidth}%` (reactive, starts at 50%)
- A `.drag-handle` div sits between the panes (5px wide, `cursor: col-resize`)
- `startDrag()` attaches `mousemove`/`mouseup` listeners to the document
- The move handler calculates the percentage from mouse position, clamped to 20-80%
- The `.panes.dragging` class disables text selection during drag

### Embed pipeline

```
web/src/ + web/index.html
    │
    │  npm run build (Vite)
    ▼
web/dist/
    ├── index.html       (processed, with asset links injected)
    ├── assets/
    │   ├── index-*.js   (Vue + hljs + app code, ~230KB)
    │   └── index-*.css  (all styles, ~7KB)
    │
    │  go:embed all:dist  (web/embed.go)
    ▼
Go binary (cmd/web)
    │
    │  fs.Sub(web.DistFS, "dist")
    ▼
http.FileServer serves embedded files at /
```

## Build Pipeline

The build has three stages:

### 1. Build the UI

```bash
cd web
npm ci
npm run build
```

This produces `web/dist/` containing the bundled HTML, CSS, and JS.

### 2. Build the Go binaries

```bash
go build -o server ./cmd/server/
go build -o client ./cmd/client/
go build -o web-server ./cmd/web/
```

The `cmd/web` binary embeds `web/dist/` via `go:embed` (see `web/embed.go`). The `web/dist/` directory **must exist** before running `go build ./cmd/web/` — otherwise the embed directive will fail.

### 3. Docker (combines both stages)

```bash
docker compose up --build
```

The Dockerfile handles everything:

```
Stage 1 (node:22-alpine):     npm ci + vite build → web/dist/
Stage 2 (golang:1.26-alpine): go build (embeds web/dist/) → /server, /client, /web
Stage 3 (alpine:3.21):        runtime image with binaries only
```

The final image contains no Node.js, no Go toolchain, no source code — just three static binaries.

## Development

### UI development with hot reload

```bash
# Terminal 1: Start the backend
docker compose up nats server

# Terminal 2: Start Vite dev server
cd web
npm run dev
```

Vite proxies `/api` requests to `localhost:8080` (configured in `vite.config.js`). The dev server runs on `localhost:5173` with hot module replacement.

### Regenerate protobuf code

```bash
buf generate
```

Requires `buf`, `protoc-gen-go`, and `protoc-gen-connect-go`.

## Adding Examples

Edit `web/src/examples.js`. Each example is:

```javascript
{
  name: 'Example Name',       // Shown in sidebar
  script: `lua code here`,    // Template literal with Lua code
  variables: [                 // Pre-filled variables (shown in UI)
    { key: 'name', value: 'default' },
  ],
}
```

The last expression in a Lua script is automatically returned as the result (REPL-style evaluation). The server's `replScript()` function rewrites the last line as `return <expr>`. If that fails to compile, it falls back to the original script.

**Gotcha**: If the last expression starts with the `#` (length) operator (e.g. `#nodes .. " nodes"`), wrap it in `tostring()` or parentheses: `tostring(#nodes) .. " nodes"`. The `#` at column 1 is ambiguous in Lua 5.1's parser.

## Available Lua Modules

| Module | Require | Description |
|--------|---------|-------------|
| json | `require("json")` | JSON parse/stringify |
| yaml | `require("yaml")` | YAML parse/stringify |
| hash | `require("hash")` | MD5, SHA1, SHA256, SHA512 |
| base64 | `require("base64")` | Base64 encode/decode |
| hex | `require("hex")` | Hex encode/decode |
| template | `require("template")` | Go template rendering |
| time | `require("time")` | Time operations |
| kubernetes | `require("kubernetes")` | K8s quantity parsing, label/annotation helpers |
| k8sclient | `require("k8sclient")` | Live K8s CRUD (requires cluster access) |
| spew | `require("spew")` | Deep value inspection |

These modules come from [glua](https://github.com/thomas-maurice/glua) v0.0.12. Not all modules listed in glua's README exist in this version — `strings` and `regexp` are NOT available. Check the actual glua release tag before adding new module imports.

## Git-ignored paths

- `web/dist/` — UI build output (generated)
- `web/node_modules/` — npm dependencies (installed)
- `.kube/` — local Kubernetes credentials
- `/server`, `/client` — local Go build output

## Bootstrapping Guide for AI Assistants

If you're an AI assistant working on this codebase for the first time, here's what you need to know.

### Understanding the stack

1. **Read this file first** — you're doing that now
2. **Read `proto/lua/v1/lua.proto`** — the RPC contract, 27 lines, defines everything the system can do
3. **Read `cmd/server/main.go`** — the Lua execution engine, ~200 lines. Pay attention to `replScript()` (REPL-style evaluation) and how modules are loaded
4. **Read `cmd/web/main.go`** — the HTTP-to-NATS bridge, ~120 lines. Simple: one endpoint, one NATS client
5. **Read `web/src/main.js`** — the Vue app, ~100 lines. All UI state and logic

### Key libraries (read their READMEs before modifying)

- **[glua](https://github.com/thomas-maurice/glua)** — Go-to-Lua bridge. Check the actual version tag (v0.0.12) for available modules. Not everything in the README exists.
- **[natsgrpc](https://github.com/thomas-maurice/natsgrpc)** — ConnectRPC transport over NATS. The API is `natsrpc.NewServer(nc, subject)` and `natsrpc.NewHTTPClient(nc, subject)`.
- **[gopher-lua](https://github.com/yuin/gopher-lua)** — The Lua 5.1 VM. It's pure Go. `L.DoString()` runs code, `L.GetTop()` checks the stack, `L.SetTop()` resets it. Beware: `L.Pop()` can panic if the stack is in a bad state — use `L.SetTop(base)` instead.
- **[ConnectRPC](https://connectrpc.com)** — Type-safe RPC. Generated code is in `gen/`. The pattern is always: `NewXxxServiceHandler()` on the server, `NewXxxServiceClient()` on the client.

### Building and testing

```bash
# Full rebuild from scratch
docker compose down
docker compose up --build

# Quick test
curl -s http://localhost:8080/api/execute \
  -H 'Content-Type: application/json' \
  -d '{"script": "2 + 2", "variables": {}}' | jq
```

Expected output: `{"result": "4", "logs": [], "time_ms": N}`

### Common tasks

**Adding a new Lua module to the server:**
1. Check it exists in the glua version we use: `go doc github.com/thomas-maurice/glua/pkg/modules/<name>`
2. Import it in `cmd/server/main.go`
3. Add `L.PreloadModule("<name>", <loader>)` in the Execute handler
4. Add an example in `web/src/examples.js`

**Adding a new example:**
1. Edit `web/src/examples.js` — add an object to the array
2. Test the Lua script via curl first to make sure it works
3. Rebuild: `cd web && npm run build && docker compose up --build -d web`

**Changing the UI:**
1. HTML template is in `web/index.html` (Vue directives, no raw JS)
2. Styles in `web/src/style.css` (CSS custom properties for colors)
3. Logic in `web/src/main.js` (Vue Composition API)
4. For dev: `cd web && npm run dev` (hot reload on port 5173, proxies API to 8080)
5. For prod: `npm run build` then rebuild Docker

**Changing the RPC contract:**
1. Edit `proto/lua/v1/lua.proto`
2. Run `buf generate`
3. Update both `cmd/server/main.go` (handler) and `cmd/web/main.go` (client)

### Pitfalls to avoid

- **Don't import glua modules that don't exist** in the version pinned in go.mod. The glua README may document modules from a newer version. Always check the actual tag.
- **Don't use `L.Pop()` in error paths** — it panics. Use `L.SetTop(stackBase)` to safely reset the Lua stack.
- **The Vue build must include the template compiler** — we use in-DOM templates, not SFCs. The alias in `vite.config.js` (`vue: 'vue/dist/vue.esm-bundler.js'`) is required. Don't remove it.
- **`web/dist/` must exist before `go build ./cmd/web/`** — the `//go:embed all:dist` directive fails at compile time if the directory is missing. Always run `npm run build` first, or use Docker which handles the order.
- **Last-line expressions starting with `#`** (Lua length operator) need wrapping: `tostring(#x)` instead of bare `#x`. The REPL rewriter prepends `return`, but the fallback to the original script fails because bare `#x ..` isn't a valid Lua statement.
- **The `.kube/config` for Docker** must use token-based auth, not exec plugins (like `oidc-login`). Exec plugins require interactive browser auth that doesn't work in containers.
