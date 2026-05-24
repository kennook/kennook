/**
 * Client-side pre-flight validators for the RunDialog form.
 *
 * Keyed by job id. A validator returns either `null` (form is OK) or
 * a string with the problem to show as a banner inside the dialog.
 * The user can't submit until the validator returns null.
 *
 * Validators live here (not in the catalog) because functions don't
 * serialize through the /api/admin/jobs/catalog JSON endpoint. The
 * server also re-checks for hard failures (`required` flag on the
 * option, type coercion) — these client validators are for friendlier
 * cross-field rules that would otherwise show up as a non-zero exit
 * with "Usage:" output that an operator might miss.
 */

type ArgValue = string | number | boolean | undefined;
type Args = Record<string, ArgValue>;
type Validator = (args: Args) => string | null;

export const JOB_VALIDATORS: Record<string, Validator> = {
  // Indexer needs either a folder path OR --retry (mutually exclusive).
  // Without either it just prints its usage and exits 1, leaving the
  // operator wondering what went wrong.
  indexer: (args) => {
    const path = typeof args.path === 'string' ? args.path.trim() : '';
    const retry = args.retry === true;
    if (!path && !retry) {
      return 'Provide a "Folder to index" path OR enable "Retry previously-failed files".';
    }
    if (path && retry) {
      return 'Choose path OR retry, not both — retry re-processes files saved from a previous run.';
    }
    return null;
  },
};

export function validateJobArgs(jobId: string, args: Args): string | null {
  const v = JOB_VALIDATORS[jobId];
  return v ? v(args) : null;
}
