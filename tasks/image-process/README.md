# image-process

`TASK.md` is the brief handed to the model. `expectations.json` is what it is
graded against, and the model never sees it.

## Runs

| Run | Model | Score | Outcome |
| --- | --- | --- | --- |
| `gpt-sol/` | GPT 5.6 sol | 0.846 | Imports the v3 SDK path; cancellation never reaches the running work |

## Re-verifying an archived run

Install the submission's dependencies once, then grade it:

```bash
cd tasks/image-process/gpt-sol/submission && npm install && cd -
npx tsx verifier/run.ts tasks/image-process/gpt-sol/submission image-process
```

Run it from the repo root. The second argument is the task name, resolved to
`tasks/<name>/expectations.json`. Results go to `results/report.json`, which
holds the full evidence the console truncates.

Without `node_modules` the submission cannot be type-checked against the real
SDK, and the verifier stops at the compile gate before assessing anything.
