package main

import (
	"context"
	"encoding/json"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"connectrpc.com/connect"
	"github.com/nats-io/nats.go"
	"github.com/thomas-maurice/natsgrpc/natsrpc"

	luav1 "github.com/thomas-maurice/testnats/gen/lua/v1"
	"github.com/thomas-maurice/testnats/gen/lua/v1/luav1connect"
	webstatic "github.com/thomas-maurice/testnats/web"
)

type executeRequest struct {
	Script    string            `json:"script"`
	Variables map[string]string `json:"variables"`
}

type executeResponse struct {
	Result string   `json:"result"`
	Error  string   `json:"error,omitempty"`
	Logs   []string `json:"logs"`
	TimeMs int64    `json:"time_ms"`
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
	listenAddr := os.Getenv("LISTEN_ADDR")
	if listenAddr == "" {
		listenAddr = ":8080"
	}

	log.Printf("connecting to NATS at %s", natsURL)
	nc, err := nats.Connect(natsURL)
	if err != nil {
		log.Fatalf("failed to connect to NATS: %v", err)
	}
	defer nc.Close()

	httpClient := natsrpc.NewHTTPClient(nc, subject)
	luaClient := luav1connect.NewLuaServiceClient(httpClient, "http://nats")

	mux := http.NewServeMux()

	mux.HandleFunc("POST /api/execute", func(w http.ResponseWriter, r *http.Request) {
		var req executeRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}

		start := time.Now()

		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()

		resp, err := luaClient.Execute(ctx, connect.NewRequest(&luav1.ExecuteRequest{
			Script:    req.Script,
			Variables: req.Variables,
		}))

		elapsed := time.Since(start)

		out := executeResponse{
			TimeMs: elapsed.Milliseconds(),
		}

		if err != nil {
			out.Error = err.Error()
		} else {
			out.Result = resp.Msg.Result
			out.Error = resp.Msg.Error
			out.Logs = resp.Msg.Logs
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(out)
	})

	distFS, err := fs.Sub(webstatic.DistFS, "dist")
	if err != nil {
		log.Fatalf("failed to load embedded static files: %v", err)
	}
	mux.Handle("/", http.FileServer(http.FS(distFS)))

	srv := &http.Server{Addr: listenAddr, Handler: mux}

	go func() {
		log.Printf("web UI listening on %s", listenAddr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("http server error: %v", err)
		}
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	srv.Shutdown(ctx)
	log.Println("shutting down")
}
