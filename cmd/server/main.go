package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"connectrpc.com/connect"
	lua "github.com/yuin/gopher-lua"

	"github.com/nats-io/nats.go"
	"github.com/thomas-maurice/natsgrpc/natsrpc"

	luav1 "github.com/thomas-maurice/testnats/gen/lua/v1"
	"github.com/thomas-maurice/testnats/gen/lua/v1/luav1connect"

	gluabase64 "github.com/thomas-maurice/glua/pkg/modules/base64"
	gluahash "github.com/thomas-maurice/glua/pkg/modules/hash"
	gluahex "github.com/thomas-maurice/glua/pkg/modules/hex"
	gluajson "github.com/thomas-maurice/glua/pkg/modules/json"
	gluak8s "github.com/thomas-maurice/glua/pkg/modules/kubernetes"
	gluak8sclient "github.com/thomas-maurice/glua/pkg/modules/k8sclient"
	gluaspew "github.com/thomas-maurice/glua/pkg/modules/spew"
	gluatemplate "github.com/thomas-maurice/glua/pkg/modules/template"
	gluatime "github.com/thomas-maurice/glua/pkg/modules/time"
	gluayaml "github.com/thomas-maurice/glua/pkg/modules/yaml"

	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

// k8sConfig holds the Kubernetes rest.Config if a cluster is available.
var k8sConfig *rest.Config

func initK8sConfig() {
	// Try in-cluster config first
	cfg, err := rest.InClusterConfig()
	if err == nil {
		k8sConfig = cfg
		log.Println("kubernetes: using in-cluster config")
		return
	}

	// Try KUBECONFIG env var or default path
	loadingRules := clientcmd.NewDefaultClientConfigLoadingRules()
	configOverrides := &clientcmd.ConfigOverrides{}
	kubeConfig := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(loadingRules, configOverrides)
	cfg, err = kubeConfig.ClientConfig()
	if err == nil {
		k8sConfig = cfg
		log.Println("kubernetes: using kubeconfig")
		return
	}

	log.Println("kubernetes: no cluster available, k8sclient module disabled")
}

type luaService struct{}

// logCapture is a gopher-lua module that captures print() output.
func logCaptureLoader(logs *[]string) lua.LGFunction {
	return func(L *lua.LState) int {
		mod := L.SetFuncs(L.NewTable(), map[string]lua.LGFunction{
			"write": func(L *lua.LState) int {
				msg := L.CheckString(1)
				*logs = append(*logs, msg)
				return 0
			},
		})
		L.Push(mod)
		return 1
	}
}

func (s *luaService) Execute(
	_ context.Context,
	req *connect.Request[luav1.ExecuteRequest],
) (*connect.Response[luav1.ExecuteResponse], error) {
	script := req.Msg.Script
	variables := req.Msg.Variables

	log.Printf("executing script (%d bytes, %d variables)", len(script), len(variables))

	var logs []string

	L := lua.NewState(lua.Options{
		SkipOpenLibs: false,
	})
	defer L.Close()

	// Preload glua modules
	L.PreloadModule("json", gluajson.Loader)
	L.PreloadModule("yaml", gluayaml.Loader)
	L.PreloadModule("time", gluatime.Loader)
	L.PreloadModule("hash", gluahash.Loader)
	L.PreloadModule("base64", gluabase64.Loader)
	L.PreloadModule("hex", gluahex.Loader)
	L.PreloadModule("template", gluatemplate.Loader)
	L.PreloadModule("kubernetes", gluak8s.Loader)
	L.PreloadModule("spew", gluaspew.Loader)
	if k8sConfig != nil {
		L.PreloadModule("k8sclient", gluak8sclient.Loader(k8sConfig))
	}
	L.PreloadModule("log", logCaptureLoader(&logs))

	// Override print to capture output
	L.SetGlobal("print", L.NewFunction(func(L *lua.LState) int {
		top := L.GetTop()
		parts := make([]string, 0, top)
		for i := 1; i <= top; i++ {
			parts = append(parts, L.ToStringMeta(L.Get(i)).String())
		}
		logs = append(logs, strings.Join(parts, "\t"))
		return 0
	}))

	// Inject variables as globals
	for k, v := range variables {
		L.SetGlobal(k, lua.LString(v))
	}

	resp := &luav1.ExecuteResponse{}

	// REPL-style evaluation: try to make the last expression into a return
	// value so users don't need to explicitly set a "result" global.
	stackBase := L.GetTop()

	modified := replScript(script)
	if err := L.DoString(modified); err != nil {
		// If the modified version fails to compile, try the original
		if modified != script {
			L.SetTop(stackBase)
			if err2 := L.DoString(script); err2 != nil {
				resp.Error = err2.Error()
				resp.Logs = logs
				return connect.NewResponse(resp), nil
			}
		} else {
			resp.Error = err.Error()
			resp.Logs = logs
			return connect.NewResponse(resp), nil
		}
	}

	// Check for return values on the stack first
	if L.GetTop() > stackBase {
		val := L.Get(stackBase + 1)
		if val != lua.LNil {
			resp.Result = luaValueToString(val)
		}
	}

	resp.Logs = logs
	return connect.NewResponse(resp), nil
}

// replScript rewrites a script so the last expression becomes a return
// statement, giving REPL-like "last value is the result" behavior.
func replScript(script string) string {
	lines := strings.Split(script, "\n")

	// Find last non-empty, non-comment line
	lastIdx := -1
	for i := len(lines) - 1; i >= 0; i-- {
		trimmed := strings.TrimSpace(lines[i])
		if trimmed != "" && !strings.HasPrefix(trimmed, "--") {
			lastIdx = i
			break
		}
	}
	if lastIdx < 0 {
		return script
	}

	lastLine := strings.TrimSpace(lines[lastIdx])

	// Already a return statement — nothing to do
	if strings.HasPrefix(lastLine, "return ") || lastLine == "return" {
		return script
	}

	// Skip lines that are clearly statements, not expressions
	if strings.HasPrefix(lastLine, "local ") ||
		strings.HasPrefix(lastLine, "if ") ||
		strings.HasPrefix(lastLine, "for ") ||
		strings.HasPrefix(lastLine, "while ") ||
		strings.HasPrefix(lastLine, "repeat") ||
		strings.HasPrefix(lastLine, "function ") ||
		lastLine == "end" ||
		lastLine == "else" ||
		lastLine == "until" {
		return script
	}

	// Try to make the last line a return
	modified := make([]string, len(lines))
	copy(modified, lines)
	modified[lastIdx] = "return " + lastLine
	return strings.Join(modified, "\n")
}

// luaValueToString converts a Lua value to a readable string representation.
func luaValueToString(val lua.LValue) string {
	switch v := val.(type) {
	case *lua.LTable:
		return luaTableToString(v)
	default:
		return val.String()
	}
}

func luaTableToString(tbl *lua.LTable) string {
	var parts []string
	isArray := true
	maxn := tbl.MaxN()

	if maxn > 0 {
		for i := 1; i <= maxn; i++ {
			val := tbl.RawGetInt(i)
			parts = append(parts, luaValueToString(val))
		}
	}

	tbl.ForEach(func(k, v lua.LValue) {
		if kn, ok := k.(lua.LNumber); ok && float64(kn) == float64(int(kn)) && int(kn) >= 1 && int(kn) <= maxn {
			return // already handled as array element
		}
		isArray = false
		parts = append(parts, fmt.Sprintf("%s = %s", k.String(), luaValueToString(v)))
	})

	if isArray && maxn > 0 {
		return "{" + strings.Join(parts, ", ") + "}"
	}
	return "{" + strings.Join(parts, ", ") + "}"
}

func main() {
	natsURL := os.Getenv("NATS_URL")
	if natsURL == "" {
		natsURL = nats.DefaultURL
	}
	subject := os.Getenv("NATS_SUBJECT")
	if subject == "" {
		subject = "rpc"
	}

	initK8sConfig()

	log.Printf("connecting to NATS at %s (subject prefix: %s)", natsURL, subject)

	nc, err := nats.Connect(natsURL)
	if err != nil {
		log.Fatalf("failed to connect to NATS: %v", err)
	}
	defer nc.Close()

	log.Printf("connected to NATS")

	mux := http.NewServeMux()
	path, handler := luav1connect.NewLuaServiceHandler(&luaService{})
	mux.Handle(path, handler)

	srv := natsrpc.NewServer(nc, mux, subject)
	if err := srv.Start(); err != nil {
		log.Fatalf("failed to start server: %v", err)
	}
	defer srv.Stop()

	log.Printf("lua execution server is running")

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh
	log.Println("shutting down")
}
