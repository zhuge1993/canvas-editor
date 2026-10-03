"""Real isolated filesystem housekeeping tests; no production path is touched."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
import unittest

SOURCE = Path(__file__).resolve().parents[1] / 'always-on-maintenance/dior-maintenance.py'
SPEC = importlib.util.spec_from_file_location('dior_maintenance_tested', SOURCE)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class Tests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='dior-housekeeping-test-')
        self.base = Path(self.temporary.name).resolve()
        self.assertEqual(self.base.parent, Path(tempfile.gettempdir()).resolve())
        self.now = time.time()
        self.proc = self.base / 'fake-proc'
        self.proc.mkdir()

    def tearDown(self):
        # Checked absolute, explicitly named test directory, never a computed production root.
        self.assertEqual(self.base.parent, Path(tempfile.gettempdir()).resolve())
        self.assertTrue(self.base.name.startswith('dior-housekeeping-test-'))
        self.temporary.cleanup()

    def file(self, relative, content=b'payload', age=0):
        file = self.base / relative.lstrip('/')
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(content)
        os.utime(file, (self.now-age, self.now-age))
        return file

    def cleaner(self, apply=True):
        return MODULE.Maintenance(self.base, self.now, apply, self.proc)

    def test_stale_atomic_temp_only_and_live_pid_protected(self):
        stale = self.file('/opt/flowboard/auth-data/sessions.json.98765.abcdef012345.tmp', age=2*MODULE.DAY)
        live = self.file('/opt/flowboard/auth-data/users.json.123.abcdef012345.tmp', age=2*MODULE.DAY)
        (self.proc / '123').mkdir()
        final = self.file('/opt/flowboard/auth-data/users.json')
        unknown = self.file('/opt/flowboard/auth-data/sessions.json.tmp', age=20*MODULE.DAY)
        journal = self.file('/opt/flowboard/project-data/management/.deletions/record/journal.json.98765.abcdef012345.tmp', age=20*MODULE.DAY)
        self.cleaner().transient_writes()
        self.assertFalse(stale.exists())
        for retained in (live, final, unknown, journal): self.assertTrue(retained.exists())

    def test_scratch_age_dry_run_and_arbitrary_tmp_preserved(self):
        old = self.file('/tmp/dior-kernel-test/results/probe.log', age=8*MODULE.DAY)
        fresh = self.file('/tmp/dior-kernel-test/current.tar.gz')
        other = self.file('/tmp/user-important/file', age=100*MODULE.DAY)
        dry = self.cleaner(False); dry.scratch()
        self.assertTrue(old.exists()); self.assertEqual(dry.result['removedFiles'], 1)
        self.cleaner().scratch()
        self.assertFalse(old.exists()); self.assertTrue(fresh.exists()); self.assertTrue(other.exists())

    def test_open_inode_and_active_test_path_protected(self):
        old = self.file('/tmp/dior-kernel-test/results/probe.log', age=8*MODULE.DAY)
        cleaner = self.cleaner(); info = old.stat()
        cleaner.open_inodes.add((info.st_dev, info.st_ino)); cleaner.scratch()
        self.assertTrue(old.exists())
        cleaner = self.cleaner(); cleaner.active_paths = [str(old.parent) + ' fixture']; cleaner.scratch()
        self.assertTrue(old.exists())

    def test_apk_cache_byte_bound_and_busy_protection(self):
        old = self.file('/var/cache/apk/old-1.apk', b'x' * (33*MODULE.MIB), age=2*MODULE.DAY)
        newest = self.file('/var/cache/apk/current-2.apk', b'x' * (33*MODULE.MIB))
        cleaner = self.cleaner(); cleaner.apk_busy = True; cleaner.apk_cache()
        self.assertTrue(old.exists())
        self.cleaner().apk_cache()
        self.assertFalse(old.exists()); self.assertTrue(newest.exists())

    def backup(self, number, result='PASS', corrupt=False):
        folder = self.base / f'root/flowboard-private-backups/workspace-20260101-00000{number}-abcdef012345'
        snapshot = self.file(str(folder.relative_to(self.base) / 'snapshot.tar.gz'))
        report = {'schemaVersion': 1, 'result': result, 'backupDirectory': str(folder),
                  'backupSha256': 'bad' if corrupt else hashlib.sha256(snapshot.read_bytes()).hexdigest()}
        self.file(str(folder.relative_to(self.base) / 'verification.json'), json.dumps(report).encode())
        return folder

    def test_latest_three_verified_backups_and_latest_good_kept(self):
        good = self.backup(0)
        oldest = self.backup(1, 'FAILED_ROLLED_BACK')
        self.backup(2, 'FAILED_ROLLED_BACK'); self.backup(3, 'FAILED_ROLLED_BACK')
        corrupt = self.backup(4, corrupt=True)
        cleaner = self.cleaner(); cleaner.backups()
        self.assertTrue(good.exists()); self.assertFalse(oldest.exists()); self.assertTrue(corrupt.exists())
        self.assertEqual(cleaner.result['verifiedBackupsKept'], 3)
        self.assertEqual(cleaner.result['skippedUnsafe'], 1)

    def test_log_size_rotation_keeps_writer_inode_and_bounded_archive(self):
        log = self.file('/var/log/apk.log', b'line\n' * 300000)
        inode = log.stat().st_ino
        self.cleaner().logs()
        self.assertEqual(log.stat().st_size, 0); self.assertEqual(log.stat().st_ino, inode)
        self.assertLessEqual(log.with_name('apk.log.1').stat().st_size, MODULE.MIB)

    def test_finished_deployment_stage_only_and_unknown_contents_preserved(self):
        backup = self.backup(1)
        stage = self.base / ('opt/flowboard/.workspace-stage-' + backup.name[len('workspace-'):])
        self.file(str(stage.relative_to(self.base) / 'candidate.tar.gz'))
        self.file(str(stage.relative_to(self.base) / 'program/dist/index.html'))
        unknown_backup = self.backup(2)
        unknown_stage = self.base / ('opt/flowboard/.workspace-stage-' + unknown_backup.name[len('workspace-'):])
        self.file(str(unknown_stage.relative_to(self.base) / 'private-unknown-data'))
        hidden_backup = self.backup(3)
        hidden_stage = self.base / ('opt/flowboard/.workspace-stage-' + hidden_backup.name[len('workspace-'):])
        self.file(str(hidden_stage.relative_to(self.base) / 'program/.deletions/recoverable.json'))
        cleaner = self.cleaner(); cleaner.backups()
        self.assertFalse(stage.exists()); self.assertTrue(unknown_stage.exists())
        self.assertTrue((hidden_stage / 'program/.deletions/recoverable.json').exists())
        self.assertEqual(cleaner.result['removedStages'], 1)

    def test_backup_unknown_empty_directory_or_hidden_journal_is_preserved(self):
        unknown = self.backup(0)
        (unknown / '.deletions').mkdir()
        self.file(str(unknown.relative_to(self.base) / '.deletions/recoverable.json'))
        self.backup(1); self.backup(2); self.backup(3)
        empty = self.backup(4); (empty / 'unknown-empty').mkdir()
        cleaner = self.cleaner(); cleaner.backups()
        self.assertTrue((unknown / '.deletions/recoverable.json').exists())
        self.assertTrue(empty.exists()); self.assertEqual(cleaner.result['skippedUnsafe'], 2)

    @unittest.skipIf(os.name == 'nt', 'Physical symlink refusal runs on Linux phone')
    def test_symlink_roots_never_followed(self):
        outside = self.file('/outside/data', age=20*MODULE.DAY)
        linked = self.base / 'tmp/dior-kernel-test'; linked.parent.mkdir(parents=True)
        linked.symlink_to(outside.parent, target_is_directory=True)
        cleaner = self.cleaner(); cleaner.scratch()
        self.assertTrue(outside.exists()); self.assertEqual(cleaner.result['skippedUnsafe'], 1)


if __name__ == '__main__':
    unittest.main()
