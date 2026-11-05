/**
 * The time rules that keep index writers and the garbage collector apart. A
 * test keeps these relations true.
 */

/**
 * One scheduled run ends within this time, and after it no provider request can
 * start, even if a read stalled for the whole run.
 */
export const DOCS_SEARCH_RUN_BUDGET_MS = 4 * 60 * 1000;

/**
 * The first part of a run, for the sweep. A blocked sweep cannot take the time of
 * the index tasks, so one locked row cannot stop the builds of all sites.
 */
export const DOCS_SEARCH_SWEEP_BUDGET_MS = 60 * 1000;

/**
 * The first part of a run, for the sweep and the index tasks, counted from the
 * start of the run. Rechecks always get what stays.
 */
export const DOCS_SEARCH_TASK_BUDGET_MS = 3 * 60 * 1000;

/** A claim outlives the run that holds it, so two writers never overlap. */
export const DOCS_SEARCH_LEASE_SECONDS = 10 * 60;

/**
 * How long an index waits before it is deleted. It is longer than a run, so a
 * writer that was active when the index retired has stopped: for example a
 * writer that was running when the owner deleted the project. It is short, so
 * replaced indexes do not hold cluster RAM for long.
 */
export const DOCS_SEARCH_COLLECT_GRACE_SECONDS = 15 * 60;

/**
 * How long a site can serve an older index while the live version's index cannot
 * be built, across publishes and retries. After it, the site uses browser search
 * of the live version, so a removed page cannot stay in results. It is about as
 * long as all the retries of one task.
 */
export const DOCS_SEARCH_PREVIOUS_INDEX_MAX_AGE_SECONDS = 60 * 60;

/** How long a live version waits between two comparisons with its provider. */
export const DOCS_SEARCH_RECHECK_SECONDS = 60 * 60;
