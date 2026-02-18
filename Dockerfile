FROM golang:1.26-alpine AS builder

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 go build -o /server ./cmd/server/
RUN CGO_ENABLED=0 go build -o /client ./cmd/client/
RUN CGO_ENABLED=0 go build -o /web ./cmd/web/

FROM alpine:3.21

RUN apk add --no-cache ca-certificates kubectl

COPY --from=builder /server /usr/local/bin/server
COPY --from=builder /client /usr/local/bin/client
COPY --from=builder /web /usr/local/bin/web
COPY --from=builder /app/web /srv/web

ENTRYPOINT ["server"]
