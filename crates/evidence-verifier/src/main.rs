use anyhow::{bail, Context, Result};
use clap::Parser;
use serde_json::Value;
use sha2::{Digest, Sha256};
use sp_core::{Blake2Hasher, Hasher, H256};
use sp_trie::{verify_trie_proof, LayoutV0, LayoutV1};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Parser)]
#[command(
    name = "evidence-verifier",
    about = "Verify xcDOT evidence without network access"
)]
struct Args {
    bundle: PathBuf,
}

fn read(path: &Path) -> Result<Vec<u8>> {
    fs::read(path).with_context(|| format!("read {}", path.display()))
}

fn read_text(path: &Path) -> Result<String> {
    String::from_utf8(read(path)?).with_context(|| format!("{} is not UTF-8", path.display()))
}

fn json(path: &Path) -> Result<Value> {
    serde_json::from_slice(&read(path)?).with_context(|| format!("parse JSON {}", path.display()))
}

fn field<'a>(value: &'a Value, path: &str) -> Result<&'a Value> {
    let mut current = value;
    for part in path.split('.') {
        current = current
            .get(part)
            .with_context(|| format!("missing manifest field {path}"))?;
    }
    Ok(current)
}

fn string_field(value: &Value, path: &str) -> Result<String> {
    Ok(field(value, path)?
        .as_str()
        .with_context(|| format!("manifest field {path} is not a string"))?
        .to_owned())
}

fn u64_field(value: &Value, path: &str) -> Result<u64> {
    match field(value, path)? {
        Value::String(text) => text
            .parse()
            .with_context(|| format!("manifest field {path} is not an integer")),
        Value::Number(number) => number
            .as_u64()
            .with_context(|| format!("manifest field {path} is not an unsigned integer")),
        _ => bail!("manifest field {path} is not an integer"),
    }
}

fn hex_bytes(text: &str, label: &str) -> Result<Vec<u8>> {
    if !text.starts_with("0x") || !text.len().is_multiple_of(2) {
        bail!("{label} is not an even-length 0x hex string")
    }
    hex::decode(&text[2..]).with_context(|| format!("decode {label}"))
}

fn hash_hex(bytes: &[u8]) -> String {
    let digest = Blake2Hasher::hash(bytes);
    format!("0x{}", hex::encode(digest.as_bytes()))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    hex::encode(digest)
}

fn decode_compact_u64(input: &[u8], offset: &mut usize) -> Result<u64> {
    let first = *input.get(*offset).context("compact integer is truncated")?;
    *offset += 1;
    match first & 0b11 {
        0 => Ok((first >> 2) as u64),
        1 => {
            let next = *input.get(*offset).context("compact integer is truncated")?;
            *offset += 1;
            Ok((first as u64 >> 2) | ((next as u64) << 6))
        }
        2 => {
            let end = offset.checked_add(3).context("compact integer overflow")?;
            let bytes = input
                .get(*offset..end)
                .context("compact integer is truncated")?;
            *offset = end;
            Ok((first as u64 >> 2)
                | ((bytes[0] as u64) << 6)
                | ((bytes[1] as u64) << 14)
                | ((bytes[2] as u64) << 22))
        }
        3 => {
            let length = ((first >> 2) as usize) + 4;
            if length > 8 {
                bail!("compact integer does not fit in u64")
            }
            let end = offset
                .checked_add(length)
                .context("compact integer overflow")?;
            let bytes = input
                .get(*offset..end)
                .context("compact integer is truncated")?;
            *offset = end;
            let mut result = 0u64;
            for (index, byte) in bytes.iter().enumerate() {
                result |= (*byte as u64) << (index * 8 + 6);
            }
            Ok(result)
        }
        _ => unreachable!(),
    }
}

fn skip_scale_bytes(input: &[u8], offset: &mut usize) -> Result<()> {
    let length = decode_compact_u64(input, offset)? as usize;
    let end = offset
        .checked_add(length)
        .context("SCALE length overflow")?;
    if input.get(*offset..end).is_none() {
        bail!("SCALE byte vector is truncated")
    }
    *offset = end;
    Ok(())
}

fn parse_header(bytes: &[u8]) -> Result<(u64, H256, H256, H256)> {
    if bytes.len() < 96 {
        bail!("block header is shorter than parent/state/extrinsics roots")
    }
    let parent_hash = H256::from_slice(&bytes[..32]);
    let mut offset = 32;
    let block_number = decode_compact_u64(bytes, &mut offset)?;
    let state_root_end = offset.checked_add(32).context("state root overflow")?;
    let state_root = H256::from_slice(
        bytes
            .get(offset..state_root_end)
            .context("state root truncated")?,
    );
    offset = state_root_end;
    let extrinsics_end = offset.checked_add(32).context("extrinsics root overflow")?;
    let extrinsics_root = H256::from_slice(
        bytes
            .get(offset..extrinsics_end)
            .context("extrinsics root truncated")?,
    );
    offset = extrinsics_end;
    let digest_count = decode_compact_u64(bytes, &mut offset)?;
    for _ in 0..digest_count {
        let variant = *bytes.get(offset).context("digest item is truncated")?;
        offset += 1;
        match variant {
            0 => skip_scale_bytes(bytes, &mut offset)?,
            4..=6 => {
                let engine_end = offset.checked_add(4).context("digest engine overflow")?;
                if bytes.get(offset..engine_end).is_none() {
                    bail!("digest engine ID is truncated")
                }
                offset = engine_end;
                skip_scale_bytes(bytes, &mut offset)?;
            }
            8 => {}
            other => bail!("unsupported digest item variant {other}"),
        }
    }
    if offset != bytes.len() {
        bail!("trailing bytes after block header digest")
    }
    Ok((block_number, parent_hash, state_root, extrinsics_root))
}

fn verify_file_sums(bundle: &Path) -> Result<()> {
    let sums = read_text(&bundle.join("SHA256SUMS"))?;
    for line in sums.lines() {
        let (expected, file) = line
            .split_once("  ")
            .with_context(|| format!("malformed SHA256SUMS line: {line}"))?;
        if expected.len() != 64
            || !expected
                .chars()
                .all(|character| character.is_ascii_hexdigit())
            || file.is_empty()
            || file == "SHA256SUMS"
            || Path::new(file).is_absolute()
            || file.split('/').any(|part| part == "..")
        {
            bail!("malformed SHA256SUMS entry: {line}")
        }
        let actual = sha256_hex(&read(&bundle.join(file))?);
        if actual != expected {
            bail!("file hash mismatch for {file}: expected {expected}, got {actual}")
        }
    }
    Ok(())
}

fn verify_canonical_digest(bundle: &Path, manifest: &Value) -> Result<()> {
    let sums = read_text(&bundle.join("canonical-files.sha256"))?;
    let expected = string_field(manifest, "evidenceDigest")?;
    let actual = sha256_hex(sums.as_bytes());
    if actual != expected {
        bail!("evidence digest mismatch: expected {expected}, got {actual}")
    }
    for line in sums.lines() {
        let (expected_file_hash, file) = line
            .split_once("  ")
            .with_context(|| format!("malformed canonical-files line: {line}"))?;
        let actual_file_hash = sha256_hex(&read(&bundle.join(file))?);
        if actual_file_hash != expected_file_hash {
            bail!("canonical file hash mismatch for {file}")
        }
    }
    Ok(())
}

fn verify_proof_items(
    state_version: u64,
    root: H256,
    proof: &[Vec<u8>],
    items: &[(Vec<u8>, Option<Vec<u8>>)],
) -> Result<()> {
    match state_version {
        0 => verify_trie_proof::<LayoutV0<Blake2Hasher>, _, _, _>(&root, proof, items.iter())
            .map_err(|error| anyhow::anyhow!("state trie V0 proof verification failed: {error:?}")),
        1 => verify_trie_proof::<LayoutV1<Blake2Hasher>, _, _, _>(&root, proof, items.iter())
            .map_err(|error| anyhow::anyhow!("state trie V1 proof verification failed: {error:?}")),
        other => bail!("unsupported Substrate state version {other}"),
    }
}

fn raw_storage_records(bundle: &Path) -> Result<Vec<Value>> {
    let text = read_text(&bundle.join("state/storage.ndjson"))?;
    if !text.ends_with('\n') {
        bail!("state/storage.ndjson must end with LF")
    }
    let mut records = Vec::new();
    for line in text.lines() {
        if line.is_empty() {
            bail!("state/storage.ndjson contains a blank line")
        }
        let valid_order = line.starts_with("{\"kind\":\"asset\",\"key\":\"")
            || line.starts_with("{\"kind\":\"metadata\",\"key\":\"")
            || line.starts_with("{\"kind\":\"account\",\"address\":\"");
        if !valid_order {
            bail!("state/storage.ndjson does not use the canonical field order")
        }
        let record: Value = serde_json::from_str(line).context("parse storage.ndjson line")?;
        let kind = record
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let expected_fields = match kind {
            "asset" | "metadata" => ["kind", "key", "value"].as_slice(),
            "account" => ["kind", "address", "key", "value", "balancePlanck"].as_slice(),
            _ => bail!("unsupported storage record kind {kind:?}"),
        };
        let actual_fields = record
            .as_object()
            .context("storage record is not an object")?
            .keys()
            .map(String::as_str)
            .collect::<BTreeSet<_>>();
        if actual_fields != expected_fields.iter().copied().collect() {
            bail!("storage record has unexpected fields")
        }
        records.push(record);
    }
    Ok(records)
}

fn record_string(record: &Value, key: &str) -> Result<String> {
    record
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .with_context(|| format!("storage record lacks string field {key}"))
}

fn record_has_exact_fields(record: &Value, fields: &[&str]) -> Result<()> {
    let actual = record
        .as_object()
        .context("JSON record is not an object")?
        .keys()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    if actual != fields.iter().copied().collect() {
        bail!("JSON record has unexpected fields")
    }
    Ok(())
}

fn decode_u128_le(bytes: &[u8], offset: usize, label: &str) -> Result<u128> {
    let end = offset.checked_add(16).context("u128 offset overflow")?;
    let value = bytes
        .get(offset..end)
        .with_context(|| format!("{label} SCALE field is truncated"))?;
    Ok(u128::from_le_bytes(
        value.try_into().expect("slice length checked"),
    ))
}

fn decode_asset_metadata(bytes: &[u8]) -> Result<(String, u8)> {
    let mut offset = 16;
    let name_len = decode_compact_u64(bytes, &mut offset)? as usize;
    offset = offset
        .checked_add(name_len)
        .context("metadata name overflow")?;
    if bytes.get(offset..).is_none() {
        bail!("metadata name is truncated")
    }
    let symbol_len = decode_compact_u64(bytes, &mut offset)? as usize;
    let symbol_end = offset
        .checked_add(symbol_len)
        .context("metadata symbol overflow")?;
    let symbol = bytes
        .get(offset..symbol_end)
        .context("metadata symbol is truncated")?;
    offset = symbol_end;
    let decimals = *bytes
        .get(offset)
        .context("metadata decimals are truncated")?;
    Ok((
        String::from_utf8(symbol.to_vec()).context("metadata symbol is not UTF-8")?,
        decimals,
    ))
}

fn verify_semantics(bundle: &Path, manifest: &Value, records: &[Value]) -> Result<()> {
    let asset_id = string_field(manifest, "asset.assetId")?;
    let address = string_field(manifest, "asset.xc20Address")?;
    if asset_id != "42259045809535163221576417993425387648"
        || address != "0xffffffff1fcacbd218edc0eba20fc2308c778080"
        || string_field(manifest, "asset.symbol")? != "xcDOT"
        || u64_field(manifest, "asset.decimals")? != 10
    {
        bail!("xcDOT asset identity mismatch")
    }

    let mut asset_values = 0usize;
    let mut metadata_values = 0usize;
    let mut accounts: BTreeMap<String, u128> = BTreeMap::new();
    let mut account_keys = BTreeSet::new();
    let mut asset_raw: Option<Vec<u8>> = None;
    let mut metadata_raw: Option<Vec<u8>> = None;
    for record in records {
        match record.get("kind").and_then(Value::as_str) {
            Some("asset") => {
                asset_values += 1;
                asset_raw = Some(hex_bytes(&record_string(record, "value")?, "asset value")?);
            }
            Some("metadata") => {
                metadata_values += 1;
                metadata_raw = Some(hex_bytes(
                    &record_string(record, "value")?,
                    "metadata value",
                )?);
            }
            Some("account") => {
                let key = record_string(record, "key")?;
                let address = record_string(record, "address")?;
                if address.len() != 42 || address != address.to_ascii_lowercase() {
                    bail!("account address is not a lowercase H160")
                }
                let balance_text = record_string(record, "balancePlanck")?;
                let balance: u128 = balance_text
                    .parse()
                    .context("account balance is not u128")?;
                let raw_balance = decode_u128_le(
                    &hex_bytes(&record_string(record, "value")?, "account value")?,
                    0,
                    "account balance",
                )?;
                if raw_balance != balance {
                    bail!("decoded account balance differs from its raw SCALE value")
                }
                if !account_keys.insert(key) {
                    bail!("duplicate account storage key")
                }
                if accounts.insert(address, balance).is_some() {
                    bail!("duplicate account address")
                }
            }
            other => bail!("unsupported storage record kind {other:?}"),
        }
    }
    if asset_values != 1 || metadata_values != 1 {
        bail!("evidence must contain exactly one asset and one metadata record")
    }
    let asset_supply = decode_u128_le(
        asset_raw.as_ref().expect("asset count checked"),
        80,
        "asset supply",
    )?;
    let manifest_supply: u128 = string_field(manifest, "asset.totalSupplyPlanck")?
        .parse()
        .context("asset supply is not u128")?;
    if asset_supply != manifest_supply {
        bail!("decoded AssetDetails supply differs from the raw SCALE value")
    }
    let raw_account_count = u32::from_le_bytes(
        asset_raw
            .as_ref()
            .expect("asset count checked")
            .get(129..133)
            .context("asset account count SCALE field is truncated")?
            .try_into()
            .expect("slice length checked"),
    );
    let (symbol, decimals) =
        decode_asset_metadata(metadata_raw.as_ref().expect("metadata count checked"))?;
    if symbol != "xcDOT" || decimals != 10 {
        bail!("decoded metadata is not xcDOT with 10 decimals")
    }
    let expected_accounts = u64_field(manifest, "asset.accountCount")? as usize;
    if accounts.len() != expected_accounts || raw_account_count as usize != expected_accounts {
        bail!("account count does not match proven Assets.Account entries")
    }
    let expected_count = u64_field(manifest, "holders.count")? as usize;
    if accounts.values().filter(|balance| **balance > 0).count() != expected_count {
        bail!("holder count does not match positive proven accounts")
    }
    let sum: u128 = accounts
        .values()
        .try_fold(0u128, |sum, value| sum.checked_add(*value))
        .context("holder sum overflow")?;
    let supply = manifest_supply;
    if sum != supply || string_field(manifest, "holders.sumBalancePlanck")? != supply.to_string() {
        bail!("proven account sum does not equal proven supply")
    }
    let holders_text = read_text(&bundle.join("state/holders.ndjson"))?;
    let storage_text = read_text(&bundle.join("state/storage.ndjson"))?;
    if sha256_hex(storage_text.as_bytes()) != string_field(manifest, "holders.storageSha256")? {
        bail!("storage.ndjson SHA-256 mismatch")
    }
    if sha256_hex(holders_text.as_bytes()) != string_field(manifest, "holders.holdersSha256")? {
        bail!("holders SHA-256 mismatch")
    }
    let mut holder_addresses = BTreeSet::new();
    let mut previous_address: Option<String> = None;
    for line in holders_text.lines() {
        if !line.starts_with("{\"address\":\"") {
            bail!("holders.ndjson does not use canonical field order")
        }
        let holder: Value = serde_json::from_str(line).context("parse holder line")?;
        record_has_exact_fields(&holder, &["address", "balancePlanck"])?;
        let holder_address = record_string(&holder, "address")?;
        let holder_balance: u128 = record_string(&holder, "balancePlanck")?.parse()?;
        if holder_balance == 0 || !holder_addresses.insert(holder_address.clone()) {
            bail!("invalid or duplicate canonical holder")
        }
        if accounts.get(&holder_address).copied() != Some(holder_balance) {
            bail!("canonical holder does not match proven account")
        }
        if previous_address
            .as_ref()
            .is_some_and(|previous| previous >= &holder_address)
        {
            bail!("canonical holders are not sorted by address")
        }
        previous_address = Some(holder_address);
    }
    Ok(())
}

fn verify_proofs(bundle: &Path, manifest: &Value, records: &[Value]) -> Result<()> {
    let root = H256::from_slice(&hex_bytes(
        &string_field(manifest, "snapshot.stateRoot")?,
        "state root",
    )?);
    let state_version = u64_field(manifest, "runtime.stateVersion")?;
    let mut expected: BTreeMap<String, Option<Vec<u8>>> = BTreeMap::new();
    for record in records {
        let key = record_string(record, "key")?;
        let value = hex_bytes(&record_string(record, "value")?, "storage value")?;
        expected.insert(key, Some(value));
    }
    if bundle.join("runtime/code.scale.hex").exists() {
        let code_text = read_text(&bundle.join("runtime/code.scale.hex"))?;
        expected.insert(
            "0x3a636f6465".to_owned(),
            Some(hex_bytes(code_text.trim(), "runtime code")?),
        );
    }
    let proof_dir = bundle.join("proofs");
    let index = read_text(&proof_dir.join("index.ndjson"))?;
    if sha256_hex(index.as_bytes()) != string_field(manifest, "proofs.proofIndexSha256")? {
        bail!("proof index SHA-256 mismatch")
    }
    let mut seen = BTreeSet::new();
    let mut previous_batch: Option<u64> = None;
    let mut batch_count = 0u64;
    let mut previous_key: Option<String> = None;
    for line in index.lines() {
        let entry: Value = serde_json::from_str(line).context("parse proof index line")?;
        let batch_index = entry
            .get("batch")
            .and_then(Value::as_u64)
            .context("proof index batch is not an integer")?;
        let file = record_string(&entry, "file")?;
        if previous_batch.is_some_and(|previous| batch_index != previous + 1) {
            bail!("proof batches are not contiguous and ordered")
        }
        previous_batch = Some(batch_index);
        batch_count += 1;
        let batch_raw = read(&proof_dir.join(&file))?;
        let expected_batch_hash = record_string(&entry, "sha256")?;
        if sha256_hex(&batch_raw) != expected_batch_hash {
            bail!("proof index hash does not match its batch file")
        }
        let batch: Value = json(&proof_dir.join(&file))?;
        if field(&batch, "batchIndex")?.as_u64() != Some(batch_index) {
            bail!("proof batch index does not match proof index")
        }
        if string_field(&batch, "blockHash")? != string_field(manifest, "snapshot.blockHash")?
            || string_field(&batch, "stateRoot")? != string_field(manifest, "snapshot.stateRoot")?
        {
            bail!("proof batch is for a different pinned state")
        }
        let keys = batch
            .get("keys")
            .and_then(Value::as_array)
            .context("proof batch keys are not an array")?;
        if keys.len()
            != entry
                .get("keyCount")
                .and_then(Value::as_u64)
                .unwrap_or(u64::MAX) as usize
        {
            bail!("proof index key count does not match batch")
        }
        if let Some(first) = keys.first().and_then(Value::as_str) {
            if record_string(&entry, "firstKey")? != first {
                bail!("proof index first key does not match batch")
            }
        }
        if let Some(last) = keys.last().and_then(Value::as_str) {
            if record_string(&entry, "lastKey")? != last {
                bail!("proof index last key does not match batch")
            }
        }
        let nodes = batch
            .get("proof")
            .and_then(Value::as_array)
            .context("proof batch proof is not an array")?;
        let mut items = Vec::new();
        for key_value in keys {
            let key = key_value
                .as_str()
                .context("proof key is not a string")?
                .to_owned();
            if !seen.insert(key.clone()) {
                bail!("proof key occurs in more than one batch")
            }
            if previous_key
                .as_ref()
                .is_some_and(|previous| previous >= &key)
            {
                bail!("proof keys are not globally sorted by raw storage key")
            }
            previous_key = Some(key.clone());
            let raw_key = hex_bytes(&key, "proof key")?;
            let value = expected
                .get(&key)
                .cloned()
                .with_context(|| format!("proof key {key} has no raw storage record"))?;
            items.push((raw_key, value));
        }
        let proof_nodes = nodes
            .iter()
            .map(|node| {
                hex_bytes(
                    node.as_str().context("proof node is not a string")?,
                    "proof node",
                )
            })
            .collect::<Result<Vec<_>>>()?;
        verify_proof_items(state_version, root, &proof_nodes, &items)?;
    }
    if batch_count != u64_field(manifest, "proofs.batchCount")? {
        bail!("proof batch count does not match manifest")
    }
    if seen != expected.keys().cloned().collect() {
        bail!("proof coverage does not exactly match raw storage values")
    }
    Ok(())
}

fn run(args: Args) -> Result<()> {
    let bundle = fs::canonicalize(&args.bundle).context("resolve evidence bundle")?;
    let manifest = json(&bundle.join("evidence-manifest.json"))?;
    if field(&manifest, "schemaVersion")?.as_u64() != Some(1)
        || string_field(&manifest, "evidenceFormat")? != "xcdot-evidence-v1"
    {
        bail!("unsupported evidence manifest version")
    }
    if string_field(&manifest, "chain.name")? != "Moonbeam"
        || u64_field(&manifest, "chain.paraId")? != 2004
        || string_field(&manifest, "chain.genesisHash")?
            != "0xfe58ea77779b7abda7da4ec526d14db9b1e9cd40a217c34892af80a9b332b76d"
    {
        bail!("unexpected Moonbeam chain identity")
    }
    let header_hex = read_text(&bundle.join("header/header.scale.hex"))?;
    let header = hex_bytes(header_hex.trim(), "block header")?;
    let header_json = json(&bundle.join("header/header.json"))?;
    if string_field(&header_json, "scaleSha256")? != sha256_hex(header_hex.trim().as_bytes()) {
        bail!("header SCALE hash does not match header.json")
    }
    let (block_number, parent_hash, state_root, extrinsics_root) = parse_header(&header)?;
    if block_number.to_string() != string_field(&manifest, "snapshot.blockNumber")? {
        bail!("header block number mismatch")
    }
    if hash_hex(&header) != string_field(&manifest, "snapshot.blockHash")? {
        bail!("block header hash mismatch")
    }
    if format!("0x{}", hex::encode(parent_hash.as_bytes()))
        != string_field(&manifest, "snapshot.parentHash")?
    {
        bail!("header parent hash mismatch")
    }
    if format!("0x{}", hex::encode(state_root.as_bytes()))
        != string_field(&manifest, "snapshot.stateRoot")?
    {
        bail!("header state root mismatch")
    }
    if format!("0x{}", hex::encode(extrinsics_root.as_bytes()))
        != string_field(&manifest, "snapshot.extrinsicsRoot")?
    {
        bail!("header extrinsics root mismatch")
    }
    println!("HEADER_HASH=PASS");
    println!("STATE_ROOT=PASS");
    let metadata_text = read_text(&bundle.join("runtime/metadata.scale.hex"))?;
    if sha256_hex(metadata_text.as_bytes()) != string_field(&manifest, "runtime.metadataSha256")? {
        bail!("runtime metadata SHA-256 mismatch")
    }
    if let Some(expected_code_hash) = manifest
        .get("runtime")
        .and_then(|runtime| runtime.get("runtimeCodeSha256"))
        .and_then(Value::as_str)
    {
        let code_hash = sha256_hex(&read(&bundle.join("runtime/code.scale.hex"))?);
        if code_hash != expected_code_hash {
            bail!("runtime code SHA-256 mismatch")
        }
    } else if bundle.join("runtime/code.scale.hex").exists() {
        bail!("runtime code is present but not committed by the manifest")
    }
    let records = raw_storage_records(&bundle)?;
    verify_proofs(&bundle, &manifest, &records)?;
    println!("STORAGE_PROOFS=PASS");
    verify_semantics(&bundle, &manifest, &records)?;
    println!("ASSET_IDENTITY=PASS");
    println!("SUPPLY_PROOF=PASS");
    println!("HOLDER_COMPLETENESS=PASS");
    verify_file_sums(&bundle)?;
    println!("FILE_INTEGRITY=PASS");
    verify_canonical_digest(&bundle, &manifest)?;
    println!("EVIDENCE_DIGEST=PASS");
    println!("EVIDENCE_VERIFIED=PASS");
    Ok(())
}

fn main() {
    if let Err(error) = run(Args::parse()) {
        eprintln!("EVIDENCE_VERIFIED=FAIL: {error:#}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sp_trie::{generate_trie_proof, TrieDBMutBuilder, TrieMut};

    #[test]
    fn compact_block_number_round_trips() {
        for value in [0, 1, 63, 64, 1_000_000] {
            let encoded = parity_scale_codec::Encode::encode(&parity_scale_codec::Compact(value));
            let mut offset = 0;
            assert_eq!(decode_compact_u64(&encoded, &mut offset).unwrap(), value);
        }
    }

    #[test]
    fn valid_and_mutated_proofs_are_distinguished() {
        type Layout = LayoutV1<Blake2Hasher>;
        let mut db = sp_trie::MemoryDB::<Blake2Hasher>::default();
        let mut root = H256::default();
        let pairs = [
            (b"a".as_slice(), b"one".as_slice()),
            (b"b".as_slice(), b"two".as_slice()),
        ];
        {
            let mut trie = TrieDBMutBuilder::<Layout>::new(&mut db, &mut root).build();
            for (key, value) in pairs {
                trie.insert(key, value).unwrap();
            }
        }
        let keys = [b"a".to_vec(), b"b".to_vec()];
        let proof = generate_trie_proof::<Layout, _, _, _>(&db, root, keys.iter()).unwrap();
        let items = vec![
            (b"a".to_vec(), Some(b"one".to_vec())),
            (b"b".to_vec(), Some(b"two".to_vec())),
        ];
        verify_proof_items(1, root, &proof, &items).unwrap();
        let mut wrong = items.clone();
        wrong[0].1 = Some(b"bad".to_vec());
        assert!(verify_proof_items(1, root, &proof, &wrong).is_err());
        assert!(verify_proof_items(1, H256::repeat_byte(9), &proof, &items).is_err());
        let wrong_key = vec![(b"c".to_vec(), Some(b"one".to_vec()))];
        assert!(verify_proof_items(1, root, &proof, &wrong_key).is_err());
        let mut removed = proof.clone();
        removed.pop();
        assert!(verify_proof_items(1, root, &removed, &items).is_err());
        let mut mutated = proof.clone();
        mutated[0][0] ^= 1;
        assert!(verify_proof_items(1, root, &mutated, &items).is_err());
        assert!(verify_proof_items(2, root, &proof, &items).is_err());
    }
}
