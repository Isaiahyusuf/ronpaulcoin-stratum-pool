# RonPaulCoin Stratum Pool

A Stratum mining pool backend for RonPaulCoin (scrypt, N=1024 r=1 p=1), built on the
vendored [node-stratum-pool](https://github.com/zone117x/node-stratum-pool) used by NOMP.

## Status

The Railway production Stratum service has a public TCP proxy and has passed external
subscribe, configured-address authorization, and job-delivery checks. This confirms the
Stratum endpoint is reachable; it does **not** independently verify current canonical
mainnet activity or prove that a share was accepted. At last daemon verification on
2026-10-21, it had two peers advertising height 2,221,495. Its tip hash is
`f0be8a117278b7f442ce35f4cc2c0e8a317f6dda535f9291d7162437294af1eb`, dated
2026-08-26. A pool startup attempt reported that the daemon was downloading blocks;
MiningPoolStats reports zero miners and hashrate and a pool-reported height
of 2,219,902, but its only listed pool's last reported block is from 2025-11-24, so it
does not independently establish the current canonical tip. The two peers' matching
responses are not independent corroboration. No real mainnet share has been submitted
and no block or payout has been verified.

The production web dashboard is available at
[pool-dashboard-production-02b2.up.railway.app](https://pool-dashboard-production-02b2.up.railway.app/).
It is a separate Railway service, checks the public Stratum `mining.subscribe` response, and reads
pool activity from an authenticated private API. Mainnet daemon RPC, current chain details, templates,
network hashrate, and canonical-chain verification remain unavailable.
Telemetry code is pushed to `main`, but Railway currently rejects production deployments with
“Deploys have been paused temporarily.” Until Railway resumes deployments, the live services still
run their prior build and the dashboard continues to show activity as untracked.
Do not confuse the newer tokenized asset using the RonPaulCoin name with the original
scrypt mainnet.

**Solo-pool reward model:** the entire block reward goes to `POOL_ADDRESS`. There are no
automatic miner payouts or proportional share payouts. The pool persists validated share and
worker activity for dashboard statistics; this accounting does not change consensus validation
or payouts. Authorization accepts only that configured
address (optionally followed by `.worker`); using a different miner login address is
rejected. Only mine with a wallet you control and understand that finding a block is
not guaranteed. Statistics start when telemetry is deployed; prior activity is not backfilled.

## Layout

| Path | Purpose |
|---|---|
| `bin/pool.js` | Entry point; reads configuration from the environment |
| `lib/` | Config validation, login/address checks, scrypt hasher, pool wrapper |
| `web/` | Independent HTTP dashboard and its Stratum subscription health check |
| `coins/ronpaulcoin.json` | Coin parameters (address versions, algorithm, `hasGetInfo`) |
| `vendor/stratum-pool/` | Upstream Stratum engine; patches listed in `VENDORED.md` |
| `docker/daemon/Dockerfile` | Pinned daemon build (`builder`) and minimal `runtime` image |
| `tools/regtest.sh` | Two-node regtest harness and integration test runner |
| `test/` | Unit tests (`*.test.js`) and integration tests (`integration/*.regtest.js`) |

## Dashboard

The Railway `pool-dashboard` service builds from `web/Dockerfile`, binds to `0.0.0.0`
using Railway's `PORT`, and serves `/` plus `/api/status` and `/healthz`. Configure
`STRATUM_PUBLIC_HOST`, `STRATUM_PUBLIC_PORT`, and the public `POOL_ADDRESS` on that
service. It requires no daemon RPC credentials and must not be granted daemon RPC access.

The dashboard measures whether the configured public Stratum endpoint returns a valid
`mining.subscribe` response and fetches worker/share/block totals from the pool's private,
bearer-authenticated stats endpoint. It has no daemon RPC credentials and cannot expose them.
Pool hashrate is an estimate from accepted share difficulty over a complete rolling ten-minute
window (`sum(difficulty × 2^32) / 600 seconds`); it remains unavailable until that observation
window is complete. Connected miners are authenticated live connections, workers are distinct
authenticated worker logins, and block counts include only block hashes the daemon confirms in
its main chain. Historical counters begin at telemetry deployment and are not backfilled.
Network hashrate, daemon RPC, chain tip, peers, and template status remain unavailable.

If you control a custom domain, create it for the dashboard with
`railway domain pool.ronpaulcoin.org --service pool-dashboard --port 8080`, then publish
the DNS records Railway returns and wait for the domain and TLS certificate to become
active. The Stratum TCP endpoint remains on its separate Railway proxy and port.

## Requirements

- Node.js 24
- For integration tests: Docker via Colima on Apple Silicon with Rosetta (the daemon
  only builds for amd64). Colima was run with 2 CPUs, 3 GB RAM, 12 GB disk.

```
brew install colima docker docker-buildx
colima start --arch aarch64 --vm-type vz --vz-rosetta --cpu 2 --memory 3 --disk 12
npm install
```

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `POOL_NETWORK` | yes | | `mainnet`, `testnet` or `regtest` |
| `POOL_ADDRESS` | yes | | Pool coinbase address (P2PKH, checked against the network) |
| `POOL_STATS_DB` | no | (off) | Absolute SQLite path for persistent share accounting (production: `/data/pool-stats.sqlite`) |
| `POOL_STATS_PORT` | with stats | | Private pool stats API port (production: `3334`; do not create a public domain or proxy) |
| `POOL_STATS_TOKEN` | with stats | | Shared URL-safe bearer token (32-256 characters), same secret on the pool and dashboard |
| `DAEMON_HOSTS` | yes | | Comma-separated `host:rpcport` list |
| `DAEMON_RPC_USER` | yes | | Daemon RPC user |
| `DAEMON_RPC_PASSWORD` | yes | | Daemon RPC password; never logged |
| `STRATUM_PORT` | no | 3333 | Public Stratum TCP port |
| `STRATUM_DIFFICULTY` | no | 1 | Fixed share difficulty |
| `DAEMON_RETRY_SECONDS` | no | 5 | While a daemon is down, unauthorised or still starting, the pool retries RPC at this interval and opens no Stratum port and issues no jobs until every daemon answers. Repeated identical failures are logged at most once a minute. Invalid or missing configuration still exits immediately. Wrong RPC credentials are retried too (so a credential rotation can converge) and logged without the password |
| `BLOCK_REFRESH_MS` | no | 1000 | Template polling interval |
| `JOB_REBROADCAST_SECONDS` | no | 55 | Re-send the current job (picks up new transactions) |
| `BLOCK_SUBMIT_ATTEMPTS` | no | 20 | Submission attempts for a solved block while no daemon is reachable |
| `BLOCK_SUBMIT_RETRY_MS` | no | 3000 | Delay between those attempts |
| `BLOCK_RECONCILE_ATTEMPTS` | no | 5 | `getblock` lookups of the exact block hash after submission while its outcome is unresolved |
| `BLOCK_RECONCILE_RETRY_MS` | no | 3000 | Delay between those lookups |
| `BLOCK_JOURNAL_PATH` | no | (off) | Absolute path of an append-only JSONL journal of solved blocks: written before `submitblock`, after the outcome, and on every later state change. Unfinished blocks are re-checked after a restart |
| `BLOCK_RECHECK_INTERVAL_SECONDS` | no | 60 | How often journaled blocks are re-checked with `getblock` (detects reorgs) |
| `BLOCK_RECHECK_CONFIRMATIONS` | no | 100 | A block is final in the journal at this many confirmations |
| `BLOCK_RECHECK_MAX_HOURS` | no | 48 | Re-checking stops after this long; a block still not on the main chain is logged as an error |
| `MAX_CONNECTIONS` | no | 2000 | Concurrent Stratum connections; 0 disables the limit |
| `MAX_CONNECTIONS_PER_IP` | no | 100 | Concurrent connections per source address; 0 disables the limit |
| `MAX_PROTOCOL_ERRORS` | no | 20 | Failed authorizations, unauthorized or malformed submits, repeated subscribes and unknown methods tolerated per connection before it is closed; 0 disables |
| `HANDSHAKE_TIMEOUT_SECONDS` | no | 30 | A connection that has not subscribed and authorized by then is closed; 0 disables |
| `INVALID_SHARE_PERCENT` | no | 50 | A connection is closed when at least this percentage of a window of shares was rejected; 0 disables |
| `INVALID_SHARE_CHECK_THRESHOLD` | no | 500 | Number of shares per window for the check above |
| `MESSAGE_RATE_LIMIT` | no | 1000 | Messages of any kind (shares, optional requests, blank lines) a connection may send per window before it is closed; 0 disables |
| `MESSAGE_RATE_WINDOW_SECONDS` | no | 10 | Length of that window; the default allows 100 messages per second on average |
| `MAX_OUTPUT_BUFFER_BYTES` | no | 1048576 | Unsent output queued for one connection (a client that stops reading) before it is closed; 0 disables, otherwise at least 4096 |

Solo miners authenticate with `<POOL_ADDRESS>.<worker>`; this does not create a separate
payout for the worker. Keep credentials in the environment or an untracked file;
`.env.regtest` is gitignored.

## Local regtest

```
tools/regtest.sh build     # build the runtime daemon image (first build is slow)
tools/regtest.sh up        # start two daemons on an internal Docker network (no published ports) for manual use
tools/regtest.sh test      # recreate the nodes, run the integration suite, then remove them
tools/regtest.sh test test/integration/chain.regtest.js   # single file
tools/regtest.sh down      # remove containers, network and volumes
```

Regtest has no wallet or `generate`, so all blocks are mined through the pool by a test
miner that uses an independent scrypt implementation.

### Real CPU miner check (manual)

`docker/minerd/Dockerfile` builds pooler/cpuminer 2.5.1 (GPL-2.0, pinned by SHA-256) for local checks only.
With `tools/regtest.sh up` running, start the pool and miner as containers on the `rpc-regtest` network
(`node:24-slim` running `bin/pool.js` with the `POOL_*`/`DAEMON_*` variables from `.env.regtest`, and
`docker run rpc-minerd --algo scrypt -o stratum+tcp://<pool>:3333 -u <address>.<worker> -p x -t 1`).
Nothing is published to the host. Observed on regtest only: subscribe, authorize, difficulty, jobs,
shares and blocks accepted by both daemons, and automatic reconnect after a pool restart (the miner
waits 30 s). It sends no optional methods. This is one CPU miner on a trivial-difficulty chain, not
evidence for ASICs, GPUs, other firmware or mainnet.

## Tests

```
npm test                  # unit tests
npm run test:integration  # integration tests (starts and stops the regtest network)
```

Integration coverage: RPC connection and templates; `mining.notify` with independently
checked coinbase and merkle root; valid, low-difficulty, duplicate, stale and malformed
shares; solved blocks accepted by both nodes; 160 consecutive blocks (including height
128 encoding and the regtest halving at 150); coinbase maturity boundary; a block with
chained and independent transactions; daemon unreachable, hung and restarted; stale
jobs; pool restart; startup failures without credential leakage.

## Deployment

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the Railway runbook (two services, TCP proxy for Stratum,
private networking for the daemon, volumes, variables, costs and what is unverified). The root
`Dockerfile` builds the pool; the last stage of `docker/daemon/Dockerfile` (`deploy`) builds the
daemon with an environment-variable entrypoint. Both Railway services are deployed; the pool remains
private and inactive until the daemon has peers and supplies a usable block template. No public
Stratum hostname or port exists yet.

## Runtime image

`docker/daemon` produces a `runtime` image on `debian:bookworm-slim`. Only the libraries
Debian no longer ships (OpenSSL 1.0.x, Boost 1.58) are copied from the Ubuntu 16.04
builder. It runs as UID 10001, declares no `EXPOSE`, and ships licence texts in
`/usr/share/doc/ronpaulcoin-daemon/licenses`.

OpenSSL 1.0.x is end of life. **Never expose daemon RPC or P2P ports publicly.** Only
the Stratum port should be reachable from outside. Run the daemon with `--read-only
--cap-drop ALL --security-opt no-new-privileges`, restrict `-rpcallowip` to the pool's
address (the 0.9.1 daemon matches wildcards such as `172.18.*.*`, not CIDR), and use
`-listen=0` with outbound peers only unless inbound P2P is required. The `ubuntu:16.04` and
`debian:bookworm-slim` base tags are not pinned by digest.

## Known limitations

- A block found while every daemon is unreachable is retried for `BLOCK_SUBMIT_ATTEMPTS`
  attempts; if they run out, the block hex is logged for manual `submitblock`. The block
  is orphaned if the chain moves on in the meantime.
- Startup requires every configured daemon to answer `getpeerinfo`. Until they all do, the pool keeps
  retrying every `DAEMON_RETRY_SECONDS`, logs the failure (never the password), and listens on no port and
  issues no jobs, so it never starts degraded. Invalid configuration exits immediately.
  Authentication and malformed-response errors on block submission are not retried; the block
  hex is logged for manual `submitblock`.
- Share accounting is not implemented: shares are validated and logged, not stored.
- Request-rate and output-buffer limits are per connection and have been exercised only with
  synthetic traffic, not real miners. Difficulty is fixed, so a miner sends roughly
  `hashrate / (65536 * STRATUM_DIFFICULTY)` shares per second (scrypt, difficulty-1 share = 2^16
  hashes). The default of 1000 messages per 10 s (100 per second) is therefore exceeded by a
  500 MH/s scrypt miner at difficulty 1 (about 7,600 shares per second). Choose
  `STRATUM_DIFFICULTY` so the fastest expected miner stays well under about 10 shares per second,
  or raise `MESSAGE_RATE_LIMIT` deliberately. The window is fixed, so up to twice the limit can
  arrive across a window boundary. Per-address reconnect rates are not limited.
- Block submission outcomes. Per the pinned daemon (`ProcessBlock` runs synchronously and
  `submitblock` passes no peer), a `submitblock` reply means:
  - `null`: processed; the block entered the index **or** its parent was unknown and it was
    discarded as an orphan.
  - `"rejected"`: processed; validation failed **or** the block is already known (a duplicate,
    including a block held as a P2P orphan). It does not prove the block is invalid.
  - not processed: connection refused, HTTP 401, and the JSON-RPC errors raised before
    `ProcessBlock` runs (-22 decode failure, -32600/-32601/-32700 request errors, -2 safe mode,
    in which `submitblock` is refused for every block until the operator resolves the warning).
  - ambiguous: timeout, reset, malformed or non-JSON response, and every other JSON-RPC error.
    -1 is any `std::exception` in the command, including inside `ProcessBlock`. This daemon has no
    -28 warmup error: during startup it refuses connections.

  Only connection failures and timeouts are retried (up to `BLOCK_SUBMIT_ATTEMPTS`); a JSON-RPC
  error is never retried because the daemon answered. Before each retry the pool looks the hash up
  with `getblock` and stops once a daemon has it indexed. A resubmission is harmless to the daemon
  (it is answered `rejected` or discarded again), so the lookup only avoids pointless traffic.
  After submission the pool polls `getblock` on every daemon `BLOCK_RECONCILE_ATTEMPTS` times,
  `BLOCK_RECONCILE_RETRY_MS` apart, and the share event carries one `blockStatus` (and
  `blockStatusReason`):
  - `accepted`: a daemon reports the hash with `confirmations` above 0. This is the only status
    reported as a found block (`isValidBlock`). It means "on the main chain when checked": two
    same-height blocks submitted within milliseconds to different daemons can each be accepted before
    the nodes converge, and one is then displaced (seen with a real miner at regtest difficulty).
  - `side chain`: a daemon has it indexed with `confirmations` of -1 or 0. A later reorg could still
    make it the main chain. With `BLOCK_JOURNAL_PATH` set the block is re-checked and a change is
    journaled and logged; without it nothing re-checks.
  - `unresolved`: everything else. The block is not indexed on any daemon after the whole window.
    The pool never concludes invalidity from "Block not found" or from `"rejected"`. The reason
    names the evidence (acknowledged but never indexed, which fits a discarded orphan; possibly
    processed without a usable response; answered `"rejected"`; no daemon processed it) and how
    many daemons answered "Block not found".

  Across daemons, any main-chain report wins, then any side-chain report. If the daemons do not
  all agree (or one cannot answer) the pool logs `Daemons do not agree about block ...` with the
  counts. For a block that is not accepted the share event also carries `blockHex`, and the log
  contains `Block <hash> is UNRESOLVED (<reason>) ... submitblock: <hex>` (or the side-chain line);
  `bin/pool.js` prints `[block-unresolved]` or `[block-side-chain]`. Such a share is a valid share
  that found a block whose outcome is not confirmed: consumers must check `blockStatus` and must not
  treat it as an ordinary share or as a confirmed block. Before submitting manually, run `getblock
  <hash>` on each daemon and confirm the block's parent is still the tip.
  The status is a snapshot: a request that reached a stalled daemon can be processed after the
  window. `BLOCK_JOURNAL_PATH` re-checks journaled blocks afterwards (and across restarts) and logs a reorg;
  without it nothing re-checks the chain.
- Connection limits are per source address. If a TCP proxy or load balancer hides miner
  addresses, every miner shares one address and `MAX_CONNECTIONS_PER_IP` would block
  legitimate miners; set it to 0 there and limit at the proxy. Misbehaving connections are
  closed, but addresses are never banned, so a repeat offender can reconnect.
- Stratum extensions are declined, not supported: `mining.configure` answers `false` for each
  requested extension, `mining.extranonce.subscribe`, `mining.suggest_difficulty`,
  `mining.suggest_target` and `mining.get_transactions` return an error. Behaviour with real
  miner software has not been tested.
- Difficulty is fixed (`STRATUM_DIFFICULTY`); there is no variable difficulty.
- After a network interruption, requests over stale keep-alive sockets can stall for up to
  the 10 second RPC timeout.
- The regtest harness passes the RPC password on the daemon command line; for deployments
  use a root-owned configuration file instead.
- Daemon-down periods log a line per poll; there is no rate limiting.
- Daemon rejection reasons are not logged in detail.
- The daemon cannot be built natively for arm64 and runs under Rosetta on Apple Silicon.
- Mainnet consensus (including KGW retargeting), address versions and real miner
  behaviour are unverified against a live daemon.

## Licences

The daemon is MIT/X11 with BSD (scrypt, leveldb) and MIT (json_spirit) components; the
vendored pool and NOMP are GPL-2.0. Preserve all notices (`vendor/stratum-pool/`, the
image's licences directory) when redistributing. This is a source summary, not legal
advice.

## Cleanup

```
tools/regtest.sh down
docker image rm rpc-daemon rpc-daemon-builder
docker builder prune
colima delete --data     # removes the whole VM
```
