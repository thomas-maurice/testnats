FROM node:22-alpine AS ui

WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.26-alpine AS builder

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .
COPY --from=ui /app/web/dist ./web/dist

RUN CGO_ENABLED=0 go build -o /server ./cmd/server/
RUN CGO_ENABLED=0 go build -o /client ./cmd/client/
RUN CGO_ENABLED=0 go build -o /web ./cmd/web/

FROM alpine:3.21

RUN apk add --no-cache ca-certificates kubectl

COPY --from=builder /server /usr/local/bin/server
COPY --from=builder /client /usr/local/bin/client
COPY --from=builder /web /usr/local/bin/web

ENTRYPOINT ["server"]
