# xcDOT Recovery Kit

[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Deutsch](README.de.md) · **Français**

Outils et jeux de données open source pour récupérer et vérifier les soldes xcDOT dans l’état final de Moonbeam.

**Explorateur du snapshot :** [https://libingjiang47.github.io/xcdot-recovery-kit/](https://libingjiang47.github.io/xcdot-recovery-kit/)

Le snapshot actuel contient **11 785 adresses connues avec un solde non nul**. Chaque solde publié est accompagné d’une preuve d’état Substrate correspondante, vérifiable indépendamment contre la state root de l’état final de Moonbeam.

## Principe

Après l’arrêt de Moonbeam, et sans nœud de sauvegarde complet, nous avons reconstitué l’ensemble des adresses susceptibles d’avoir détenu des xcDOT à partir de RPC publics, d’explorateurs blockchain et de données indexées, puis interrogé leurs soldes dans l’état final.

Ces sources ne sont toutefois pas considérées comme des autorités finales. Les fournisseurs RPC et les explorateurs peuvent présenter des index incomplets, des données historiques manquantes ou des résultats erronés. Leurs soldes ne sont donc pas utilisés directement comme résultat final.

La seule ancre de confiance pour l’état de la chaîne est la **state root** du bloc final de Moonbeam. Les soldes xcDOT publiés incluent leurs preuves d’état Substrate et peuvent être vérifiés hors ligne.

## Bloc final

Le projet est ancré sur l’état Moonbeam suivant :

```text
Numéro de bloc 16 796 696
Hash du bloc   0xef087d70dd12e19483664824894679360264159cd6e350da2ab79176a335687f
State Root     0xe5c38c080bf19f4b6308f127bdcc34e3d9e016fd895b50ff200ca2714f5327eb
```

Il s’agit du **dernier bloc parachain Moonbeam finalisé par Polkadot**.

La récupération prend la finalité Polkadot comme référence : [bloc Moonbeam 16 796 696](https://moonbeam.subscan.io/block/16796696).

## État actuel

| Élément                                |                   Valeur |
| -------------------------------------- | -----------------------: |
| Adresses connues avec un solde non nul |                   11 785 |
| Solde connu vérifié                    | 233 450,6800114108 xcDOT |
| Offre totale xcDOT                     |  233 451,672748423 xcDOT |
| Non attribué                           |       0,9927370122 xcDOT |
| Preuves de solde vérifiées             |          11 785 / 11 785 |

Les soldes connus couvrent environ **99,9995749 %** de l’offre totale.

Les `0.9927370122 xcDOT` restants ne sont pas attribués. Ainsi, 11 785 représente l’ensemble actuel des adresses connues avec un solde non nul, et non une déclaration d’exhaustivité de tous les détenteurs possibles.

## Vérifier la publication

Cloner le dépôt :

```bash
git clone https://github.com/libingjiang47/xcdot-recovery-kit.git
cd xcdot-recovery-kit
```

Installer et construire :

```bash
pnpm install --frozen-lockfile
pnpm build
```

Vérifier les hachages des fichiers publiés :

```bash
sha256sum -c SHA256SUMS
```

Vérifier hors ligne toutes les preuves de solde :

```bash
NO_NETWORK=1 pnpm verify:release
```

Le snapshot complet doit produire :

```text
PROOF_BATCHES=93/93
PROOF_ADDRESSES=11785/11785
TOTAL_SUPPLY_PROOF=PASS
BALANCE_PROOFS_VERIFIED=11785
OFFLINE_VERIFICATION=PASS
STATUS=PASS
```

## Explorateur du snapshot

Page de consultation statique : [https://libingjiang47.github.io/xcdot-recovery-kit/](https://libingjiang47.github.io/xcdot-recovery-kit/)

Elle permet de consulter le solde d’une adresse, d’afficher la preuve correspondante et de télécharger une evidence indépendante. Le site n’interroge aucun RPC pendant son exécution.

## Avertissement

Ce projet sert uniquement à récupérer et vérifier un état public de la blockchain.

Les adresses, soldes et preuves ne constituent ni une détermination de propriété d’actifs, ni une éligibilité à une réclamation, ni une promesse d’indemnisation, ni un avis juridique ou financier.

Ce projet ne représente pas Moonbeam, Polkadot, Parity Technologies, Web3 Foundation, ArcheLabs, ni aucune autre organisation apparentée.

Toute règle concernant une récupération, une distribution ou une réclamation réelle doit être décidée par des mécanismes indépendants de gouvernance et d’exécution.

## Licence

Apache-2.0. Voir [LICENSE](../LICENSE).
