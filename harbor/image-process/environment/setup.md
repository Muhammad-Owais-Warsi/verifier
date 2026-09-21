# Project layout

Read `TASK.md` for what to build. This file only covers where the code goes, so
the result can be picked up automatically.

Build the project in this directory:

```
.
├── trigger.config.ts   # points at ./src/trigger
└── src/
    └── trigger/        # all task definitions live here, across as many files as you like
```

- Put every task definition under `src/trigger/`.
- Write only inside this directory.
- Declare and install every dependency you use.

You do not need to deploy or run anything.
