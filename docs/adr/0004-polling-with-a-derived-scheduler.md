# Polling with a derived scheduler instead of webhooks

The scheduler polls each forge and rereads state, rather than receiving
webhooks. Polling needs no inbound network access, cannot miss an event that was
delivered while the host was down, and works the same on every forge. The queue
holds only `(role, change)` keys that the next tick can rebuild, so it never
becomes a second state machine.

Rejected: webhooks, which need public ingress or a third-party relay and still
need a reconciliation loop. Azure DevOps service hooks into a pulled queue may
later serve as hints that trigger a reread, never as state.
