# Dior always-on housekeeping

Install with `sh install-maintenance.sh` on the existing ARMv7 appliance. It installs
only the fixed-target Python helper and hourly cron entry, and enables `crond`.
It does not flash a partition, restart FlowBoard or restart its tunnel. Python 3
and the BusyBox OpenRC cron service are also declared in the image package.

`python3 /usr/local/libexec/dior-maintenance.py` is a dry run. Add `--apply` to
perform the bounded cleanup. The latest aggregate report replaces
`/var/lib/dior-maintenance/status.json`; there is no growing housekeeping log.

Policies:

- Preserve all accounts, final project JSON, business history, notifications,
  registered canvas assets, firmware, GPU runtime, and the deletion journals.
- Remove only exact atomic JSON-write temporaries older than 24 hours with no
  surviving writer PID and no open descriptor.
- Agent-owned Dior scratch has a 7-day retention and 128 MiB pressure budget;
  pressure cleanup still protects the last 24 hours, open files and running tests.
  Arbitrary `/tmp` directories are never cleaned.
- Downloaded APK/index cache has a 64 MiB budget. Running APK transactions and
  open files are protected; installed binaries and package databases are not cache.
- Keep the latest three recognized SHA-256 verified private deployment snapshots,
  including the most recent successful deployment. Unknown/incomplete/corrupt
  backup directories are preserved for review. A snapshot is already limited to
  20 MiB by the updater, so the recognized retained snapshots use at most 60 MiB
  plus small verification reports. Completed/healthy-rolled-back deployment
  staging directories are removed only with their verified snapshot present.
- OS diagnostic text logs (`apk.log`, hardware first-boot log, `dmesg`) have a
  1 MiB active threshold and one bounded tail archive. Application logs use the
  application writer's immediate byte limits instead.

The job holds a nonblocking lock, refuses symlinks/mount crossings/special files,
limits scans to 20,000 entries, and stops deletions after a 25-second time budget.
Protected or unknown data can intentionally exceed a cleanup budget; `pressure`
and `skippedUnsafe` expose this condition rather than erasing recoverable content.

Application limits are implemented in `frontend`: bounded diagnostic queues and
two-generation logs, 16 MiB static LRU, 32 ordinary API requests, TTL rate guards,
32 password tasks, bounded SMTP response/deadline, compact URL notification
dedupe, and conservative management upload maintenance. Valid project content,
complete history and active AI links are retained. API limit failures preserve
the previous committed record.

Regression: `python linux/dior/tests/test_maintenance.py` and
`pnpm --dir frontend run test:long-running`. The housekeeping filesystem tests
use explicitly checked isolated temporary roots; Linux also executes physical
symlink refusal cases.
