# Railway deployment runbook

Status: **prepared and locally tested, never deployed.** The images build and run together on
regtest (see "What was verified"). Nothing here has run on Railway or against mainnet. Payouts are
disabled and not implemented. Use a **new, separate Railway project**; do not reuse the explorer's
project or its node.

## Services

| Service | Source | Volume | Public networking |
|---|---|---|---|
| `ronpaulcoind` | this repo, variable `RAILWAY_DOCKERFILE_PATH=docker/daemon/Dockerfile` (builds the last stage, `deploy`) | `/data` | **none** (no domain, no TCP proxy) |
| `pool` | this repo, root `Dockerfile` | `/data` (block journal) | TCP proxy to port 3333 |

Railway's TCP proxy ([docs](https://docs.railway.com/networking/tcp-proxy)) gives the pool a public
`<name>.proxy.rlwy.net:<port>` that forwards raw TCP, so Stratum works there. The port number is chosen
by Railway, not by you; miners use `stratum+tcp://<name>.proxy.rlwy.net:<port>`. A custom domain can be
CNAMEd to the proxy host (DNS only, no Cloudflare proxying) but the port stays Railway's. Ordinary HTTP
domains cannot carry Stratum. The daemon is reached only over private networking
(`ronpaulcoind.railway.internal:9026`). Never generate a public domain or TCP proxy for it.

Railway Docker health checks are HTTP-only and the pool has no HTTP server (by design, no dashboard), so
configure none. Set the restart policy of both services in the dashboard (config-as-code is deprecated
upstream, so no `railway.json` is shipped).

## Settings that need your decision before deploying

1. **Daemon sync and the pool start order.** The pool refuses to start until a daemon answers
   `getblocktemplate`, which the 0.9.1 daemon only does with at least one peer and after initial
   download. Deploy the daemon first, wait until it is synced, then deploy the pool. Restart policy for
   the pool: On Failure with a high retry count (or Always), so it recovers if the daemon is late.
2. **Volumes and `RAILWAY_RUN_UID=0`.** The images run as non-root users, and Railway volumes are mounted
   root-owned, so Railway's documented workaround is `RAILWAY_RUN_UID=0` on both services. This runs the
   processes as root inside the container: a weaker posture than the tested non-root runs. If you do not
   accept that, the pool can run without a journal volume (block outcomes then live only in logs) and the
   daemon cannot run without a volume (it would re-sync on every deploy).
3. **Daemon RPC allow-list.** The daemon matches `-rpcallowip` by wildcard against the caller's address
   and Railway does not document its private address range. Read the pool's address from a test
   connection (or Railway's networking panel), set `RPC_ALLOW_IP` to the narrowest pattern that matches
   only it, and verify with a connection from another service that it is refused. Do not use `*`.
4. **Per-IP limits.** Railway's TCP proxy is not documented as preserving client addresses and the pool
   does not parse PROXY protocol. Assume every miner appears from the proxy's address and set
   `MAX_CONNECTIONS_PER_IP=0` until a test with two real client addresses shows otherwise. The
   per-connection limits (protocol errors, invalid-share ratio, message rate, output buffer) still apply.
5. **Pool address and difficulty.** `POOL_ADDRESS` must be a real mainnet address you control (the
   daemon has no wallet here). `STRATUM_DIFFICULTY` must be tuned for the real network and expected miner
   hashrate; the default of 1 is untested on mainnet. A share rate above about 100 messages per second per
   connection exceeds the default `MESSAGE_RATE_LIMIT`.

## Variables

`ronpaulcoind` (all values: letters, digits and `. _ : * @ % + = / -` only; the entrypoint refuses others):

| Variable | Value |
|---|---|
| `RAILWAY_DOCKERFILE_PATH` | `docker/daemon/Dockerfile` |
| `RAILWAY_RUN_UID` | `0` (see above) |
| `RPC_USER`, `RPC_PASSWORD` | random strings, for example `openssl rand -hex 24` for the password |
| `RPC_ALLOW_IP` | wildcard pattern for the pool's private address |
| `DAEMON_NETWORK` | `mainnet` (default), `testnet` or `regtest` |
| `RPC_PORT` | leave unset on mainnet (default 9026) |

Mainnet ports come from the pinned source: P2P 9027, RPC 9026. P2P is outbound only (`listen=0`).
The credentials are written to a mode-0600 config file in the container's temporary directory, not onto
the volume and not onto the command line.

`pool` (see the README table for every option):

| Variable | Value |
|---|---|
| `RAILWAY_RUN_UID` | `0` (only if you attach the journal volume) |
| `POOL_NETWORK` | `mainnet` |
| `POOL_ADDRESS` | your payout/coinbase address |
| `DAEMON_HOSTS` | `ronpaulcoind.railway.internal:9026` |
| `DAEMON_RPC_USER`, `DAEMON_RPC_PASSWORD` | Railway reference variables to the daemon's `RPC_USER` and `RPC_PASSWORD` |
| `STRATUM_PORT` | `3333` (the TCP proxy target) |
| `STRATUM_DIFFICULTY` | chosen for mainnet |
| `MAX_CONNECTIONS_PER_IP` | `0` until real client addresses are confirmed |
| `BLOCK_JOURNAL_PATH` | `/data/blocks.jsonl` |

## Block journal and recovery

With `BLOCK_JOURNAL_PATH` set, every solved block is written before `submitblock` (`submitting`, with the
full block hex), again with its outcome, and re-checked with `getblock` every
`BLOCK_RECHECK_INTERVAL_SECONDS` until it has `BLOCK_RECHECK_CONFIRMATIONS` confirmations or
`BLOCK_RECHECK_MAX_HOURS` pass. Lines are JSON, one per state change:

- `accepted`: on the main chain when checked. A later `REORG` log line and a `side chain` or
  `unresolved` line mean it left the main chain. Nothing is ever labelled `rejected`, because "Block not
  found" and `"rejected"` do not prove invalidity on this daemon.
- `unresolved`: not in the index when checked. The line keeps the hex. Recovery: run `getblock <hash>` on
  every daemon; if all answer "Block not found" and the block's parent is still the tip, run
  `submitblock <hex>`.
- After a restart, unfinished blocks are re-checked and a warning lists them.

`ronpaulcoin-cli` exists in the daemon image (`railway ssh` into the daemon service). The journal is
append-only and not rotated; at mainnet block rates it stays small. It is not a backup of anything but
block outcomes.

## Backups and recovery

- **Daemon volume:** holds the chain only (no wallet). It can be rebuilt by re-syncing, which costs time
  and CPU; use Railway volume backups only if re-sync time matters.
- **Pool volume:** the journal. Back it up (`railway volume` tooling or periodic copy) if you rely on it.
- **Credentials:** rotate by changing both services' variables and redeploying the daemon first.

## Resources and cost (estimates, not measurements)

Pool and daemon resource use has not been measured on mainnet. Assumed: daemon about 1 GB RAM and 0.5
vCPU average, higher CPU during first sync; pool about 0.25 GB RAM and 0.1 vCPU. Railway rates at the
time of writing ([pricing](https://docs.railway.com/pricing/plans)): RAM $10/GB/month, CPU $20/vCPU/month,
volume $0.15/GB/month, egress $0.05/GB, Hobby plan $5/month with that amount credited to usage.
Rough monthly total: about $25-30 plus egress, dominated by the daemon. The chain size is unknown
because no mainnet data was downloaded; check the existing node's data directory size before choosing a
volume (Hobby volumes start at 5 GB and can be enlarged). Replicas cannot be used with volumes, so
neither service scales out, and redeploying a service with a volume has a short downtime.

## What was verified (local, regtest only)

- `docker build` of the pool image (root `Dockerfile`) and of the daemon `deploy` stage.
- The daemon entrypoint refuses missing variables, unsafe characters and unknown networks.
- A regtest daemon started by the entrypoint with its credentials in a 0600 file answers RPC; a second
  node peered to it; the pool image started against it, wrote its journal to a mounted volume, and a real
  cpuminer 2.5.1 mined blocks that both nodes accepted.
- Unit tests for the journal and an integration test of the journal with the real pool process.

## Not verified

Railway itself (TCP proxy behaviour, client addresses, volume permissions with `RAILWAY_RUN_UID`, private
address ranges, resource use), the live mainnet daemon and difficulty, any ASIC or GPU miner, and
sustained load.
