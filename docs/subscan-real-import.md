# Real Subscan import audit

This is the audit of the 73 CSV files supplied under `snapshots/subscan/`. The importer was run against the untouched files with `--expected-files 73`. The raw freeze completed, but the import correctly stopped before creating a candidate `derived/` directory because one source row has an invalid H160.

## Raw freeze

```text
RAW_FILE_COUNT=73
RAW_BYTES=443021
RAW_ROW_COUNT=7290
RAW_DATASET_DIGEST=6be5e3aa25267d1d666f14bd3c3f129ff0436501048c5ae786cf76d6e01fd4b8
RAW_SHA256SUMS_SHA256=6be5e3aa25267d1d666f14bd3c3f129ff0436501048c5ae786cf76d6e01fd4b8
```

The first 72 pages contain 100 data rows and the last page contains 90. Every file has the same observed `Rank,Account,Balance` schema, with schema fingerprint `c0e796bf68aa4146c1995d19517a26ac5412843c7d3b9a44144625b761b69af9`. Ranks span 1 through 7290, with the invalid row at Rank 565. No blank data rows were observed. Thirty-six balance fields use the documented quoted thousands-group form; the remaining fields use plain decimal form.

## Hard-gate result

```text
VALID_ROW_COUNT=7289
INVALID_ROW_COUNT=1
UNIQUE_VALID_ADDRESS_COUNT=7288
POSITIVE_VALID_ADDRESS_COUNT=7288
ZERO_BALANCE_COUNT=0
EXACT_DUPLICATE_ADDRESS_COUNT=1
CONFLICTING_DUPLICATE_COUNT=0
```

The one invalid record is preserved in its original file and is not guessed or omitted:

```text
SUBSCAN_INVALID_ADDRESS
file=Moonbeam-Holders-xcDOT-0xf544b23a99befc7820530077b0257c3a60c23f92-0x7edc57db68ca6a536bde4fbed78af2bf2cd0bde5.csv
sourceRow=66
rawRow=565,,14.3274324851
```

Because `INVALID_ROW_COUNT` is not zero, no candidate holder digest or Subscan total is published. The valid-row subtotal, which is diagnostic only and must not be treated as a candidate result, is `3054649714556639` planck (`305464.9714556639` xcDOT).

The same-address/same-balance duplicate is:

```text
address=0x43441fc7b12bdef70dbb55b8537e4118148bf167
balance=0.9927370121
first=Moonbeam-Holders-xcDOT-0x43441fc7b12bdef70dbb55b8537e4118148bf167-0x4e884c854ab809f68fe1c3552bb8add2801836eb.csv:101
second=Moonbeam-Holders-xcDOT-0x5fb261d40b889f0e42a7bd8690d0f4f53d3dc74a-0xd56af1033e0d8784fb71ff9848d6a3422b847de4.csv:3
```

It is safe to collapse only after the invalid row is repaired or replaced by a separately verified source artifact.

## Manual sample audit

The following samples were checked against their exact source rows after normalization. “First” and “last” are canonical address order; largest and smallest are balance order.

### First five canonical addresses

| Rank | Address                                      |       Balance | Source                 |
| ---: | -------------------------------------------- | ------------: | ---------------------- |
|  592 | `0x0000000000057df040739f376ad2b64d9389bf04` | 12.2899373996 | `...0xf544...csv:93`   |
| 6666 | `0x000000104551469868bb70b231d6cfff35e43826` |  0.0327126299 | `...0xb8a964...csv:67` |
| 6271 | `0x00085d4fee6c953d00f4456fb407b6974435eb07` |  1.0062788884 | `...0x43441...csv:72`  |
| 2297 | `0x0008fedd526ddfda0d4de2e334328d049231d6cf` |  4.0365642511 | `...0xa64f11...csv:98` |
| 6945 | `0x0009595422132356532f396603ab96696065a425` |  0.0000000009 | `...0x4bad5c...csv:46` |

### Last five canonical addresses

| Rank | Address                                      |      Balance | Source                 |
| ---: | -------------------------------------------- | -----------: | ---------------------- |
| 6292 | `0xffe7b20d545d7c7d345e2db98d53e0987df4cdc2` |            1 | `...0x43441...csv:93`  |
| 1743 | `0xffebaf265d6653c40e635f5c7891089dc4c8e9be` | 4.3427085496 | `...0x7e347e...csv:44` |
| 4848 | `0xfff732f02b5e029565b775f5cc2955d02e8c42a4` | 3.6828412648 | `...0x0e24d2...csv:49` |
| 1861 | `0xfff988a3216bf8120dff4f6d8e3358a5590e759e` | 4.3094628904 | `...0xd36464...csv:62` |
| 2903 | `0xfff9e8387f6ea2073d1c38b9571fe4aa55fd3ad8` | 3.8748593773 | `...0x33408a...csv:4`  |

### Largest ten balances

| Rank | Address                                      |           Balance | Source                 |
| ---: | -------------------------------------------- | ----------------: | ---------------------- |
|    1 | `0x25442adf37379be90ed1f7fccd9c9417b10aa4dc` | 47,991.4883085097 | `...0xa4c283...csv:2`  |
|    2 | `0x2464f91e67a27637a118608a3a90cfdf82b25cef` |            30,000 | `...0xa4c283...csv:3`  |
|    3 | `0xb301ce0e702fdaf278870bd33c44ff6d0b3fb438` | 26,160.3219124092 | `...0xa4c283...csv:4`  |
|    4 | `0x921b35e54b45b60ee8142fa234baeb2ff5e307e0` | 15,883.7626291596 | `...0xa4c283...csv:5`  |
|    5 | `0x4f4495243837681061c4743b74b3eedf548d56a5` | 12,104.1275129718 | `...0xa4c283...csv:6`  |
|    6 | `0x6bb200b706ffa1665127877a11588221c49d9eed` | 10,544.4982620422 | `...0xa4c283...csv:7`  |
|    7 | `0xe611d6e3205689bdc538646437c16badb900b62d` |  4,880.9971653764 | `...0xa4c283...csv:8`  |
|    8 | `0x959e170dadd53ad4403492a489416963d2575582` |  4,785.9795955536 | `...0xa4c283...csv:9`  |
|    9 | `0xe41e89da5b54cdbe04ee15905fd00dc44fa1b1d6` |  4,650.6116726716 | `...0xa4c283...csv:10` |
|   10 | `0x8872f5a6c88845743fa738dac3795e309f646e96` |  4,223.9998450157 | `...0xa4c283...csv:11` |

### Smallest ten positive balances

All ten are 1 planck (`0.0000000001` xcDOT). Their ranks are 7255, 7263, 7279, 7268, 7285, 7236, 7266, 7243, 7280, and 7258. They were traced to the final page (`...0xe0fda197...csv`) rows 56, 64, 80, 69, 86, 37, 67, 44, 81, and 59 respectively.

The abbreviated page markers above are only for readability; the complete source file names, byte sizes, hashes, and all row-level raw values are retained in the raw freeze and will be emitted in `derived/provenance.ndjson` after the invalid source row is resolved.

## Next safe action

Obtain a separately verified replacement for Rank 565 (or a fresh complete export), place it alongside the existing inputs without editing the existing CSV, rerun the count and raw freeze, and compare the new raw digest. Do not manually fill the missing address and do not run final-state verification until the import hard gate passes.
