# forgecrew demo target

A one-function program with an intentional bug. `add` subtracts. The test in
`test/add.js` fails until that is fixed.

```sh
node --test
```

This repository is the target of the scripted Forgecrew demo. Nothing here is
an agent. The author, the review lane and the QA lane are GitHub Apps, and the
ruleset on `main` decides whether a pull request can merge.
