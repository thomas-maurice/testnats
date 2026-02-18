export const examples = [
  {
    name: 'Hello World',
    script: `print("Hello from Lua over NATS!")
print("The script travels: Browser -> Go API -> NATS -> glua VM")

-- The last expression is automatically the result
"hello world"`,
    variables: [],
  },
  {
    name: 'Simple Math',
    script: `-- No need to set a result variable
-- The last expression is returned automatically
2 + 2`,
    variables: [],
  },
  {
    name: 'JSON Roundtrip',
    script: `local json = require("json")

local data = {
    name = name,
    language = "Lua",
    transport = "NATS",
    framework = "ConnectRPC",
}

local encoded = json.stringify(data)
print("Encoded: " .. encoded)

local decoded = json.parse(encoded)
print("Decoded name: " .. decoded.name)

encoded`,
    variables: [{ key: 'name', value: 'glua-nats-demo' }],
  },
  {
    name: 'K8s: Resource Calc',
    script: `local k8s = require("kubernetes")

-- Parse CPU quantities
local cpu_request = k8s.parse_cpu(cpu_req)
local cpu_limit = k8s.parse_cpu(cpu_lim)

-- Parse memory quantities
local mem_request = k8s.parse_memory(mem_req)
local mem_limit = k8s.parse_memory(mem_lim)

local replicas = tonumber(replica_count)

print("=== Per Pod ===")
print("CPU request:    " .. cpu_req .. " = " .. cpu_request .. " millicores")
print("CPU limit:      " .. cpu_lim .. " = " .. cpu_limit .. " millicores")
print("Memory request: " .. mem_req .. " = " .. mem_request .. " bytes (" .. string.format("%.1f", mem_request / 1024 / 1024) .. " MiB)")
print("Memory limit:   " .. mem_lim .. " = " .. mem_limit .. " bytes (" .. string.format("%.1f", mem_limit / 1024 / 1024) .. " MiB)")
print("")

print("=== Total for " .. replicas .. " replicas ===")
print("CPU request:    " .. (cpu_request * replicas) .. "m (" .. (cpu_request * replicas / 1000) .. " cores)")
print("CPU limit:      " .. (cpu_limit * replicas) .. "m (" .. (cpu_limit * replicas / 1000) .. " cores)")
print("Memory request: " .. string.format("%.1f", mem_request * replicas / 1024 / 1024) .. " MiB")
print("Memory limit:   " .. string.format("%.1f", mem_limit * replicas / 1024 / 1024) .. " MiB")
print("")

local burst = ((cpu_limit - cpu_request) / cpu_request) * 100
print("CPU burst headroom: " .. string.format("%.0f", burst) .. "%")

"Total: " .. (cpu_request * replicas) .. "m CPU, " .. string.format("%.0f", mem_request * replicas / 1024 / 1024) .. "Mi memory"`,
    variables: [
      { key: 'cpu_req', value: '250m' },
      { key: 'cpu_lim', value: '1' },
      { key: 'mem_req', value: '256Mi' },
      { key: 'mem_lim', value: '1Gi' },
      { key: 'replica_count', value: '3' },
    ],
  },
  {
    name: 'K8s: Pod Builder',
    script: `local k8s = require("kubernetes")
local yaml = require("yaml")

-- Build a Pod spec from scratch
local pod = {
    apiVersion = "v1",
    kind = "Pod",
    metadata = {
        name = pod_name,
        namespace = namespace,
    },
    spec = {
        containers = {
            {
                name = pod_name,
                image = image,
                ports = {
                    { containerPort = tonumber(port), protocol = "TCP" },
                },
                resources = {
                    requests = { cpu = "100m", memory = "128Mi" },
                    limits   = { cpu = "500m", memory = "512Mi" },
                },
                env = {
                    { name = "APP_ENV", value = "production" },
                    { name = "APP_PORT", value = port },
                },
                livenessProbe = {
                    httpGet = { path = "/healthz", port = tonumber(port) },
                    initialDelaySeconds = 10,
                    periodSeconds = 30,
                },
                readinessProbe = {
                    httpGet = { path = "/ready", port = tonumber(port) },
                    initialDelaySeconds = 5,
                    periodSeconds = 10,
                },
            },
        },
        restartPolicy = "Always",
    },
}

-- Use glua's k8s helpers to manage labels & annotations
k8s.add_labels(pod, {
    app = pod_name,
    version = "v1",
    ["app.kubernetes.io/name"] = pod_name,
    ["app.kubernetes.io/managed-by"] = "glua-nats",
})

k8s.add_annotations(pod, {
    ["generated-by"] = "glua over NATS",
    ["description"] = "Auto-generated pod for " .. pod_name,
})

print(yaml.stringify(pod))

"Pod " .. namespace .. "/" .. pod_name .. " generated"`,
    variables: [
      { key: 'pod_name', value: 'my-nginx' },
      { key: 'namespace', value: 'default' },
      { key: 'image', value: 'nginx:1.27-alpine' },
      { key: 'port', value: '8080' },
    ],
  },
  {
    name: 'K8s: Admission Policy',
    script: `local k8s = require("kubernetes")
local json = require("json")

-- Simulate an admission webhook: validate a resource
local resource = {
    apiVersion = "apps/v1",
    kind = "Deployment",
    metadata = {
        name = "test-deploy",
        namespace = "production",
        labels = {
            app = "test-app",
        },
    },
    spec = {
        replicas = tonumber(replicas),
        template = {
            spec = {
                containers = {
                    {
                        name = "app",
                        image = image,
                        resources = {
                            requests = { cpu = cpu_req, memory = mem_req },
                            limits   = { cpu = cpu_lim, memory = mem_lim },
                        },
                    },
                },
            },
        },
    },
}

local violations = {}

-- Policy 1: Must have required labels
local required_labels = {"app", "team", "environment"}
for _, label in ipairs(required_labels) do
    if not k8s.has_label(resource, label) then
        table.insert(violations, "DENY: missing required label '" .. label .. "'")
    end
end

-- Policy 2: No latest tag
if string.match(image, ":latest$") or not string.match(image, ":") then
    table.insert(violations, "DENY: image must use a specific tag, not :latest")
end

-- Policy 3: Resource limits must be set
local cpu_limit = k8s.parse_cpu(cpu_lim)
local mem_limit = k8s.parse_memory(mem_lim)

if cpu_limit > 4000 then
    table.insert(violations, "DENY: CPU limit " .. cpu_lim .. " exceeds max 4 cores")
end
if mem_limit > 8 * 1024 * 1024 * 1024 then
    table.insert(violations, "DENY: memory limit " .. mem_lim .. " exceeds max 8Gi")
end

-- Policy 4: Replicas in production
if tonumber(replicas) < 2 then
    table.insert(violations, "WARN: production deployments should have >= 2 replicas")
end

-- Policy 5: CPU request/limit ratio
local cpu_request = k8s.parse_cpu(cpu_req)
if cpu_limit / cpu_request > 10 then
    table.insert(violations, "WARN: CPU limit/request ratio > 10x (potential noisy neighbor)")
end

print("=== Admission Policy Check ===")
print("Resource: " .. resource.kind .. "/" .. resource.metadata.name)
print("Namespace: " .. resource.metadata.namespace)
print("")

if #violations == 0 then
    print("PASS: all policies satisfied")
else
    for _, v in ipairs(violations) do
        print("  " .. v)
    end
end

(#violations == 0) and "ADMITTED" or "REJECTED (" .. #violations .. " violations)"`,
    variables: [
      { key: 'image', value: 'myapp:v1.2.3' },
      { key: 'replicas', value: '1' },
      { key: 'cpu_req', value: '100m' },
      { key: 'cpu_lim', value: '2' },
      { key: 'mem_req', value: '256Mi' },
      { key: 'mem_lim', value: '2Gi' },
    ],
  },
  {
    name: 'K8s: Deployment Gen',
    script: `local k8s = require("kubernetes")
local yaml = require("yaml")

local deploy = {
    apiVersion = "apps/v1",
    kind = "Deployment",
    metadata = {
        name = app_name,
        namespace = namespace,
    },
    spec = {
        replicas = tonumber(replicas),
        selector = {
            matchLabels = { app = app_name },
        },
        strategy = {
            type = "RollingUpdate",
            rollingUpdate = {
                maxSurge = "25%",
                maxUnavailable = 0,
            },
        },
        template = {
            metadata = {},
            spec = {
                serviceAccountName = app_name,
                securityContext = {
                    runAsNonRoot = true,
                    runAsUser = 1000,
                    fsGroup = 1000,
                },
                containers = {
                    {
                        name = app_name,
                        image = image,
                        ports = {{ containerPort = 8080, name = "http" }},
                        resources = {
                            requests = { cpu = "100m",  memory = "128Mi" },
                            limits   = { cpu = "500m",  memory = "512Mi" },
                        },
                        securityContext = {
                            allowPrivilegeEscalation = false,
                            readOnlyRootFilesystem = true,
                            capabilities = { drop = { "ALL" } },
                        },
                        livenessProbe = {
                            httpGet = { path = "/healthz", port = "http" },
                            initialDelaySeconds = 15,
                            periodSeconds = 20,
                        },
                        readinessProbe = {
                            httpGet = { path = "/ready", port = "http" },
                            initialDelaySeconds = 5,
                            periodSeconds = 10,
                        },
                    },
                },
                topologySpreadConstraints = {
                    {
                        maxSkew = 1,
                        topologyKey = "kubernetes.io/hostname",
                        whenUnsatisfiable = "DoNotSchedule",
                        labelSelector = {
                            matchLabels = { app = app_name },
                        },
                    },
                },
            },
        },
    },
}

-- Add standard labels to both deployment and pod template
local standard_labels = {
    app = app_name,
    version = "v1",
    ["app.kubernetes.io/name"] = app_name,
    ["app.kubernetes.io/component"] = "server",
    ["app.kubernetes.io/managed-by"] = "glua",
}

k8s.add_labels(deploy, standard_labels)
k8s.ensure_metadata(deploy.spec.template)
k8s.add_labels(deploy.spec.template, standard_labels)

k8s.add_annotations(deploy, {
    ["deployment.kubernetes.io/revision"] = "1",
})

print(yaml.stringify(deploy))

"Deployment " .. namespace .. "/" .. app_name .. " (" .. replicas .. " replicas)"`,
    variables: [
      { key: 'app_name', value: 'api-server' },
      { key: 'namespace', value: 'production' },
      { key: 'image', value: 'myregistry.io/api-server:v2.1.0' },
      { key: 'replicas', value: '3' },
    ],
  },
  {
    name: 'K8s: Capacity Planner',
    script: `local k8s = require("kubernetes")

-- Define services and their resource requirements
local services = {
    { name = "api-gateway",  cpu = "500m",  mem = "512Mi",  replicas = 3 },
    { name = "auth-service", cpu = "250m",  mem = "256Mi",  replicas = 2 },
    { name = "user-service", cpu = "200m",  mem = "384Mi",  replicas = 2 },
    { name = "order-service",cpu = "300m",  mem = "512Mi",  replicas = 3 },
    { name = "payment-svc",  cpu = "400m",  mem = "256Mi",  replicas = 2 },
    { name = "notification", cpu = "100m",  mem = "128Mi",  replicas = 1 },
    { name = "cache",        cpu = "1",     mem = "2Gi",    replicas = 3 },
    { name = "database",     cpu = "2",     mem = "4Gi",    replicas = 1 },
}

local total_cpu = 0
local total_mem = 0

print(string.format("%-16s %6s %8s %4s %8s %10s", "SERVICE", "CPU", "MEMORY", "REPL", "TOT CPU", "TOT MEM"))
print(string.rep("-", 60))

for _, svc in ipairs(services) do
    local cpu = k8s.parse_cpu(svc.cpu)
    local mem = k8s.parse_memory(svc.mem)
    local svc_cpu = cpu * svc.replicas
    local svc_mem = mem * svc.replicas

    total_cpu = total_cpu + svc_cpu
    total_mem = total_mem + svc_mem

    print(string.format("%-16s %5dm %7.0fMi %4d %7dm %9.0fMi",
        svc.name, cpu, mem/1024/1024, svc.replicas,
        svc_cpu, svc_mem/1024/1024))
end

print(string.rep("-", 60))
print(string.format("%-16s %25s %8.1f %10.0fMi", "TOTAL", "", total_cpu/1000, total_mem/1024/1024))

-- Node sizing recommendation
local node_cpu = k8s.parse_cpu(node_size_cpu)
local node_mem = k8s.parse_memory(node_size_mem)
local nodes_by_cpu = math.ceil(total_cpu / (node_cpu * 0.8))  -- 80% allocatable
local nodes_by_mem = math.ceil(total_mem / (node_mem * 0.8))
local nodes_needed = math.max(nodes_by_cpu, nodes_by_mem)

print("")
print("=== Node Recommendation ===")
print("Node size: " .. node_size_cpu .. " CPU, " .. node_size_mem .. " memory")
print("Nodes needed (CPU-bound):  " .. nodes_by_cpu)
print("Nodes needed (Mem-bound):  " .. nodes_by_mem)
print("Minimum nodes:             " .. nodes_needed)
print("Recommended (HA, +1):      " .. (nodes_needed + 1))

nodes_needed + 1 .. " nodes recommended"`,
    variables: [
      { key: 'node_size_cpu', value: '4' },
      { key: 'node_size_mem', value: '16Gi' },
    ],
  },
  {
    name: 'K8s: Live Pods',
    script: `-- Query real pods from the cluster via k8sclient
-- Requires the server to have access to a Kubernetes cluster
local k8s = require("kubernetes")
local client = require("k8sclient")
local json = require("json")

local ns = namespace
local pods, err = client.list(client.POD, ns)
if err then
    error("failed to list pods: " .. err)
end

print("=== Pods in namespace '" .. ns .. "' ===")
print(string.format("%-40s %-12s %-8s %s", "NAME", "STATUS", "RESTARTS", "AGE"))
print(string.rep("-", 80))

local running = 0
local total = 0

for i = 1, #pods do
    local pod = pods[i]
    total = total + 1

    local name = pod.metadata.name
    local phase = pod.status.phase or "Unknown"

    -- Count restarts across all containers
    local restarts = 0
    if pod.status.containerStatuses then
        for _, cs in ipairs(pod.status.containerStatuses) do
            restarts = restarts + (cs.restartCount or 0)
        end
    end

    -- Calculate age
    local age = "unknown"
    if pod.metadata.creationTimestamp then
        local created = k8s.parse_time(pod.metadata.creationTimestamp)
        local now = os.time()
        local diff = now - created
        if diff < 60 then
            age = diff .. "s"
        elseif diff < 3600 then
            age = string.format("%.0fm", diff / 60)
        elseif diff < 86400 then
            age = string.format("%.0fh", diff / 3600)
        else
            age = string.format("%.0fd", diff / 86400)
        end
    end

    if phase == "Running" then running = running + 1 end

    print(string.format("%-40s %-12s %-8d %s", name, phase, restarts, age))
end

print(string.rep("-", 80))
print(string.format("Total: %d pods (%d running)", total, running))

-- Show resource usage summary
print("")
print("=== Container Images ===")
local images = {}
for i = 1, #pods do
    local pod = pods[i]
    if pod.spec.containers then
        for _, c in ipairs(pod.spec.containers) do
            local img = c.image
            images[img] = (images[img] or 0) + 1
        end
    end
end

for img, count in pairs(images) do
    print(string.format("  %dx %s", count, img))
end

total .. " pods found (" .. running .. " running)"`,
    variables: [
      { key: 'namespace', value: 'default' },
    ],
  },
  {
    name: 'K8s: Live Deployments',
    script: `-- Query deployments from the cluster and show rollout status
local k8s = require("kubernetes")
local client = require("k8sclient")
local yaml = require("yaml")

local ns = namespace
local deploys, err = client.list(client.DEPLOYMENT, ns)
if err then
    error("failed to list deployments: " .. err)
end

print("=== Deployments in namespace '" .. ns .. "' ===")
print(string.format("%-30s %-12s %-12s %-12s %s",
    "NAME", "READY", "UP-TO-DATE", "AVAILABLE", "AGE"))
print(string.rep("-", 85))

for i = 1, #deploys do
    local d = deploys[i]
    local name = d.metadata.name
    local status = d.status or {}

    local desired = d.spec.replicas or 1
    local ready = status.readyReplicas or 0
    local updated = status.updatedReplicas or 0
    local available = status.availableReplicas or 0

    local age = "?"
    if d.metadata.creationTimestamp then
        local created = k8s.parse_time(d.metadata.creationTimestamp)
        local diff = os.time() - created
        if diff < 3600 then
            age = string.format("%.0fm", diff / 60)
        elseif diff < 86400 then
            age = string.format("%.0fh", diff / 3600)
        else
            age = string.format("%.0fd", diff / 86400)
        end
    end

    local ready_str = ready .. "/" .. desired
    print(string.format("%-30s %-12s %-12d %-12d %s",
        name, ready_str, updated, available, age))
end

print("")
print("Total: " .. #deploys .. " deployments")

-- Show labels for each deployment
print("")
print("=== Labels ===")
for i = 1, #deploys do
    local d = deploys[i]
    local labels = {}
    if d.metadata.labels then
        for k, v in pairs(d.metadata.labels) do
            table.insert(labels, k .. "=" .. v)
        end
    end
    print("  " .. d.metadata.name .. ": " .. table.concat(labels, ", "))
end

tostring(#deploys) .. " deployments"`,
    variables: [
      { key: 'namespace', value: 'default' },
    ],
  },
  {
    name: 'K8s: Cluster Overview',
    script: `-- Get a high-level overview of cluster resources
local k8s = require("kubernetes")
local client = require("k8sclient")

-- List namespaces
local namespaces, err = client.list(client.NAMESPACE, "")
if err then
    error("failed to list namespaces: " .. err)
end

print("=== Namespaces ===")
for i = 1, #namespaces do
    local ns = namespaces[i]
    local phase = ns.status.phase or "?"
    print(string.format("  %-30s %s", ns.metadata.name, phase))
end
print("")

-- List nodes
local nodes, err = client.list(client.NODE, "")
if err then
    error("failed to list nodes: " .. err)
end

print("=== Nodes ===")
print(string.format("%-30s %-10s %-10s %-10s %s", "NAME", "STATUS", "CPU", "MEMORY", "VERSION"))
print(string.rep("-", 80))

for i = 1, #nodes do
    local node = nodes[i]
    local name = node.metadata.name

    -- Get status
    local status = "Unknown"
    if node.status.conditions then
        for _, cond in ipairs(node.status.conditions) do
            if cond.type == "Ready" then
                status = cond.status == "True" and "Ready" or "NotReady"
            end
        end
    end

    -- Get capacity
    local cpu = "?"
    local mem = "?"
    if node.status.capacity then
        cpu = node.status.capacity.cpu or "?"
        if node.status.capacity.memory then
            local bytes = k8s.parse_memory(node.status.capacity.memory)
            mem = string.format("%.1fGi", bytes / 1024 / 1024 / 1024)
        end
    end

    -- Get version
    local version = "?"
    if node.status.nodeInfo then
        version = node.status.nodeInfo.kubeletVersion or "?"
    end

    print(string.format("%-30s %-10s %-10s %-10s %s",
        name, status, cpu, mem, version))
end

print("")
print("Summary: " .. #namespaces .. " namespaces, " .. #nodes .. " nodes")

tostring(#nodes) .. " nodes, " .. tostring(#namespaces) .. " namespaces"`,
    variables: [],
  },
  {
    name: 'Hash + Base64',
    script: `local hash = require("hash")
local base64 = require("base64")
local hex = require("hex")

local message = secret_message
print("Message: " .. message)
print("")

print("SHA256: " .. hash.sha256(message))
print("MD5:    " .. hash.md5(message))
print("")

print("Base64: " .. base64.encode(message))
print("Hex:    " .. hex.encode(message))

hash.sha256(message)`,
    variables: [{ key: 'secret_message', value: 'NATS is awesome!' }],
  },
  {
    name: 'Go Templates',
    script: `local template = require("template")

local tmpl = [[Hello {{.Name}}!
Welcome to {{.Place}}.
Today's mood: {{.Mood}}.]]

local rendered = template.render(tmpl, {
    Name = user_name,
    Place = "the NATS-powered Lua executor",
    Mood = mood,
})

print(rendered)
rendered`,
    variables: [
      { key: 'user_name', value: 'World' },
      { key: 'mood', value: 'excited' },
    ],
  },
  {
    name: 'Fibonacci',
    script: `-- Compute Fibonacci numbers in Lua, executed over NATS
local n = tonumber(count)

local function fib(x)
    if x <= 1 then return x end
    return fib(x - 1) + fib(x - 2)
end

print("Fibonacci sequence (first " .. n .. " numbers):")
local results = {}
for i = 0, n - 1 do
    local f = fib(i)
    table.insert(results, tostring(f))
end
print(table.concat(results, ", "))

"fib(" .. (n-1) .. ") = " .. fib(n - 1)`,
    variables: [{ key: 'count', value: '20' }],
  },
  {
    name: 'Error Demo',
    script: `print("This will print before the error")

-- Intentional error: indexing nil
local x = nil
x.foo()

print("This will never print")`,
    variables: [],
  },
]
