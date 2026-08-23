# syntax=docker/dockerfile:1

# ── build ────────────────────────────────────────────────────────────
FROM golang:1.25-alpine AS build

WORKDIR /src

# Dependencies first, so a change to the source does not re-download the module
# cache on every build.
COPY go.mod go.sum ./
RUN go mod download

COPY cmd/ ./cmd/
COPY internal/ ./internal/

ARG VERSION=dev
# CGO off and a stripped binary, because the final stage has no libc to link
# against and nothing here needs one. -X stamps the version the service reports in
# its startup log; what the two ends of the wire actually agree on is
# protocol.Version, which is compiled in and not settable from here on purpose.
ENV CGO_ENABLED=0
RUN go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/server ./cmd/server

# ── run ──────────────────────────────────────────────────────────────
# Static-distroless: no shell, no package manager, no libc. The attack surface of
# a compromised service is worth minimising — it is a process that holds live
# WebSockets into people's browsers — and there is nothing in the image for an
# attacker who reaches it to pivot with.
FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /out/server /server

# Non-root by default (the tag provides uid 65532). Nothing here writes to disk:
# every piece of state is co-terminous with a socket, so there is no volume, no
# datastore, and nothing to persist.
USER nonroot:nonroot

# The default port, which is also the one plaintext origin the app will accept
# (see internal/config.LocalMCPPort). Override with PORT.
EXPOSE 7391
ENV PORT=7391

# No HEALTHCHECK: the platform in front should probe /healthz itself, and a
# distroless image has no shell or curl to run one with. /healthz is deliberately
# not gated on capacity — see httpapi.handleHealth.
ENTRYPOINT ["/server"]
