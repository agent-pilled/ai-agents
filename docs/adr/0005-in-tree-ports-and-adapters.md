# In-tree ports and adapters, no plugin system

Forges, harnesses, keychain backends and isolation mechanisms sit behind
interfaces with in-tree implementations selected by configuration. A plugin
system would cost a stable public API, versioning and discovery, which pays off
only once others ship adapters outside the repository.

The fake forge is a real adapter from day one and every forge adapter passes one
shared contract-test suite, so the forge port cannot quietly become GitHub's
API. The core never imports an adapter; CI enforces the dependency direction.
