# Relay-chain anchor

Relay anchoring is a separate artifact. It is not a prerequisite for capturing or verifying
Moonbeam state evidence, and it does not turn a candidate snapshot into a canonical recovery
decision. The `anchor-relay` command is reserved for the historical `Paras.Heads[2004]` proof
capture and currently fails explicitly until that artifact is implemented and independently
verified.
