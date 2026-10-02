"""Exercise the actual GLES teardown helper; no EGL/GL driver is loaded."""
import ctypes
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest import mock

SOURCE = Path(__file__).resolve().parents[1] / 'graphics-legacy-apk/dior-gles-probe.py'
SPEC = importlib.util.spec_from_file_location('dior_gles_cleanup_under_test', SOURCE)
PROBE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROBE)


class FakeLibrary:
    def __init__(self, calls, failures=None):
        self.calls = calls
        self.failures = failures or {}

    def __getattr__(self, name):
        def function(*args):
            self.calls.append(name)
            failure = self.failures.get(name)
            if isinstance(failure, BaseException):
                raise failure
            if callable(failure):
                return failure(*args)
            if failure is not None:
                return failure
            if name == 'eglGetError':
                return 0x3006
            if name == 'glGetError':
                return 0
            return 1 if name.startswith('egl') else None
        return function


class CleanupTests(unittest.TestCase):
    def run_cleanup(self, failures=None, current=True, close_error=None):
        calls = []
        library = FakeLibrary(calls, failures)

        def close(_fd):
            calls.append('os.close')
            if close_error:
                raise close_error

        with mock.patch.object(PROBE.os, 'close', side_effect=close):
            result = PROBE.cleanup_resources(library, library, library,
                display=11, context=12, surface=13, display_initialized=True,
                context_current=current, programs=(ctypes.c_uint(21), ctypes.c_uint(22)),
                shaders=(ctypes.c_uint(23),), framebuffers=(ctypes.c_uint(24),),
                textures=(ctypes.c_uint(25),), gbm_device=14, fd=15)
        return result, calls

    def test_success_releases_gl_before_egl_and_fd_last(self):
        result, calls = self.run_cleanup()
        self.assertIs(result['cleanup_pass'], True)
        self.assertEqual(result['cleanup_errors'], [])
        self.assertEqual(result['cleanup_error'], '')
        self.assertEqual(calls, ['glDeleteProgram', 'glDeleteProgram', 'glDeleteShader',
            'glDeleteFramebuffers', 'glDeleteTextures', 'glGetError', 'eglMakeCurrent',
            'eglDestroyContext', 'eglDestroySurface', 'eglTerminate', 'gbm_device_destroy', 'os.close'])

    def test_never_current_skips_all_gl_calls_but_destroys_owned_egl_resources(self):
        result, calls = self.run_cleanup(current=False)
        self.assertTrue(result['cleanup_pass'])
        self.assertEqual(calls, ['eglDestroyContext', 'eglDestroySurface', 'eglTerminate',
                                 'gbm_device_destroy', 'os.close'])

    def test_every_egl_false_is_recorded_and_later_cleanup_still_runs(self):
        for name in ('eglMakeCurrent', 'eglDestroyContext', 'eglDestroySurface', 'eglTerminate'):
            with self.subTest(name=name):
                result, calls = self.run_cleanup({name: 0})
                self.assertIs(result['cleanup_pass'], False)
                self.assertIn('returned EGL_FALSE', result['cleanup_error'])
                self.assertIn('0x3006', result['cleanup_error'])
                self.assertIn('eglTerminate', calls)
                self.assertEqual(calls[-2:], ['gbm_device_destroy', 'os.close'])

    def test_gl_delete_exception_does_not_skip_other_objects_or_teardown(self):
        result, calls = self.run_cleanup({'glDeleteProgram': OSError('delete failed')})
        self.assertFalse(result['cleanup_pass'])
        self.assertEqual(calls.count('glDeleteProgram'), 2)
        self.assertIn('glDeleteTextures', calls)
        self.assertEqual(calls[-1], 'os.close')

    def test_gl_error_after_object_deletion_fails_cleanup_and_continues(self):
        values = iter((0x0502, 0))
        result, calls = self.run_cleanup({'glGetError': lambda *_: next(values)})
        self.assertFalse(result['cleanup_pass'])
        self.assertIn('GL error=0x0502', result['cleanup_error'])
        self.assertIn('eglDestroyContext', calls)
        self.assertEqual(calls[-1], 'os.close')

    def test_egl_exception_and_error_query_exception_do_not_skip_other_releases(self):
        for failures in ({'eglMakeCurrent': OSError('detach raised')},
                         {'eglDestroyContext': 0, 'eglGetError': RuntimeError('query raised')}):
            with self.subTest(failures=failures):
                result, calls = self.run_cleanup(failures)
                self.assertFalse(result['cleanup_pass'])
                self.assertIn('eglDestroySurface', calls)
                self.assertEqual(calls[-1], 'os.close')

    def test_gbm_and_close_exceptions_are_both_preserved(self):
        result, calls = self.run_cleanup({'gbm_device_destroy': OSError('GBM destroy failed')},
                                        close_error=OSError('close failed'))
        self.assertFalse(result['cleanup_pass'])
        self.assertEqual(calls[-2:], ['gbm_device_destroy', 'os.close'])
        self.assertEqual([item['operation'] for item in result['cleanup_errors']],
                         ['gbm_device_destroy', 'os.close'])

    def test_uninitialized_display_is_not_terminated(self):
        calls = []
        library = FakeLibrary(calls)
        result = PROBE.cleanup_resources(library, library, None, display=11,
                                         display_initialized=False)
        self.assertTrue(result['cleanup_pass'])
        self.assertEqual(calls, [])

    def test_complete_validation_rejects_cleanup_failure_or_missing_proof(self):
        passed = dict(status='PASS_GPU', hardware_render_pass=True,
                      hardware_shader_arithmetic_pass=True, stability_pass=True,
                      completed_iterations=3, requested_iterations=3,
                      cleanup_pass=True, cleanup_error='')
        self.assertTrue(PROBE.validation_pass(passed))
        for change in ({'cleanup_pass': False}, {'cleanup_error': 'eglDestroyContext failed'},
                       {'cleanup_pass': None}):
            with self.subTest(change=change):
                self.assertFalse(PROBE.validation_pass({**passed, **change}))

    def test_bounded_worker_cannot_validate_failed_cleanup_on_zero_exit(self):
        result = dict(status='PASS_GPU', hardware_render_pass=True,
                      hardware_shader_arithmetic_pass=True, stability_pass=True,
                      completed_iterations=1, requested_iterations=1,
                      cleanup_pass=False, cleanup_error='eglTerminate returned EGL_FALSE')
        completed = subprocess.CompletedProcess([], 0, json.dumps(result), '')
        with mock.patch.object(PROBE.subprocess, 'run', return_value=completed):
            returned = PROBE.run_bounded('surfaceless', None)
        self.assertIs(returned['validation_pass'], False)


if __name__ == '__main__':
    unittest.main()
