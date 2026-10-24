# Generation Pipeline Performance Baseline

This file records the deterministic synthetic baseline used by the
generation-pipeline performance plan.

The synthetic provider is a local stub. Model latency is therefore effectively
zero, and the absolute wall times are not representative of OpenRouter. The
baseline is useful for comparing call counts and the relative amount of
validation, tool, snapshot, and container work.

## Task 1 baseline

- Command: `pnpm test:generation:synthetic -- --seed 1729 --runs 1 --quiet`
- Seed: `1729`
- Result: 3 pages, 11 synthetic provider calls, successful publication
- Captured: 2026-07-30

| Stage request | Wall ms | Snapshot ms | Model calls | Model ms | Tool calls | Tool ms | Validation calls | Validation ms | Unattributed ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| analysis | 223 | 206 | 3 | 0 | 1 | 1 | 0 | 0 | 16 |
| structure | 56 | 44 | 2 | 0 | 0 | 0 | 0 | 0 | 12 |
| write batch 1 | 415 | 46 | 4 | 0 | 2 | 347 | 4 | 684 | 0 |
| write batch 2 | 429 | 47 | 2 | 0 | 1 | 210 | 2 | 374 | 0 |

Operation counts:

| Stage request | Operation breakdown |
| --- | --- |
| analysis | `analysis`: 3 calls; `Glob`: 1 call |
| structure | `structure`: 1 call; `structure_review`: 1 call |
| write batch 1 | `page_write`: 4 calls; `validate_page`: 2 calls; `mdx_compile`: 4 calls |
| write batch 2 | `page_write`: 2 calls; `validate_page`: 1 call; `mdx_compile`: 2 calls |

`validate_page` tool spans contain the nested `mdx_compile` work, so their
durations overlap. `unattributedMs` follows the plan contract and subtracts all
reported span categories before clamping at zero.

## After Task 2: MDX validator worker pool

The same seed and command were rerun after replacing one-process-per-validation
with the bounded validator pool.

| Stage request | Wall ms | Snapshot ms | Model calls | Model ms | Tool calls | Tool ms | Validation calls | Validation ms | Unattributed ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| analysis | 218 | 203 | 3 | 0 | 1 | 1 | 0 | 0 | 14 |
| structure | 60 | 47 | 2 | 0 | 0 | 0 | 0 | 0 | 13 |
| write batch 1 | 295 | 92 | 4 | 0 | 2 | 355 | 4 | 353 | 0 |
| write batch 2 | 223 | 51 | 2 | 0 | 1 | 164 | 2 | 165 | 0 |

The validation call count remains six. Validation time changed from 1,058 ms
across the two write batches to 518 ms, a 51% reduction in this deterministic
structural run. Combined write-stage wall time changed from 844 ms to 518 ms.
These are local stub-provider measurements, not production latency claims.

