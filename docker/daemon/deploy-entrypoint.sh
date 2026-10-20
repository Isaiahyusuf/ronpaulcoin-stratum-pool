#!/bin/sh
# Deployment entrypoint for ronpaulcoind on hosts that configure services through environment variables.
# The daemon matches -rpcallowip as an exact string (with * and ? wildcards) against the caller's address,
# and treats IPv4-mapped IPv6 callers as IPv4. Access is therefore granted either to an explicit pattern
# (RPC_ALLOW_IP) or to the exact addresses a host name resolves to at startup (RPC_ALLOW_HOST).
# It never falls back to a broad pattern: if nothing valid is configured or resolved, it exits.
#
# The pinned daemon cannot reload -rpcallowip (SIGHUP only reopens debug.log, there is no reload RPC), so the
# list is fixed at start. While RPC_ALLOW_HOST is used, a watcher re-resolves it every
# RPC_ALLOW_HOST_REFRESH_SECONDS (default 30, 0 disables). If a *non-empty* answer that differs from the
# active list repeats on two consecutive checks, the daemon is sent SIGTERM (a clean shutdown that flushes its
# databases) and this script exits 1, so the platform's restart policy starts a fresh container with the new
# list. A failed or empty lookup never changes anything: the current list stays in force.
set -eu

: "${RPC_USER:?RPC_USER is required}"
: "${RPC_PASSWORD:?RPC_PASSWORD is required}"

for value in "$RPC_USER" "$RPC_PASSWORD" "${RPC_ALLOW_IP:-}"; do
    case "$value" in
        *[!A-Za-z0-9._:*@%+=/-]*) echo "RPC_USER, RPC_PASSWORD and RPC_ALLOW_IP may only contain letters, digits and . _ : * @ % + = / -" >&2; exit 2 ;;
    esac
done

allow_ip="${RPC_ALLOW_IP:-}"
allow_host="${RPC_ALLOW_HOST:-}"
if [ -n "$allow_ip" ] && [ -n "$allow_host" ]; then
    echo "Set only one of RPC_ALLOW_IP and RPC_ALLOW_HOST" >&2; exit 2
fi
if [ -z "$allow_ip" ] && [ -z "$allow_host" ]; then
    echo "RPC_ALLOW_HOST (a host name resolved to exact addresses) or RPC_ALLOW_IP (an explicit pattern) is required; RPC stays closed otherwise" >&2; exit 2
fi
case "$allow_ip" in
    '*'|'*.*'|'*:*'|'?'*) echo "RPC_ALLOW_IP must not start with a wildcard; use RPC_ALLOW_HOST or an exact address" >&2; exit 2 ;;
esac
case "$allow_host" in
    *[!A-Za-z0-9.-]*|.*|-*) [ -z "$allow_host" ] || { echo "RPC_ALLOW_HOST may only contain letters, digits, '.' and '-'" >&2; exit 2; } ;;
esac

case "${DAEMON_NETWORK:-mainnet}" in
    mainnet) network="" ;;
    testnet) network="-testnet" ;;
    regtest) network="-regtest" ;;
    *) echo "DAEMON_NETWORK must be mainnet, testnet or regtest" >&2; exit 2 ;;
esac

wait_seconds="${RPC_ALLOW_HOST_WAIT_SECONDS:-60}"
refresh_seconds="${RPC_ALLOW_HOST_REFRESH_SECONDS:-30}"
for value in "$wait_seconds" "$refresh_seconds"; do
    case "$value" in
        ''|*[!0-9]*) echo "RPC_ALLOW_HOST_WAIT_SECONDS and RPC_ALLOW_HOST_REFRESH_SECONDS must be non-negative integers" >&2; exit 2 ;;
    esac
done

# Prints each resolved address once. IPv4-mapped IPv6 entries are dropped because the daemon matches the
# IPv4 form; anything that is not a plain IPv4/IPv6 literal (so no wildcard characters) is ignored.
resolve_host() {
    {
        getent ahostsv4 "$1" 2>/dev/null || true
        getent ahostsv6 "$1" 2>/dev/null || true
    } | while read -r addr _rest; do
        case "$addr" in
            ''|::ffff:*|::FFFF:*|*[!0-9a-fA-F.:]*) continue ;;
            *:*|*.*) echo "$addr" ;;
        esac
    done | sort -u
}

allow_lines=""
if [ -n "$allow_host" ]; then
    waited=0
    addresses=""
    while :; do
        addresses=$(resolve_host "$allow_host")
        [ -n "$addresses" ] && break
        if [ "$waited" -ge "$wait_seconds" ]; then
            echo "RPC_ALLOW_HOST $allow_host did not resolve within ${wait_seconds}s; refusing to start with RPC open or unrestricted" >&2
            exit 3
        fi
        sleep 2
        waited=$((waited + 2))
    done
    for addr in $addresses; do
        allow_lines="${allow_lines}rpcallowip=${addr}
"
    done
    echo "RPC allowed for $allow_host resolved at startup: $(echo "$addresses" | tr '\n' ' ')(re-checked every ${refresh_seconds}s; a changed answer restarts the daemon cleanly)" >&2
else
    allow_lines="rpcallowip=${allow_ip}
"
fi

umask 077
conf=$(mktemp)
changed="$conf.changed"
{
    echo "server=1"
    echo "listen=0"
    echo "rpcuser=$RPC_USER"
    echo "rpcpassword=$RPC_PASSWORD"
    printf '%s' "$allow_lines"
    if [ -n "${RPC_PORT:-}" ]; then echo "rpcport=$RPC_PORT"; fi
} > "$conf"

terminating=0
daemon=""
trap 'terminating=1; [ -z "$daemon" ] || kill -TERM "$daemon" 2>/dev/null || true' TERM INT

# shellcheck disable=SC2086
stdbuf -oL -eL ronpaulcoind -conf="$conf" -datadir=/data -printtoconsole $network "$@" &
daemon=$!

watch_addresses() {
    pending=""
    failing=0
    while :; do
        sleep "$refresh_seconds"
        current=$(resolve_host "$allow_host")
        if [ -z "$current" ]; then
            if [ "$failing" -eq 0 ]; then
                echo "RPC_ALLOW_HOST $allow_host did not resolve; keeping the current allow-list" >&2
            fi
            failing=1
            pending=""
            continue
        fi
        failing=0
        if [ "$current" = "$addresses" ]; then
            pending=""
        elif [ "$current" = "$pending" ]; then
            echo "RPC_ALLOW_HOST $allow_host now resolves to $(echo "$current" | tr '\n' ' '); stopping the daemon cleanly so it restarts with the new allow-list" >&2
            : > "$changed"
            kill -TERM "$daemon" 2>/dev/null || true
            return 0
        else
            pending="$current"
        fi
    done
}

watcher=""
if [ -n "$allow_host" ] && [ "$refresh_seconds" -gt 0 ]; then
    watch_addresses &
    watcher=$!
fi

code=0
wait "$daemon" || code=$?
# A trapped signal interrupts wait before the daemon has exited.
while kill -0 "$daemon" 2>/dev/null; do wait "$daemon" || code=$?; done
if [ -n "$watcher" ]; then kill "$watcher" 2>/dev/null || true; fi

if [ -e "$changed" ]; then rm -f "$changed"; exit 1; fi
if [ "$terminating" -eq 1 ]; then exit 0; fi
exit "$code"
