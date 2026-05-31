FROM golang:1.26.1-alpine AS build

WORKDIR /src
COPY services/monitor/go.mod services/monitor/go.sum ./
RUN go mod download
COPY services/monitor ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/monitor ./cmd/monitor

FROM alpine:3.22 AS runtime

RUN adduser -D -H app
USER app

COPY --from=build /out/monitor /usr/local/bin/monitor
CMD ["monitor"]
