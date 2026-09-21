# driving-license

`TASK.md` is the brief handed to the model. `expectations.json` is what it is
graded against, and the model never sees it.

## Runs

| Run | Model | Score | Outcome |
| --- | --- | --- | --- |
| `gpt-run/` | GPT 5.6 sol | 0 | Stopped at the compile gate; every file imported `@trigger.dev/sdk/v3` |
| `opus-5/` | Opus 5 | 0.882 | Run-scoped idempotency keys, no progress published |

Each folder holds the submission, the report, and a short write-up of what
failed.

## Re-verifying an archived run

Install the submission's dependencies once, then grade it:

```bash
cd tasks/driving-license/opus-5/submission && npm install && cd -
npx tsx verifier/run.ts tasks/driving-license/opus-5/submission driving-license
```

Run it from the repo root. The second argument is the task name, which is
resolved to `tasks/<name>/expectations.json`; pass a path instead to grade
against a different set. Results are written to `results/report.json`, which
carries the full evidence the console truncates.

The `npm install` matters: without `node_modules` the submission cannot be
type-checked against the real SDK, and the verifier stops at the compile gate
before assessing anything.
