import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('dmw_backup', Path(__file__).with_name('backup.py'))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class RecoveryTest(unittest.TestCase):
    def test_snapshot_restore_tamper_and_symlink(self):
        with tempfile.TemporaryDirectory(prefix='dmw-backup-') as temporary:
            root = Path(temporary).resolve()
            root.chmod(0o700)
            data, snapshot, restored = (root / n for n in ['operator', 'snapshot', 'restored'])
            data.mkdir(mode=0o700)
            (data / 'share.enc').write_bytes(b'disposable-encrypted-fixture')
            (data / 'share.enc').chmod(0o600)
            backup.backup(data, snapshot)
            backup.restore(snapshot, restored)
            self.assertEqual(backup.inventory(data), backup.inventory(restored))
            with self.assertRaises(ValueError):
                backup.restore(snapshot, restored)
            (snapshot / 'data' / 'share.enc').write_bytes(b'tampered')
            with self.assertRaises(ValueError):
                backup.restore(snapshot, root / 'tampered')
            (data / 'outside').symlink_to(root / 'snapshot')
            with self.assertRaises(ValueError):
                backup.backup(data, root / 'linked')
            (data / 'outside').unlink()
            linked = root / 'linked-source'
            linked.symlink_to(data, target_is_directory=True)
            with self.assertRaises(ValueError):
                backup.inventory(linked)


if __name__ == '__main__':
    unittest.main()
