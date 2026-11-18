"""Tor settings shared by first-run provisioning and the Tor migration.

Every public NCC service gets its own onion service. Tor's ADD_ONION maps
onion port 80 to one loopback HTTP target per service, so the relay, Npanel,
Ditto Web, ncc-search and the admin panel each publish a distinct onion
endpoint in their own NCC-05 locator.

Kept free of sidecar and Compose dependencies so it can be unit tested.
"""

TOR_CONTROL_HOST = '127.0.0.1'
TOR_CONTROL_PORT = 9051

# The relay backend already speaks plain WebSocket, so its onion target is the
# loopback port Compose publishes for it rather than a Caddy listener.
RELAY_LOCAL_PORT = 13131

DEFAULT_TARGET_PORTS = {
    'npanel': 18045,
    'ditto': 18046,
    'search': 18047,
    'admin': 18048,
}


def target_ports(env):
    """Loopback HTTP ports Caddy exposes for each onion service."""
    return {
        'npanel': int(env.get('TOR_NPANEL_PORT', DEFAULT_TARGET_PORTS['npanel'])),
        'ditto': int(env.get('TOR_DITTO_WEB_PORT', DEFAULT_TARGET_PORTS['ditto'])),
        'search': int(env.get('TOR_SEARCH_PORT', DEFAULT_TARGET_PORTS['search'])),
        'admin': int(env.get('TOR_ADMIN_PORT', DEFAULT_TARGET_PORTS['admin'])),
    }


def local_port_for(service_id, env):
    """Loopback port that one service's onion maps to."""
    if service_id in {'web', 'addr'}:
        return int(env.get('CONTENT_PORT', '8080'))
    if service_id == 'relay':
        return RELAY_LOCAL_PORT
    return target_ports(env)[service_id]


def enable_service_tor(config, *, password, local_port,
                       control_port=TOR_CONTROL_PORT):
    """Return a config that creates and publishes a real onion service.

    A manual onion_address is cleared: it would win over the address Tor
    actually created for this record and publish an endpoint the node does not
    serve.
    """
    updated = dict(config)
    protocols = dict(updated.get('protocols') or {})
    protocols['tor'] = True
    updated['protocols'] = protocols
    updated['local_port'] = local_port
    # Explicit null clears a stale manual address in a shallow config merge;
    # omitting the key would leave it in place and override Tor's address.
    updated['onion_address'] = None
    updated['tor_control'] = {
        'enabled': True,
        'host': TOR_CONTROL_HOST,
        'port': control_port,
        'password': password,
    }
    return updated


def reuse_onion_endpoint(config, address):
    """Return a config that publishes an existing onion without creating one.

    Used for the default `addr` profile: it serves the same content as `web`,
    so it advertises the same onion instead of creating a second address for
    the same page.
    """
    updated = dict(config)
    protocols = dict(updated.get('protocols') or {})
    protocols['tor'] = True
    updated['protocols'] = protocols
    updated['onion_address'] = address
    updated['tor_control'] = {'enabled': False}
    return updated
