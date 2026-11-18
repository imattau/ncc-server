import importlib.util
import pathlib
import sys
import unittest

SCRIPTS = pathlib.Path(__file__).parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))

import ncc_service_spec as spec_module  # noqa: E402

SPEC = importlib.util.spec_from_file_location(
    'npack_service', SCRIPTS / 'npack-service.py')
NPACK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(NPACK)

DIGEST = 'sha256:' + 'a' * 64


def descriptor(**overrides):
    value = {
        'schema': 1,
        'service_id': 'hello',
        'name': 'Hello Service',
        'summary': 'A friendly hello',
        'categories': ['Social'],
        'compose_service': 'app',
        'image': f'ghcr.io/acme/hello@{DIGEST}',
        'public_port': 8450,
        'backend_port': 18080,
        'container_port': 80,
        'probe_path': '/',
    }
    value.update(overrides)
    return value


class DescriptorTests(unittest.TestCase):
    def test_accepts_a_pinned_descriptor(self):
        normalized = spec_module.validate_descriptor(descriptor())
        self.assertEqual(normalized['service_id'], 'hello')
        self.assertEqual(normalized['image'], f'ghcr.io/acme/hello@{DIGEST}')
        self.assertEqual(normalized['probe_path'], '/')
        self.assertEqual(normalized['categories'], ['Social'])

    def test_rejects_a_mutable_image_for_signed_packages(self):
        with self.assertRaisesRegex(spec_module.DescriptorError, 'pinned by digest'):
            spec_module.validate_descriptor(descriptor(image='ghcr.io/acme/hello:latest'))

    def test_local_packages_may_still_use_a_tag(self):
        normalized = spec_module.validate_descriptor(
            descriptor(image='nginx:1.27-alpine'), require_digest=False)
        self.assertEqual(normalized['image'], 'nginx:1.27-alpine')

    def test_rejects_reserved_service_ids_and_ports(self):
        for service_id in ('web', 'relay', 'admin', 'sidecar', 'npack'):
            with self.assertRaisesRegex(spec_module.DescriptorError, 'reserved'):
                spec_module.validate_descriptor(descriptor(service_id=service_id))
        with self.assertRaisesRegex(spec_module.DescriptorError, 'reserved'):
            spec_module.validate_descriptor(descriptor(public_port=8443))
        with self.assertRaisesRegex(spec_module.DescriptorError, 'reserved'):
            spec_module.validate_descriptor(descriptor(backend_port=3000))

    def test_rejects_unknown_fields_instead_of_ignoring_them(self):
        with self.assertRaisesRegex(spec_module.DescriptorError, 'unknown'):
            spec_module.validate_descriptor(descriptor(privileged=True))

    def test_env_and_volumes_are_bounded_and_typed(self):
        normalized = spec_module.validate_descriptor(descriptor(
            env={'LOG_LEVEL': 'info'},
            volumes={'hello-data': '/data'},
        ))
        self.assertEqual(normalized['env'], {'LOG_LEVEL': 'info'})
        self.assertEqual(normalized['volumes'], {'hello-data': '/data'})

        with self.assertRaisesRegex(spec_module.DescriptorError, 'env name'):
            spec_module.validate_descriptor(descriptor(env={'lower': 'x'}))
        with self.assertRaisesRegex(spec_module.DescriptorError, 'volume path'):
            spec_module.validate_descriptor(descriptor(volumes={'data': 'relative'}))

    def test_icon_must_stay_inside_the_package(self):
        with self.assertRaisesRegex(spec_module.DescriptorError, 'package-relative'):
            spec_module.validate_descriptor(descriptor(icon='../icon.png'))

    def test_summary_and_description_are_capped(self):
        with self.assertRaisesRegex(spec_module.DescriptorError, '140'):
            spec_module.validate_descriptor(descriptor(summary='x' * 141))
        with self.assertRaisesRegex(spec_module.DescriptorError, '4000'):
            spec_module.validate_descriptor(descriptor(description='x' * 4001))


class ComposeTests(unittest.TestCase):
    def test_fragment_is_sandboxed_and_uses_only_the_declared_loopback_port(self):
        normalized = spec_module.validate_descriptor(descriptor(
            env={'LOG_LEVEL': 'info'},
            volumes={'hello-data': '/data'},
        ))
        compose = spec_module.render_compose(normalized)

        self.assertIn('127.0.0.1:18080:80', compose)
        self.assertIn('read_only: true', compose)
        self.assertIn('cap_drop:', compose)
        self.assertIn('no-new-privileges:true', compose)
        self.assertIn('LOG_LEVEL: "info"', compose)
        self.assertIn('hello-hello-data:/data', compose)
        self.assertNotIn('privileged', compose)
        self.assertNotIn('network_mode', compose)
        self.assertNotIn('/var/run/docker.sock', compose)

    def test_values_cannot_break_out_of_the_yaml(self):
        normalized = spec_module.validate_descriptor(descriptor(
            env={'MESSAGE': 'hello" privileged: true'},
        ))
        compose = spec_module.render_compose(normalized)
        self.assertIn('MESSAGE: "hello\\" privileged: true"', compose)


class PublisherTests(unittest.TestCase):
    def test_pins_an_image_digest(self):
        self.assertEqual(
            NPACK.pin_image(f'ghcr.io/acme/hello@{DIGEST}'),
            f'ghcr.io/acme/hello@{DIGEST}',
        )

    def test_splits_tags_from_registry_ports(self):
        self.assertEqual(
            NPACK.split_image_reference('registry.example:5000/acme/hello:1.2.3'),
            ('registry.example:5000/acme/hello', '1.2.3', None),
        )
        self.assertEqual(
            NPACK.split_image_reference(f'ghcr.io/acme/hello@{DIGEST}'),
            ('ghcr.io/acme/hello', None, DIGEST),
        )

    def test_app_metadata_matches_the_descriptor(self):
        normalized = spec_module.validate_descriptor(descriptor(
            homepage='https://example.com',
            license='MIT',
        ))
        app = spec_module.npack_app_metadata(normalized)
        self.assertEqual(app['summary'], 'A friendly hello')
        self.assertEqual(app['categories'], ['Social'])
        self.assertEqual(app['homepage'], 'https://example.com')
        self.assertEqual(app['license'], 'MIT')


if __name__ == '__main__':
    unittest.main()
