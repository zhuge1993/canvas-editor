"""Packaging tests with dummy files: NOT kernel builds or real flash tests."""
from __future__ import annotations
import importlib.util
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location(
    'dior_public', Path(__file__).resolve().parents[1] / 'seal-public-image.py')
assert SPEC and SPEC.loader
PUBLIC = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PUBLIC)


class PublicImageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.keys = tempfile.TemporaryDirectory(prefix='dior-test-key-')
        cls.addClassCleanup(cls.keys.cleanup)
        cls.private = Path(cls.keys.name) / 'private.pem'
        cls.public = Path(cls.keys.name) / 'public.pem'
        subprocess.run(['openssl', 'genpkey', '-algorithm', 'RSA', '-pkeyopt',
                        'rsa_keygen_bits:2048', '-out', str(cls.private)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['openssl', 'pkey', '-in', str(cls.private), '-pubout',
                        '-out', str(cls.public)], check=True, stdout=subprocess.DEVNULL)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='dior-public-test-')
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name)
        self.images = self.state / 'images'
        self.images.mkdir()
        self.password = '0123456789abcdef' * 2
        (self.state / 'login-password').write_text(self.password)
        (self.state / 'UPSTREAM-REVISIONS.txt').write_text('repository_revision=' + 'a' * 40 + '\n')
        (self.images / 'FIRST-LOGIN.txt').write_text(f'user=dior\npassword={self.password}\n')
        (self.images / 'boot.img-xiaomi-dior').write_bytes(b'DUMMY TEST FILE - NOT FLASHABLE')
        (self.images / 'SHA256SUMS').write_text(''.join(
            f'{PUBLIC.sha256(file)}  {file.name}\n' for file in sorted(self.images.iterdir())))

    def test_receipt_encrypted_and_decryptable_only_with_private_key(self):
        archive = PUBLIC.seal_candidate(self.state, self.public)
        recovered = subprocess.run([
            'openssl', 'pkeyutl', '-decrypt', '-inkey', str(self.private),
            '-in', str(self.images / 'FIRST-LOGIN.enc'),
            '-pkeyopt', 'rsa_padding_mode:oaep', '-pkeyopt', 'rsa_oaep_md:sha256',
            '-pkeyopt', 'rsa_mgf1_md:sha256'], check=True, capture_output=True).stdout
        self.assertEqual(recovered, f'user=dior\npassword={self.password}\n'.encode())
        with tarfile.open(archive) as tar:
            for item in tar:
                if item.isfile():
                    self.assertNotIn(self.password.encode(), tar.extractfile(item).read())
                    self.assertNotIn('PRIVATE KEY', item.name)
        subprocess.run(['sha256sum', '-c', 'SHA256SUMS'], cwd=self.images,
                       check=True, stdout=subprocess.DEVNULL)
        subprocess.run(['sha256sum', '-c', 'SHA256SUMS'], cwd=archive.parent,
                       check=True, stdout=subprocess.DEVNULL)

    def test_missing_public_key_fails_before_publication(self):
        with self.assertRaises(subprocess.CalledProcessError):
            PUBLIC.seal_candidate(self.state, self.state / 'missing.pem')
        self.assertFalse((self.state / 'public-release').exists())

    def test_mismatched_receipt_fails_before_publication(self):
        (self.state / 'login-password').write_text('f' * 32)
        with self.assertRaises(ValueError):
            PUBLIC.seal_candidate(self.state, self.public)
        self.assertFalse((self.state / 'public-release').exists())

    def test_secret_elsewhere_in_export_blocks_publication(self):
        image = self.images / 'boot.img-xiaomi-dior'
        image.write_bytes(b'X' * (1024 * 1024 - 8) + self.password.encode())
        (self.images / 'SHA256SUMS').write_text(''.join(
            f'{PUBLIC.sha256(file)}  {file.name}\n'
            for file in sorted(self.images.iterdir()) if file.name != 'SHA256SUMS'))
        with self.assertRaises(ValueError):
            PUBLIC.seal_candidate(self.state, self.public)
        self.assertFalse((self.state / 'public-release').exists())

    def test_corrupt_candidate_fails_before_publication(self):
        (self.images / 'boot.img-xiaomi-dior').write_bytes(b'corrupt')
        with self.assertRaises(subprocess.CalledProcessError):
            PUBLIC.seal_candidate(self.state, self.public)
        self.assertFalse((self.state / 'public-release').exists())


if __name__ == '__main__':
    unittest.main()
