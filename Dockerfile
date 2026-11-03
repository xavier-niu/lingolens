# syntax=docker/dockerfile:1

# ---- build ----
FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS build
WORKDIR /src

COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download

COPY . .
ARG TARGETOS
ARG TARGETARCH
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w" -o /out/lingolens ./cmd/lingolens
# An empty data directory, owned by the runtime's non-root user (uid 65532).
RUN mkdir -p /out/data

# ---- runtime ----
# distroless/static ships CA certificates (needed for HTTPS to LLM providers) and runs as non-root.
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/lingolens /lingolens
COPY --from=build --chown=65532:65532 /out/data /data
# The database and the key-encryption secret live in /data: mount a volume there.
ENV LINGOLENS_ADDR=0.0.0.0:8080 \
    LINGOLENS_DATA=/data
VOLUME /data
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/lingolens"]
