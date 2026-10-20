#!/usr/bin/env bash
# Local regtest harness: two RonPaulCoin daemons on an internal Docker network
# (no published ports) and a Node container that runs the integration tests.
set -euo pipefail

NETWORK=rpc-regtest
IMAGE=${DAEMON_IMAGE:-rpc-daemon}
NODE_IMAGE=${NODE_IMAGE:-node:24-slim}
RPC_PORT=18443
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
ENV_FILE="$REPO_DIR/.env.regtest"

cli() {
    docker exec "$1" ronpaulcoin-cli -regtest -datadir=/d -rpcuser="$RPC_USER" -rpcpassword="$RPC_PASSWORD" -rpcport=$RPC_PORT "${@:2}"
}

load_credentials() {
    if [ ! -f "$ENV_FILE" ]; then
        umask 077
        printf 'RPC_USER=regtest\nRPC_PASSWORD=%s\n' "$(openssl rand -hex 24)" > "$ENV_FILE"
    fi
    # shellcheck disable=SC1090
    . "$ENV_FILE"
}

start_daemon() {
    local name=$1 connect=$2 subnet=$3
    docker volume create "$name-data" > /dev/null
    docker run --rm --platform linux/amd64 --user 0 --entrypoint chown -v "$name-data":/d "$IMAGE" 1000:1000 /d
    docker run -d --rm --init --platform linux/amd64 --name "$name" --network "$NETWORK" \
        --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 -v "$name-data":/d --tmpfs /tmp \
        --memory 512m "$IMAGE" -regtest -server -printtoconsole -datadir=/d \
        -rpcuser="$RPC_USER" -rpcpassword="$RPC_PASSWORD" -rpcport=$RPC_PORT \
        -rpcallowip="$subnet" -listen=1 -port=18444 -connect="$connect" > /dev/null
}

wait_for_rpc() {
    for _ in $(seq 1 60); do
        if cli "$1" getinfo > /dev/null 2>&1; then return 0; fi
        sleep 1
    done
    echo "daemon $1 did not answer RPC" >&2
    docker logs "$1" 2>&1 | tail -20 >&2
    return 1
}

up() {
    load_credentials
    docker network inspect "$NETWORK" > /dev/null 2>&1 || docker network create --internal "$NETWORK" > /dev/null
    local subnet
    subnet=$(docker network inspect -f '{{(index .IPAM.Config 0).Subnet}}' "$NETWORK")
    # the 0.9.1 daemon matches -rpcallowip with wildcards, not CIDR
    case "$subnet" in
        *.0.0/16) subnet="${subnet%.0.0/16}.*.*" ;;
        *) echo "unsupported network subnet $subnet" >&2; return 1 ;;
    esac
    start_daemon rpc-a 0 "$subnet"
    start_daemon rpc-b rpc-a "$subnet"
    wait_for_rpc rpc-a
    wait_for_rpc rpc-b
    for _ in $(seq 1 60); do
        if [ "$(cli rpc-a getconnectioncount)" -ge 1 ] && cli rpc-a getblocktemplate > /dev/null 2>&1; then
            echo "regtest nodes up, peered and out of initial download"
            return 0
        fi
        sleep 1
    done
    echo "nodes did not peer or are still in initial download" >&2
    return 1
}

down() {
    docker rm -fv rpc-a rpc-b > /dev/null 2>&1 || true
    docker volume rm rpc-a-data rpc-b-data > /dev/null 2>&1 || true
    docker network rm "$NETWORK" > /dev/null 2>&1 || true
}

container_ip() {
    docker inspect -f "{{(index .NetworkSettings.Networks \"$NETWORK\").IPAddress}}" "$1"
}

# Lets the test container ask for faults on the two daemons without access to the Docker socket.
control_loop() {
    local dir=$1 action target ip_rpc_a ip_rpc_b
    ip_rpc_a=$(container_ip rpc-a)
    ip_rpc_b=$(container_ip rpc-b)
    while true; do
        if [ -f "$dir/request" ]; then
            read -r action target < "$dir/request"
            rm -f "$dir/request"
            case "$target" in
                rpc-a|rpc-b) ;;
                *) echo "error: unknown target" > "$dir/response"; continue ;;
            esac
            case "$action" in
                disconnect) docker network disconnect "$NETWORK" "$target" ;;
                connect) docker network connect --ip "$([ "$target" = rpc-a ] && echo "$ip_rpc_a" || echo "$ip_rpc_b")" "$NETWORK" "$target" ;;
                pause) docker pause "$target" ;;
                unpause) docker unpause "$target" ;;
                restart) docker restart -t 20 "$target" && wait_for_rpc "$target" ;;
                *) echo "error: unknown action" > "$dir/response"; continue ;;
            esac > /dev/null 2>&1 && echo ok > "$dir/response" || echo "error: $action failed" > "$dir/response"
        fi
        sleep 0.2
    done
}

run_tests() {
    local files=("$@")
    [ ${#files[@]} -gt 0 ] || files=(test/integration/*.regtest.js)
    load_credentials
    local control_dir
    # must live under the home directory, which is the host path Colima shares with the VM
    control_dir=$(mktemp -d "$REPO_DIR/.regtest-control.XXXXXX")
    chmod 777 "$control_dir"
    control_loop "$control_dir" &
    local control_pid=$!
    local status=0
    docker run --rm --network "$NETWORK" --user node --read-only --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp --memory 1g \
        -v "$REPO_DIR":/app:ro -v "$control_dir":/control -w /app \
        -e DAEMON_HOSTS="rpc-a:$RPC_PORT,rpc-b:$RPC_PORT" \
        -e DAEMON_RPC_USER="$RPC_USER" -e DAEMON_RPC_PASSWORD="$RPC_PASSWORD" \
        "$NODE_IMAGE" node --test --test-concurrency=1 "${files[@]}" || status=$?
    kill "$control_pid" 2> /dev/null || true
    rm -rf "$control_dir"
    return $status
}

build() {
    docker build --platform linux/amd64 --target runtime -t "$IMAGE" "$REPO_DIR/docker/daemon"
}

case "${1:-}" in
    build) build ;;
    up) up ;;
    down) down ;;
    test) shift; down; up; trap down EXIT; run_tests "$@" ;;
    *) echo "usage: $0 build|up|down|test [test-file...]" >&2; exit 2 ;;
esac
