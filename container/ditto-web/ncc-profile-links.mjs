import { readFile, writeFile } from 'node:fs/promises';

const [
  externalLinksPath,
  profilePagePath,
  profileSettingsPath,
  editProfileFormPath,
  profileCardPath,
] = process.argv.slice(2);

for (const [name, path] of [
  ['ExternalIdentityLinks.tsx', externalLinksPath],
  ['ProfilePage.tsx', profilePagePath],
  ['ProfileSettings.tsx', profileSettingsPath],
  ['EditProfileForm.tsx', editProfileFormPath],
  ['ProfileCard.tsx', profileCardPath],
]) {
  if (!path) throw new Error(`Pass the Ditto ${name} path.`);
}

function replaceOnce(source, before, after, description) {
  const first = source.indexOf(before);
  if (first === -1 || source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`Could not uniquely locate ${description}.`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

async function patch(path, edits) {
  let source = await readFile(path, 'utf8');
  for (const [before, after, description] of edits) {
    source = replaceOnce(source, before, after, description);
  }
  await writeFile(path, source);
}

const websitePlaceholder =
  '{intl.formatMessage({ id: \'settings.profile.fields.websitePlaceholder\', defaultMessage: "https://example.com, ncc://npub…/service, or nsite://npub…" })}';

await patch(externalLinksPath, [
  [
    `import { Globe, Link2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useIntl } from 'react-intl';

import { ExternalFavicon } from '@/components/ExternalFavicon';
import { EXTERNAL_IDENTITY_PLATFORM_NAMES, type ExternalIdentity } from '@/lib/externalIdentities';
import { cn } from '@/lib/utils';`,
    `import { Globe, Link2 } from 'lucide-react';
import { useMemo, type MouseEvent, type ReactNode } from 'react';
import { useIntl } from 'react-intl';
import { useNavigate } from 'react-router-dom';

import { ExternalFavicon } from '@/components/ExternalFavicon';
import { EXTERNAL_IDENTITY_PLATFORM_NAMES, type ExternalIdentity } from '@/lib/externalIdentities';
import { parseProfileWebsite } from '@/lib/nccProfileLink';
import { cn } from '@/lib/utils';`,
    'the ExternalIdentityLinks imports',
  ],
  [
    `  /** Sanitized website URL from the profile's kind 0, listed first. */`,
    `  /** Raw website value from the profile's kind 0, listed first. */`,
    'the website prop comment',
  ],
  [
    `export function ExternalIdentityLinks({ identities, website, className }: ExternalIdentityLinksProps) {
  const intl = useIntl();

  if (identities.length === 0 && !website) return null;`,
    `export function ExternalIdentityLinks({ identities, website, className }: ExternalIdentityLinksProps) {
  const intl = useIntl();
  const navigate = useNavigate();
  const websiteLink = useMemo(() => parseProfileWebsite(website), [website]);
  // NCC Browser handles nsite:// itself, including deep paths; snapshots stay
  // in Ditto's viewer because ncc-browser cannot parse that nsite form. In an
  // ordinary https page Ditto opens its own nsite viewer for the site root.
  const nativeNcc = window.location.protocol === 'ncc:' && websiteLink?.nativeNcc !== false;

  if (identities.length === 0 && !websiteLink) return null;`,
    'the ExternalIdentityLinks function header',
  ],
  [
    `      {website && (
        <ProfileLink
          url={website}
          label={website.replace(/^https?:\\/\\//, '').replace(/\\/$/, '')}
          fallback={<Globe className="size-3.5" aria-hidden />}
        />
      )}`,
    `      {websiteLink && (
        <ProfileLink
          url={websiteLink.kind === 'nsite' && !nativeNcc
            ? websiteLink.route ?? websiteLink.href
            : websiteLink.href}
          label={websiteLink.label}
          title={websiteLink.title}
          faviconUrl={websiteLink.faviconUrl}
          onClick={
            websiteLink.kind === 'nsite' && !nativeNcc
              ? (event) => {
                  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault();
                  navigate(websiteLink.route ?? websiteLink.href, {
                    state: { nsiteAutoPlay: true, nsiteAutoPlayTs: Date.now() },
                  });
                }
              : undefined
          }
          fallback={<Globe className="size-3.5" aria-hidden />}
        />
      )}`,
    'the profile website link',
  ],
  [
    `interface ProfileLinkProps {
  url: string;
  label: string;
  title?: string;
  fallback: ReactNode;
}

function ProfileLink({ url, label, title, fallback }: ProfileLinkProps) {
  return (`,
    `interface ProfileLinkProps {
  url: string;
  label: string;
  title?: string;
  /** \`null\` disables the favicon lookup; omitted means use \`url\`. */
  faviconUrl?: string | null;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  fallback: ReactNode;
}

function ProfileLink({ url, label, title, faviconUrl, onClick, fallback }: ProfileLinkProps) {
  const iconUrl = faviconUrl === null ? undefined : faviconUrl ?? url;

  return (`,
    'the ProfileLink props and signature',
  ],
  [
    `        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title={title}`,
    `        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title={title}
        onClick={onClick}`,
    'the ProfileLink anchor',
  ],
  [
    `        <ExternalFavicon url={url} size={14} className="shrink-0" fallback={fallback} />`,
    `        <ExternalFavicon url={iconUrl} size={14} className="shrink-0" fallback={fallback} />`,
    'the ProfileLink favicon',
  ],
]);

await patch(profilePagePath, [
  [
    `                website={metadata?.website
                  ? sanitizeUrl(metadata.website.startsWith('http') ? metadata.website : \`https://\${metadata.website}\`)
                  : undefined}`,
    `                website={metadata?.website}`,
    'the profile website value',
  ],
]);

await patch(profileSettingsPath, [
  [
    `                    <Input placeholder="https://yourwebsite.com" {...field} className="h-9" />`,
    `                    <Input placeholder=${websitePlaceholder} {...field} className="h-9" />`,
    'the ProfileSettings website placeholder',
  ],
]);

await patch(editProfileFormPath, [
  [
    `                      <Input placeholder="https://yourwebsite.com" {...field} className="h-9" />`,
    `                      <Input placeholder=${websitePlaceholder} {...field} className="h-9" />`,
    'the EditProfileForm website placeholder',
  ],
  [
    `                      <FormattedMessage id="editProfile.website.description" defaultMessage={"Your personal website or social link"} />`,
    `                      <FormattedMessage id="editProfile.website.description" defaultMessage={"Your website, an ncc:// service, or an nsite:// site"} />`,
    'the EditProfileForm website description',
  ],
]);

await patch(profileCardPath, [
  [
    `                  placeholder="https://yourwebsite.com"`,
    `                  placeholder=${websitePlaceholder}`,
    'the ProfileCard website placeholder',
  ],
]);
