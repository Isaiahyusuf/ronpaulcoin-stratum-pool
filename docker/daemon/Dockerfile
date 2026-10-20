FROM ubuntu:16.04 AS builder

ARG DAEMON_REPO=https://github.com/corefork/ronpaulcoincore
ARG DAEMON_COMMIT=78e9303e7c6fa37d68d7333effb69d03ad3137d1
ARG JOBS=2

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential libtool autotools-dev automake pkg-config ca-certificates git \
    libssl-dev libevent-dev libboost-system-dev libboost-filesystem-dev \
    libboost-program-options-dev libboost-thread-dev libboost-chrono-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git init . && git fetch --depth 1 "$DAEMON_REPO" "$DAEMON_COMMIT" && git checkout FETCH_HEAD

RUN chmod +x autogen.sh share/genbuild.sh src/leveldb/build_detect_platform \
    && sh autogen.sh \
    && ./configure --disable-wallet --disable-tests --without-gui --without-miniupnpc \
    && make -j"$JOBS" -C src ronpaulcoind ronpaulcoin-cli \
    && strip src/ronpaulcoind src/ronpaulcoin-cli

RUN mkdir -p /licenses \
    && cp COPYING /licenses/ronpaulcoin-COPYING \
    && cp src/leveldb/LICENSE /licenses/leveldb-LICENSE \
    && cp src/json/LICENSE.txt /licenses/json_spirit-LICENSE \
    && sed -n '1,/\*\//p' src/scrypt.c > /licenses/scrypt.c-header \
    && sed -n '1,/\*\//p' src/scrypt.cpp > /licenses/scrypt.cpp-header \
    && cp /usr/share/doc/libssl1.0.0/copyright /licenses/openssl-1.0.x-copyright \
    && cp /usr/share/doc/libboost-system1.58.0/copyright /licenses/boost-1.58-copyright

FROM debian:bookworm-slim AS runtime

# Only the libraries Debian bookworm no longer ships are copied from the Ubuntu 16.04 builder.
# libstdc++, libgcc and glibc come from the current base image.
COPY --from=builder /lib/x86_64-linux-gnu/libssl.so.1.0.0 /lib/x86_64-linux-gnu/libcrypto.so.1.0.0 \
    /usr/lib/x86_64-linux-gnu/libboost_system.so.1.58.0 /usr/lib/x86_64-linux-gnu/libboost_filesystem.so.1.58.0 \
    /usr/lib/x86_64-linux-gnu/libboost_program_options.so.1.58.0 /usr/lib/x86_64-linux-gnu/libboost_thread.so.1.58.0 \
    /opt/ronpaulcoin/lib/
COPY --from=builder /src/src/ronpaulcoind /src/src/ronpaulcoin-cli /usr/local/bin/
COPY --from=builder /licenses /usr/share/doc/ronpaulcoin-daemon/licenses

ENV LD_LIBRARY_PATH=/opt/ronpaulcoin/lib
RUN useradd --uid 10001 --home-dir /data --shell /usr/sbin/nologin ronpaulcoin \
    && mkdir /data && chown ronpaulcoin /data
USER ronpaulcoin
WORKDIR /data
VOLUME /data
ENTRYPOINT ["ronpaulcoind"]
CMD ["-datadir=/data", "-printtoconsole"]

# Deployment image for hosts that configure services through environment variables (Railway). It adds only
# an entrypoint that writes a private config file from RPC_USER, RPC_PASSWORD and RPC_ALLOW_IP;
# extra container arguments are passed to ronpaulcoind and take precedence over the file.
# It is the last stage, so it is what a plain `docker build` produces; the harness builds `--target runtime`.
FROM runtime AS deploy
COPY --chmod=755 <<'ENTRYPOINT' /usr/local/bin/deploy-entrypoint.sh
#!/bin/sh
set -eu
: "${RPC_USER:?RPC_USER is required}"
: "${RPC_PASSWORD:?RPC_PASSWORD is required}"
: "${RPC_ALLOW_IP:?RPC_ALLOW_IP is required: a wildcard pattern matching only the pool service address}"
for value in "$RPC_USER" "$RPC_PASSWORD" "$RPC_ALLOW_IP"; do
    case "$value" in
        *[!A-Za-z0-9._:*@%+=/-]*) echo "RPC_USER, RPC_PASSWORD and RPC_ALLOW_IP may only contain letters, digits and . _ : * @ % + = / -" >&2; exit 2 ;;
    esac
done
case "${DAEMON_NETWORK:-mainnet}" in
    mainnet) network="" ;;
    testnet) network="-testnet" ;;
    regtest) network="-regtest" ;;
    *) echo "DAEMON_NETWORK must be mainnet, testnet or regtest" >&2; exit 2 ;;
esac
umask 077
conf=$(mktemp)
{
    echo "server=1"
    echo "listen=0"
    echo "rpcuser=$RPC_USER"
    echo "rpcpassword=$RPC_PASSWORD"
    echo "rpcallowip=$RPC_ALLOW_IP"
    if [ -n "${RPC_PORT:-}" ]; then echo "rpcport=$RPC_PORT"; fi
} > "$conf"
# shellcheck disable=SC2086
exec ronpaulcoind -conf="$conf" -datadir=/data -printtoconsole $network "$@"
ENTRYPOINT
ENTRYPOINT ["/usr/local/bin/deploy-entrypoint.sh"]
CMD []
