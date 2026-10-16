import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('milo_deploy', Path(__file__).with_name('milo-github-deploy.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class MiloDeploymentTests(unittest.TestCase):
    def test_forced_key_rejects_commands_before_any_host_access(self):
        for command in ['bash', 'deploy ../escape', 'deploy ' + 'a' * 40 + '; id', 'scp -t /tmp/file']:
            with patch.dict(module.os.environ, {'SSH_ORIGINAL_COMMAND': command}):
                with self.assertRaisesRegex(ValueError, 'Only a canonical'):
                    module.main()

    def test_revision_update_preserves_other_environment_values(self):
        original = 'MILO_BUILD_REVISION=old\nMODEL_DIRECTORY=/opt/milo/models\nVOICE_KEY=test-only\n'
        updated = module.replace_revision(original, 'a' * 40)
        self.assertIn('MODEL_DIRECTORY=/opt/milo/models\nVOICE_KEY=test-only\n', updated)
        self.assertEqual(updated.count('MILO_BUILD_REVISION='), 1)
        self.assertTrue(updated.endswith('MILO_BUILD_REVISION=' + 'a' * 40 + '\n'))


if __name__ == '__main__':
    unittest.main()
