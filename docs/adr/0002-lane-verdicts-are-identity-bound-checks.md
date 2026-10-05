# Lane verdicts are identity-bound checks, not bot approvals

Each lane's verdict is a required check on the exact head that only that lane's
identity can satisfy: on GitHub, a check run bound to the lane's App through the
ruleset's `integration_id`; on Azure DevOps, a status policy with an authorized
identity; on GitLab, an approval rule whose only eligible approver is the lane.
Bots submit no approvals, because an approval count cannot say which identity
approved, and no authoritative source confirms that an App's approval satisfies
required reviews.

The Accountable person's gate stays a code-owner review, which no bot can
satisfy. A new head leaves every lane unsatisfied until it runs again.
