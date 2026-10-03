"""Host subprocess fixtures for the private Android GPU production launcher."""
import importlib.util
import json
import os
from pathlib import Path
import stat
import struct
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / 'graphics-android/run-native.py'
SPEC = importlib.util.spec_from_file_location('native_gpu_runner', SCRIPT)
RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUNNER)


def opencl_pass():
    return {'status': 'PASS_GPU_COMPUTE', 'hardware_compute_pass': True,
            'requested_iterations': 3, 'completed_iterations': 3, 'device_type': 4,
            'device_available': True, 'compiler_available': True, 'error': None,
            'cleanup_error': None}


def property_area(populated=False):
    data = bytearray(RUNNER.PROPERTY_SIZE)
    struct.pack_into('<IIII', data, 0, *RUNNER.PROPERTY_HEADER)
    if populated:
        # A real two-level KitKat trie for ro.hardware=qcom. Relative data
        # offsets: root=0, ro=20, hardware=44, prop_info=76, bytes_used=184.
        struct.pack_into('<I', data, 0, 184)
        struct.pack_into('<I', data, 128+16, 20)
        struct.pack_into('<B3xIIII', data, 128+20, 2, 0, 0, 0, 44)
        data[128+40:128+43] = b'ro\0'
        struct.pack_into('<B3xIIII', data, 128+44, 8, 76, 0, 0, 0)
        data[128+64:128+73] = b'hardware\0'
        struct.pack_into('<I', data, 128+76, 4 << 24)
        data[128+80:128+85] = b'qcom\0'
        data[128+172:128+184] = b'ro.hardware\0'
    return data


class NativeGpuRunnerTests(unittest.TestCase):
    def child(self, source, timeout=3):
        return RUNNER.run_child([sys.executable, '-c', source], dict(os.environ), None, timeout)

    def test_success_and_raw_stderr(self):
        source = "import sys; print(%r); sys.stderr.buffer.write(b'vendor\\xff\\n')" % json.dumps(opencl_pass())
        done = self.child(source)
        result, code = RUNNER.child_result('opencl', [], done)
        self.assertEqual(code, 0)
        self.assertTrue(result['hardware_compute_pass'])
        self.assertEqual(done['stderr'], b'vendor\xff\n')

    def test_invalid_json_and_non_object_are_failures(self):
        for text in ('native diagnostic', '[]', '{broken', ''):
            done = self.child('print(%r)' % text)
            result, code = RUNNER.child_result('opencl', [], done)
            self.assertEqual(code, 1)
            self.assertFalse(result['hardware_compute_pass'])
            self.assertEqual(result['status'], 'FAIL_NATIVE_OUTPUT')

    def test_zero_exit_with_incomplete_or_cpu_claim_is_rejected(self):
        for fields in ({}, dict(opencl_pass(), completed_iterations=2),
                       dict(opencl_pass(), device_type=2), dict(opencl_pass(), compiler_available=False)):
            done = self.child('print(%r)' % json.dumps(fields))
            result, code = RUNNER.child_result('opencl', [], done)
            self.assertEqual(code, 1)
            self.assertFalse(result['hardware_compute_pass'])

    def test_failed_exit_cannot_keep_a_success_claim(self):
        done = self.child('import sys; print(%r); sys.exit(7)' % json.dumps(opencl_pass()))
        result, code = RUNNER.child_result('opencl', [], done)
        self.assertEqual(code, 7)
        self.assertEqual(result['native_returncode'], 7)
        self.assertFalse(result['hardware_compute_pass'])

    def test_native_failure_exit_is_forwarded(self):
        failed = {'status': 'FAIL', 'hardware_compute_pass': False, 'error': 'context failed'}
        done = self.child('import sys; print(%r); sys.exit(3)' % json.dumps(failed))
        result, code = RUNNER.child_result('opencl', [], done)
        self.assertEqual(code, 3)
        self.assertEqual(result, failed)

    def test_signal_exit_maps_to_shell_status(self):
        result, code = RUNNER.child_result('opencl', [], {
            'returncode': -11, 'runner_error': None,
            'stdout': json.dumps(opencl_pass()).encode(), 'stderr': b''})
        self.assertEqual(code, 139)
        self.assertFalse(result['hardware_compute_pass'])

    def test_deadline_kills_child_and_reports_timeout(self):
        start = time.monotonic()
        done = self.child('import time; time.sleep(10)', timeout=0.15)
        self.assertLess(time.monotonic()-start, 3)
        result, code = RUNNER.child_result('opencl', [], done)
        self.assertEqual(code, 124)
        self.assertIn('TIMEOUT', result['status'])
        self.assertFalse(result['hardware_compute_pass'])

    def test_output_flood_is_bounded_and_fails(self):
        done = self.child("import sys; sys.stdout.write('X' * 3000000); sys.stdout.flush()")
        self.assertLessEqual(len(done['stdout']), RUNNER.STDOUT_LIMIT)
        result, code = RUNNER.child_result('opencl', [], done)
        self.assertEqual(code, 1)
        self.assertIn('OUTPUT_LIMIT', result['status'])

    def test_inventory_success_requires_explicit_request(self):
        inventory = {'status': 'INVENTORY_ONLY', 'inventory_pass': True, 'hardware_compute_pass': False}
        done = self.child('print(%r)' % json.dumps(inventory))
        result, code = RUNNER.child_result('opencl', ['--inventory-only'], done)
        self.assertEqual(code, 0)
        self.assertFalse(result['hardware_compute_pass'])
        self.assertEqual(RUNNER.child_result('opencl', [], done)[1], 1)

    def test_gles_success_uses_its_own_capability_fields(self):
        gles = {'status': 'PASS_GPU_RENDER', 'hardware_render_pass': True,
                'gles_fragment_compute_pass': True, 'hardware_identity': True,
                'software_renderer': False, 'cleanup_passed': True,
                'repeat': 3, 'completed_iterations': 3, 'gl_error': 0, 'egl_error': 0, 'error': ''}
        done = self.child('print(%r)' % json.dumps(gles))
        self.assertEqual(RUNNER.child_result('gles', [], done)[1], 0)
        self.assertEqual(RUNNER.child_result('opencl', [], done)[1], 1)
        gles['software_renderer'] = True
        self.assertFalse(RUNNER.native_success('gles', gles, []))

    def test_path_escape_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            prefix = root/'private'; prefix.mkdir()
            outside = root/'outside'; outside.write_bytes(b'not a probe')
            with self.assertRaises(RUNNER.RuntimeErrorDetail):
                RUNNER.within_prefix(outside, prefix.resolve())

    def test_missing_installer_property_file_is_never_created(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'bin').mkdir()
            (root/'bin/dior-opencl-probe').write_bytes(b'fixture executable')
            for subdirectory in ('system/lib', 'system/vendor/lib/egl'):
                (root/subdirectory).mkdir(parents=True)
            with mock.patch.object(RUNNER, 'trusted_path'), mock.patch.object(RUNNER.os, 'access', return_value=True), \
                    mock.patch.object(RUNNER, 'library_paths', return_value=[]):
                with self.assertRaises(FileNotFoundError):
                    RUNNER.runtime_environment('opencl', [], root)
            self.assertFalse((root/'properties-area').exists())

    def test_empty_and_populated_kitkat_areas_are_accepted(self):
        self.assertEqual(RUNNER.validate_property_area(property_area())['properties'], 0)
        populated = RUNNER.validate_property_area(property_area(True))
        self.assertEqual(populated['properties'], 1)
        self.assertEqual(populated['trie_nodes'], 2)
        self.assertEqual(populated['bytes_used'], 184)
        self.assertNotIn('value', populated)

    def test_property_header_lengths_and_root_links_are_checked(self):
        for used in (0, 19, 21, RUNNER.PROPERTY_SIZE):
            data = property_area(); struct.pack_into('<I', data, 0, used)
            with self.assertRaises(RUNNER.RuntimeErrorDetail):
                RUNNER.validate_property_area(data)
        for index, value in ((2, 0), (3, 0)):
            data = property_area(); struct.pack_into('<I', data, index*4, value)
            with self.assertRaises(RUNNER.RuntimeErrorDetail):
                RUNNER.validate_property_area(data)
        data = property_area(); struct.pack_into('<I', data, 128+4, 20)
        with self.assertRaises(RUNNER.RuntimeErrorDetail):
            RUNNER.validate_property_area(data)

    def test_property_trie_cyclic_and_out_of_bounds_links_are_rejected(self):
        for link in (16, 21, 184, 4096, 20):
            data = property_area(True)
            struct.pack_into('<I', data, 128+20+16, link)
            with self.assertRaises(RUNNER.RuntimeErrorDetail):
                RUNNER.validate_property_area(data)

    def test_property_objects_and_value_lengths_are_bounded(self):
        mutations = ((128+44+4, 180), (128+44+4, 77),
                     (128+76, 92 << 24), (128+76, (4 << 24) | 1))
        for offset, value in mutations:
            data = property_area(True); struct.pack_into('<I', data, offset, value)
            with self.assertRaises(RUNNER.RuntimeErrorDetail):
                RUNNER.validate_property_area(data)
        data = property_area(True); data[128+183] = ord('x')
        with self.assertRaises(RUNNER.RuntimeErrorDetail):
            RUNNER.validate_property_area(data)

    @unittest.skipUnless(os.name == 'posix', 'private alias symlink fixture requires POSIX')
    def test_private_alias_directory_is_first_and_cannot_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for relative in ('aliases', 'system/lib', 'system/vendor/lib/egl'):
                (root/relative).mkdir(parents=True)
            (root/'aliases/system').symlink_to('../system', target_is_directory=True)
            (root/'aliases/vendor').symlink_to('../system/vendor', target_is_directory=True)
            with mock.patch.object(RUNNER, 'trusted_path'):
                directories = RUNNER.library_paths(root.resolve())
                self.assertEqual(directories[0], str(root/'aliases'))
                self.assertEqual(len(directories), 4)
                (root/'aliases/vendor').unlink()
                (root/'aliases/vendor').symlink_to(directory, target_is_directory=True)
                with self.assertRaises(RUNNER.RuntimeErrorDetail):
                    RUNNER.library_paths(root.resolve())

    @unittest.skipUnless(os.name == 'posix', 'inherited descriptor validation requires POSIX')
    def test_valid_private_descriptor_is_inherited_without_sudo(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'bin').mkdir()
            executable = root/'bin/dior-opencl-probe'; executable.write_text('#!/bin/sh\nexit 0\n', encoding='ascii')
            executable.chmod(0o755)
            for subdirectory in ('system/lib', 'system/vendor/lib/egl'):
                (root/subdirectory).mkdir(parents=True)
            data = property_area(True)
            properties = root/'properties-area'; properties.write_bytes(data); properties.chmod(0o444)
            # The fixture is owned by the test user; installation ownership is
            # independently checked by production. Use the real descriptor,
            # real format and real inherited-child read in this regression.
            actual_fstat = os.fstat
            def fixture_fstat(fd):
                fields = list(actual_fstat(fd)); fields[4] = 0
                return os.stat_result(fields)
            with mock.patch.object(RUNNER, 'trusted_path'), mock.patch.object(RUNNER.os, 'fstat', side_effect=fixture_fstat), \
                    mock.patch.object(RUNNER, 'library_paths', return_value=[]):
                path, environment, descriptor = RUNNER.runtime_environment('opencl', [], root)
            try:
                source = 'import os; fd=int(os.environ["ANDROID_PROPERTY_WORKSPACE"].split(",")[0]); print(os.read(fd,16).hex())'
                done = RUNNER.run_child([sys.executable, '-c', source], environment, descriptor, 3)
                self.assertEqual(done['returncode'], 0)
                self.assertEqual(done['stdout'].strip(), bytes(data[:16]).hex().encode())
            finally:
                os.close(descriptor)


if __name__ == '__main__':
    unittest.main()
