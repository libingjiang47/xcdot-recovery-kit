# SQD Transfer candidate discovery

`fetch-sqd-xcdot-candidates` scans the Moonbeam xcDOT `Transfer(address,address,uint256)`
history through the SQD `moonbeam-mainnet` stream and writes a deterministic address-only
candidate extension:

```bash
node dist/cli/index.js fetch-sqd-xcdot-candidates \
  --from-block 0 \
  --to-block 16796696 \
  --resume
```

The default endpoint is:

```text
https://portal.sqd.dev/datasets/moonbeam-mainnet/stream
```

The scanner requests only block numbers and log topics for the fixed xcDOT contract and
Transfer topic. It collects both indexed `from` and `to` addresses, excludes the zero
address from the candidate file, sorts lower-case H160 values, and emits:

```text
snapshots/sqd/xcdot-transfer-addresses.ndjson
snapshots/sqd/xcdot-transfer-addresses.sha256
```

The work directory contains the resumable context, checkpoint, canonical address cache, and
summary under `diagnostics/sqd-xcdot-transfer-discovery/`. A response may end before the
requested range; the next request begins at the last returned header number plus one. The
address cache is written before the checkpoint so a crash can at most repeat a range.

SQD is a candidate-address index only. SQD balances and Transfer history are not used as
authoritative final state. To continue the existing recovery flow, pass the generated file
to the generic candidate extension path:

```bash
node dist/cli/index.js recover-dwellir-final-state \
  --dataset snapshots/subscan \
  --candidate-extension snapshots/sqd/xcdot-transfer-addresses.ndjson \
  --expected-total-supply 2334516727484230 \
  --connect-timeout-ms 120000 \
  --timeout-ms 300000 \
  --storage-concurrency 2 \
  --resume
```

Only the pinned Moonbeam final state determines balances and supply completeness. A Transfer
participant set is useful for recall, but it is not by itself a proof that every final holder
was initialized through an EVM Transfer event.
