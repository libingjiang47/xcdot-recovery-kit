# xcDOT Recovery Kit

[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · **Deutsch** · [Français](README.fr.md)

Open-Source-Werkzeuge und Datensätze zur Wiederherstellung und Verifizierung von xcDOT-Guthaben im finalen Moonbeam-Zustand.

**Snapshot-Abfrage:** [https://libingjiang47.github.io/xcdot-recovery-kit/](https://libingjiang47.github.io/xcdot-recovery-kit/)

Der aktuelle Snapshot enthält **11.785 bekannte Adressen mit positivem Saldo**. Für jedes veröffentlichte Guthaben liegt ein zugehöriger Substrate State Proof vor, der unabhängig gegen die State Root des finalen Moonbeam-Zustands verifiziert werden kann.

## Grundsatz

Nach dem Ende des Moonbeam-Betriebs und ohne vollständigen Backup-Knoten haben wir aus öffentlichen RPCs, Blockchain-Explorern und Indexdaten die Menge möglicher xcDOT-Adressen rekonstruiert und ihre Guthaben im finalen Zustand abgefragt.

Diese Datenquellen gelten jedoch nicht als endgültige Autorität. RPC-Anbieter und Explorer können fehlende Indizes, unvollständige historische Daten oder fehlerhafte Ergebnisse enthalten. Daher werden ihre Guthaben nicht direkt als Endergebnis übernommen.

Der einzige Vertrauensanker für den Chain-Zustand ist die **State Root** des finalen Moonbeam-Blocks. Die veröffentlichten xcDOT-Guthaben enthalten die zugehörigen Substrate State Proofs und können offline verifiziert werden.

## Finaler Block

Dieses Projekt ist auf den folgenden Moonbeam-Zustand verankert:

```text
Blocknummer 16.796.696
Block-Hash  0xef087d70dd12e19483664824894679360264159cd6e350da2ab79176a335687f
State Root  0xe5c38c080bf19f4b6308f127bdcc34e3d9e016fd895b50ff200ca2714f5327eb
```

Dies ist der **letzte von Polkadot finalisierte Moonbeam-Parachain-Block**.

Die Wiederherstellung orientiert sich an der Polkadot-Finalität: [Moonbeam-Block 16.796.696](https://moonbeam.subscan.io/block/16796696).

## Aktueller Status

| Eintrag                               |                     Wert |
| ------------------------------------- | -----------------------: |
| Bekannte Adressen mit positivem Saldo |                   11.785 |
| Bekannter verifizierter Saldo         | 233.450,6800114108 xcDOT |
| Gesamtangebot von xcDOT               |  233.451,672748423 xcDOT |
| Nicht zugeordnet                      |       0,9927370122 xcDOT |
| Verifizierte Saldo-Proofs             |          11.785 / 11.785 |

Die bekannten Guthaben decken ungefähr **99,9995749 %** des Gesamtangebots ab.

Die verbleibenden `0.9927370122 xcDOT` sind nicht zugeordnet. Daher bezeichnet 11.785 die derzeit bekannte Menge positiver Adressen und ist keine Vollständigkeitserklärung für alle möglichen Holder.

## So wird die Veröffentlichung verifiziert

Repository klonen:

```bash
git clone https://github.com/libingjiang47/xcdot-recovery-kit.git
cd xcdot-recovery-kit
```

Installieren und bauen:

```bash
pnpm install --frozen-lockfile
pnpm build
```

Hashes der Veröffentlichungsdateien prüfen:

```bash
sha256sum -c SHA256SUMS
```

Alle Saldo-Proofs offline verifizieren:

```bash
NO_NETWORK=1 pnpm verify:release
```

Für den vollständigen Snapshot werden folgende Ergebnisse erwartet:

```text
PROOF_BATCHES=93/93
PROOF_ADDRESSES=11785/11785
TOTAL_SUPPLY_PROOF=PASS
BALANCE_PROOFS_VERIFIED=11785
OFFLINE_VERIFICATION=PASS
STATUS=PASS
```

## Snapshot-Abfrage

Statische Abfrageseite: [https://libingjiang47.github.io/xcdot-recovery-kit/](https://libingjiang47.github.io/xcdot-recovery-kit/)

Sie ermöglicht die Suche nach einem Adresssaldo, die Anzeige des zugehörigen Proofs und den Download unabhängiger Evidence. Die Website fragt zur Laufzeit keinen RPC ab.

## Haftungsausschluss

Dieses Projekt dient ausschließlich der Wiederherstellung und Verifizierung öffentlich beobachtbarer On-Chain-Zustände.

Adressen, Guthaben und Proofs stellen keinerlei Feststellung von Eigentum, Anspruchsberechtigung, Entschädigungszusage, Rechtsberatung oder Finanzberatung dar.

Dieses Projekt vertritt nicht Moonbeam, Polkadot, Parity Technologies, Web3 Foundation, ArcheLabs oder eine andere verbundene Organisation.

Regeln für eine tatsächliche Wiederherstellung, Verteilung oder Auszahlung müssen durch unabhängige Governance- und Ausführungsmechanismen festgelegt werden.

## Lizenz

Apache-2.0. Siehe [LICENSE](../LICENSE).
