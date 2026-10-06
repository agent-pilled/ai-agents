# Black-box passes with the dispatcher as the only forge writer

A pass receives one prompt carrying its whole contract and returns one response
that the dispatcher validates; it reaches the forge and the keychain only
through a per-pass broker, and holds no forge credential. The dispatcher writes
everything the role puts on the forge. This makes every pass read-only plus one
validated output, lets the wireframe enforce mechanical rules (allow-lists,
secret leaks, one verdict per request) on the way out, and makes a response the
complete output of a run, so evaluations can replay recorded cases and compare
configurations response to response.

Rejected: giving passes a short-lived forge token. Cost accepted: a pass cannot
call forge APIs the broker does not offer, and dev-bot publishes work in
progress only through a checkpoint.
