/**
 * Render the optional public HTTPS front doors configured from the NCC admin
 * panel.
 *
 * This module is deliberately pure: the node-agent owns the file write and
 * the Caddy reload, and the sidecar reuses `normalizePublicDomain` so both
 * sides agree on what a valid name looks like. Nothing here touches NCC
 * records, endpoints or certificate pins; a public domain is an extra
 * standard-HTTPS address for an existing service.
 */

import { domainToASCII } from 'node:url';

const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SERVICE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const OPERATOR_PUBKEY = /^[0-9a-f]{64}$/;
const LOOPBACK = /^127\.0\.0\.1:([1-9][0-9]{0,4})$/;
const HOST_VALUE = /^[A-Za-z0-9.:[\]-]{1,253}$/;
const BODY_LIMITS = new Set(['small', 'app']);
const TARGET_KINDS = new Set(['proxy', 'search', 'static', 'admin']);
const RESERVED_SUFFIXES = [
  'localhost',
  'local',
  'internal',
  'lan',
  'home.arpa',
  'test',
  'invalid',
  'example',
];

export const MAX_CADDY_SITES = 64;
export const CADDY_SITES_FILE = '50-ncc-public-domains.caddy';

/**
 * Normalise an operator-entered public domain, or return null.
 *
 * The result is lowercase ASCII without a trailing dot. It must be a real
 * multi-label DNS name: IP addresses, single labels, wildcards, schemes,
 * paths, ports and local/reserved suffixes are rejected so Caddy is never
 * asked to issue a certificate for something that cannot work publicly.
 */
export function normalizePublicDomain(raw) {
  if (typeof raw !== 'string') return null;
  let value = raw.trim().toLowerCase();
  if (!value) return null;
  if (value.endsWith('.')) value = value.slice(0, -1);
  if (!value || value.length > 253) return null;
  if (value.includes('://') || value.includes('/') || value.includes('?')
    || value.includes('#') || value.includes(':') || value.includes('*')
    || /\s/.test(value)) {
    return null;
  }

  const ascii = domainToASCII(value);
  if (!ascii || ascii.length > 253) return null;
  const labels = ascii.split('.');
  if (labels.length < 2) return null;
  if (labels.some((label) => !DOMAIN_LABEL.test(label))) return null;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ascii)) return null;
  if (RESERVED_SUFFIXES.some((suffix) => ascii === suffix || ascii.endsWith(`.${suffix}`))) {
    return null;
  }

  return ascii;
}

function fail(message) {
  throw new Error(message);
}

function normalizeLoopback(value, field) {
  if (typeof value !== 'string') fail(`${field} must be a loopback address`);
  const match = LOOPBACK.exec(value);
  if (!match) fail(`${field} must be 127.0.0.1:<port>`);
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`${field} has an invalid port`);
  }
  return value;
}

function normalizeHost(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !HOST_VALUE.test(value)) {
    fail(`${field} is not a valid host value`);
  }
  return value;
}

function normalizeBody(value, field) {
  if (value === undefined) return 'small';
  if (typeof value !== 'string' || !BODY_LIMITS.has(value)) {
    fail(`${field} must be "small" or "app"`);
  }
  return value;
}

function normalizeTarget(value, serviceId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${serviceId}: target must be an object`);
  }
  if (!TARGET_KINDS.has(value.kind)) {
    fail(`${serviceId}: unsupported target kind`);
  }

  const body = normalizeBody(value.body, `${serviceId}.target.body`);
  if (value.kind === 'proxy') {
    return {
      kind: 'proxy',
      dial: normalizeLoopback(value.dial, `${serviceId}.target.dial`),
      host: normalizeHost(value.host, `${serviceId}.target.host`),
      body,
      realIp: value.realIp === true,
    };
  }

  if (value.kind === 'search') {
    return {
      kind: 'search',
      ui: normalizeLoopback(value.ui, `${serviceId}.target.ui`),
      api: normalizeLoopback(value.api, `${serviceId}.target.api`),
      host: normalizeHost(value.host, `${serviceId}.target.host`),
      body,
    };
  }

  return { kind: value.kind, body };
}

/**
 * Validate and normalise the node-agent request. Raw Caddyfile text is never
 * accepted; only this small structured shape is.
 */
export function normalizeCaddySites(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('sites request must be an object');
  }

  const operatorPubkey = input.operatorPubkey === undefined || input.operatorPubkey === null
    ? null
    : String(input.operatorPubkey).toLowerCase();
  if (operatorPubkey !== null && !OPERATOR_PUBKEY.test(operatorPubkey)) {
    fail('operatorPubkey must be a 64-character hex public key');
  }

  if (!Array.isArray(input.sites)) fail('sites must be an array');
  if (input.sites.length > MAX_CADDY_SITES) fail(`use at most ${MAX_CADDY_SITES} public domains`);

  const domains = new Set();
  const sites = input.sites.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`sites[${index}] must be an object`);
    }
    if (typeof entry.serviceId !== 'string' || !SERVICE_ID.test(entry.serviceId)) {
      fail(`sites[${index}].serviceId is not valid`);
    }

    const domain = normalizePublicDomain(entry.domain);
    if (!domain) fail(`sites[${index}].domain is not a valid public domain`);
    if (domains.has(domain)) fail(`duplicate public domain: ${domain}`);
    domains.add(domain);

    const target = normalizeTarget(entry.target, entry.serviceId);
    if ((target.kind === 'static' || target.kind === 'admin') && !operatorPubkey) {
      fail(`${entry.serviceId}: operatorPubkey is required for ${target.kind} sites`);
    }

    return { serviceId: entry.serviceId, domain, target };
  });

  sites.sort((left, right) => left.domain.localeCompare(right.domain));
  return { operatorPubkey, sites };
}

function renderHttpRedirect(domain) {
  return `http://${domain} {
\tredir https://{host}{uri} permanent
}`;
}

function renderProxy(site) {
  const { target } = site;
  const headers = [];
  if (target.host) headers.push(`\t\theader_up Host ${target.host}`);
  if (target.realIp) headers.push('\t\theader_up X-Real-IP {remote_host}');

  return `https://${site.domain} {
\timport ncc_security_headers
\timport ncc_body_${target.body}
\timport cors_response
\treverse_proxy ${target.dial}${headers.length ? ` {\n${headers.join('\n')}\n\t}` : ''}
\tlog {
\t\toutput stdout
\t}
}`;
}

function renderSearch(site) {
  const { target } = site;
  const proxy = (dial) => target.host
    ? `reverse_proxy ${dial} {\n\t\t\theader_up Host ${target.host}\n\t\t}`
    : `reverse_proxy ${dial}`;
  return `https://${site.domain} {
\timport ncc_security_headers
\timport ncc_body_${target.body}
\thandle /search* {
\t\t${proxy(target.api)}
\t}
\thandle /status* {
\t\t${proxy(target.api)}
\t}
\thandle {
\t\timport cors_response
\t\t${proxy(target.ui)}
\t}
\tlog {
\t\toutput stdout
\t}
}`;
}

function renderStatic(site, operatorPubkey) {
  return `https://${site.domain} {
\timport ncc_security_headers
\timport ncc_body_${site.target.body}
\timport cors_response
\thandle /ncc-config.json {
\t\theader Content-Type "application/json"
\t\theader Cache-Control "no-store"
\t\trespond \`{"pubkey":"${operatorPubkey}","panelApi":"https://${site.domain}/ncc-api"}\`
\t}
\thandle /ncc-api/public/visibility {
\t\treverse_proxy 127.0.0.1:3000
\t}
\thandle {
\t\troot * /srv/ncc-server/public
\t\tencode gzip
\t\ttry_files {path} /index.html
\t\tfile_server
\t}
\tlog {
\t\toutput stdout
\t}
}`;
}

function renderAdmin(site, operatorPubkey) {
  return `https://${site.domain} {
\timport ncc_security_headers
\timport ncc_body_${site.target.body}
\timport cors_response
\thandle /ncc-config.json {
\t\theader Content-Type "application/json"
\t\theader Cache-Control "no-store"
\t\trespond \`{"pubkey":"${operatorPubkey}","panelApi":"https://${site.domain}/ncc-api"}\`
\t}
\timport ncc_admin_api
\troot * /srv/ncc-server/admin-panel
\tencode gzip
\thandle_path /admin-static/* {
\t\tfile_server
\t}
\thandle / {
\t\theader Content-Type "text/html; charset=utf-8"
\t\trespond \`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=/admin"><title>NCC Server Admin Panel</title></head><body><p><a href="/admin">Open the NCC Server Admin Panel</a></p></body></html>\`
\t}
\thandle {
\t\ttry_files {path} /index.html
\t\tfile_server
\t}
\tlog {
\t\toutput stdout
\t}
}`;
}

/**
 * Render the complete generated fragment. An empty site list still produces a
 * comment-only file so the path is predictable and easy to inspect.
 */
export function renderCaddySites(input) {
  const { operatorPubkey, sites } = normalizeCaddySites(input);
  const blocks = [
    '# Generated by the NCC admin panel node-agent. Do not edit by hand.',
    '# These are optional public HTTPS front doors. NCC addresses are unchanged.',
  ];

  for (const site of sites) {
    if (site.target.kind === 'proxy') blocks.push(renderProxy(site));
    else if (site.target.kind === 'search') blocks.push(renderSearch(site));
    else if (site.target.kind === 'static') blocks.push(renderStatic(site, operatorPubkey));
    else blocks.push(renderAdmin(site, operatorPubkey));

    blocks.push(renderHttpRedirect(site.domain));
  }

  return `${blocks.join('\n\n')}\n`;
}
