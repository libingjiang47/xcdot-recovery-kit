# v0.26 real execution attempt

This is a non-canonical record of the first real final-state reconstruction attempt. It does not
alter the frozen Subscan CSV files and does not assert a final holder set.

Date: 2026-09-12 (Asia/Shanghai)

Branch: `codex/final-evm-state-v0.26`

Implementation commit: `0caf584`

Substrate connection error-handling fix: `f34fd79`

Pinned EVM block: `16796696`

Pinned Substrate block: `0xef087d70dd12e19483664824894679360264159cd6e350da2ab79176a335687f`

Contract: `0xffffffff1fcacbd218edc0eba20fc2308c778080`

Expected total supply: `2334516727484230`

Candidate count: `7288`

Candidate address digest: `1a9aee3427b27d051cb1e1f6aa599d44f8f9d91ca9f868f082b6703c1853cfff`

## Reconstruction command

The command used the required conservative settings and `--resume`:

```text
node dist/cli/index.js reconstruct-final-state --dataset snapshots/subscan --evm-rpc https://1rpc.io/glmr --block-number 16796696 --expected-total-supply 2334516727484230 --expected-code-hash 0x574a4d1f83702a2d2aefb4d51158f8c29fa1d0b47f4adcd21fd4e1b87591f5fb --concurrency 1 --timeout-ms 15000 --retries 5 --delay-ms 100 --resume
```

The command stopped during EVM preflight, before the first `balanceOf` query. Exact CLI output:

```text
UNEXPECTED_ERROR: Requested resource not found.

URL: https://1rpc.io/glmr
Request body: {"method":"eth_chainId"}

Details: You've reached the usage limit for your current plan. To continue with higher limits and uninterrupted access, please upgrade here: https://www.1rpc.io/#pricing

Version: viem@2.31.7
```

Exit status: `1`.

## Endpoint probes

The minimum HTTP probes for PublicNode, 1RPC, DRPC, and OnFinality each ended with:

```text
curl: (28) Connection timed out after 5001 milliseconds
```

The Foundation Substrate WebSocket initialization repeatedly returned `1006:: Abnormal Closure`.
With the connection error surfaced by `f34fd79`, the command reports:

```text
RPC_UNAVAILABLE: Could not connect to Substrate RPC: [object ErrorEvent]
RPC=wss://wss.api.moonbeam.network
```

No Dwellir API key was available in the workspace, so no authenticated Dwellir request was made.

## Artifacts and interpretation

The command wrote only the address-only candidate artifacts under the ignored local path
`snapshots/final-state/moonbeam-16796696/`. It created no `work/final-state/checkpoint.json`, no
`results.ndjson`, and no balance or holder artifact. Consequently:

```text
EVM_RPC_QUERIED=0
EVM_RPC_SUCCESS_COUNT=0
EVM_RPC_ERROR_COUNT=0
KNOWN_FINAL_SUM_PLANCK=PENDING
UNACCOUNTED_SUPPLY_PLANCK=PENDING
STATUS=FINAL_STATE_RECONSTRUCTION_IN_PROGRESS
```

This is an infrastructure blockage, not evidence of a supply shortfall or overflow. The next
attempt can reuse the candidate digest and the same pinned context when an archive-capable EVM
endpoint is available.
