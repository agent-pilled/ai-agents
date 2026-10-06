# Choreography without a central manager

Roles coordinate through forge state alone: a read-only scheduler keeps a
derived queue of `(role, change)` keys, and each role's deterministic
dispatcher decides whether its role has work. No orchestrating agent routes
work, because a process that launches every role holds or can obtain every
role's credentials, which defeats the credential layer of the hard boundary.

Rejected: a central task-manager agent per change. Its duties moved to the
roles: each lane chooses its own depth and counts its own rounds, dev-bot waits
for a complete batch, the scheduler applies quota, and arbiter-bot handles
escalations.
