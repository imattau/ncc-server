import { useEffect, useState } from 'react';
import { useSeoMeta } from '@unhead/react';
import { ArrowDownRight, ArrowUpRight, Globe2, LockKeyhole, Radio, Search, Server, ShieldCheck, Waves } from 'lucide-react';

const services = [
  {
    id: 'web',
    number: '01',
    name: 'Web',
    type: 'THIS SITE',
    description: 'A home on the open web, served directly from this community node.',
    icon: Globe2,
    theme: 'mint',
  },
  {
    id: 'relay',
    number: '02',
    name: 'Nostr Relay',
    type: 'PUBLIC · READ & WRITE',
    description: 'A place for Nostr clients to publish and discover community events.',
    icon: Radio,
    theme: 'peach',
  },
  {
    id: 'ditto',
    number: '03',
    name: 'Ditto',
    type: 'SOCIAL',
    description: 'Join the conversation with a community-powered social interface.',
    icon: Waves,
    theme: 'blue',
  },
  {
    id: 'search',
    number: '04',
    name: 'NCC Search',
    type: 'PUBLIC DIRECTORY',
    description: 'Find services and public content across the NCC network.',
    icon: Search,
    theme: 'lilac',
    optional: true,
  },
  {
    id: 'npanel',
    number: '05',
    name: 'Npanel',
    type: 'ADMINISTRATION',
    description: 'Browse and manage the nsites hosted on this node. Administrator access is required.',
    icon: Server,
    theme: 'gold',
    restricted: true,
  },
  {
    id: 'admin',
    number: '06',
    name: 'Admin Panel',
    type: 'ADMINISTRATION',
    description: 'Manage this node, its services and operator access. Administrator access is required.',
    icon: ShieldCheck,
    theme: 'sage',
    restricted: true,
  },
];

const serviceHref = (id: string, rootNpub: string | null) => {
  if (rootNpub) return `ncc://${rootNpub}/${id === 'web' ? '' : `${id}/`}`;
  // The admin panel is also reachable on the loopback listener, where
  // /ncc-config.json is absent and no npub is available for an ncc:// link.
  return id === 'admin' ? '/admin' : undefined;
};

const Index = () => {
  const [rootNpub, setRootNpub] = useState<string | null>(null);
  const [identityState, setIdentityState] = useState<'loading' | 'ready' | 'missing'>('loading');

  useSeoMeta({
    title: 'NCC Server — A home on the open web',
    description: 'Explore the public services on this NCC community node, built on open protocols and owned by its community.',
  });

  useEffect(() => {
    const controller = new AbortController();
    fetch('/ncc-config.json', { cache: 'no-store', signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('NCC server config unavailable');
        return response.json() as Promise<{ npub?: unknown }>;
      })
      .then((config) => {
        if (typeof config.npub === 'string' && /^npub1[0-9a-z]{20,}$/i.test(config.npub)) {
          setRootNpub(config.npub);
          setIdentityState('ready');
          return;
        }
        setIdentityState('missing');
      })
      .catch(() => {
        if (!controller.signal.aborted) setIdentityState('missing');
      });
    return () => controller.abort();
  }, []);

  return (
    <main className="welcome-page min-h-screen overflow-hidden text-[#18211d]">
      <div className="welcome-wrap mx-auto max-w-[1240px] px-5 sm:px-9 lg:px-14">
        <header className="flex items-center justify-between border-b border-[#18211d]/15 py-6">
          <a href="#top" className="flex items-center gap-3" aria-label="NCC Server home">
            <span className="brand-mark grid size-10 place-items-center rounded-full bg-[#d9f27e] text-[#18211d]"><Globe2 size={20} strokeWidth={1.8} /></span>
            <span className="font-mono text-xs font-semibold tracking-[0.14em] sm:text-sm">NCC <span className="text-[#819b4b]">/</span> SERVER</span>
          </a>
          <a href="#services" className="group flex items-center gap-2 rounded-full border border-[#18211d]/20 px-4 py-2.5 text-xs font-semibold transition-colors hover:bg-[#18211d] hover:text-[#f6f6ef] sm:text-sm">
            Explore services <ArrowDownRight size={15} className="transition-transform group-hover:translate-y-0.5" />
          </a>
        </header>

        <section id="top" className="hero-grid relative grid gap-9 pb-16 pt-14 sm:pb-20 sm:pt-20 md:grid-cols-[1.25fr_0.75fr] md:items-end lg:pb-24 lg:pt-28">
          <div className="hero-art pointer-events-none absolute right-[3%] top-[12%] hidden h-[315px] w-[315px] md:block" aria-hidden="true">
            <div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="orbit orbit-three" />
            <div className="orbit-core"><span>N</span></div>
            <span className="orbit-dot dot-one" /><span className="orbit-dot dot-two" /><span className="orbit-dot dot-three" />
          </div>
          <div className="relative z-10">
            <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-[#18211d]/15 bg-white/40 px-3.5 py-2 text-[10px] font-semibold tracking-[0.18em] text-[#596351] sm:text-xs">
              <span className="size-2 rounded-full bg-[#91b64c]" /> A COMMUNITY NODE ON NOSTR
            </div>
            <h1 className="max-w-[780px] font-serif text-[clamp(3.4rem,9vw,7.6rem)] leading-[0.92] tracking-[-0.065em]">
              The web works<br />better <span className="hero-italic">together.</span>
            </h1>
            <p className="mt-7 max-w-[520px] text-base leading-7 text-[#59635e] sm:text-lg sm:leading-8">
              Welcome to this corner of the open web. Explore independent services, connected by Nostr and run for the community.
            </p>
          </div>
          <div className="relative z-10 max-w-[330px] md:ml-auto md:mb-1">
            <div className="mb-4 flex items-center gap-2 font-mono text-[10px] font-semibold tracking-[0.16em] text-[#68746c] sm:text-xs">
              <span className="size-1.5 rounded-full bg-[#91b64c]" /> OPEN PROTOCOLS, COMMUNITY RUN
            </div>
            <p className="text-sm leading-6 text-[#69736d] sm:text-base sm:leading-7">No single company in the middle. Your identity stays yours, and each service can be used from NCC Browser.</p>
            <a href="#services" className="mt-6 inline-flex items-center gap-2 text-sm font-semibold underline decoration-[#95ad65] decoration-2 underline-offset-4 hover:text-[#708a3c]">
              Find your way around <ArrowDownRight size={16} />
            </a>
          </div>
        </section>

        <section id="services" className="services-section border-t border-[#18211d]/15 pb-16 pt-8 sm:pb-24 sm:pt-11">
          <div className="mb-7 flex flex-wrap items-end justify-between gap-4 sm:mb-9">
            <div>
              <p className="mb-2 font-mono text-[10px] font-semibold tracking-[0.2em] text-[#75816d] sm:text-xs">THE NEIGHBOURHOOD</p>
              <h2 className="font-serif text-3xl tracking-[-0.04em] sm:text-4xl">What’s here</h2>
            </div>
            <span className="pb-1 text-xs text-[#788078] sm:text-sm">
              {identityState === 'ready' ? 'Choose a service to open it in NCC Browser' : identityState === 'loading' ? 'Preparing NCC links…' : 'Service links are temporarily unavailable.'}
            </span>
          </div>

          <div className="service-grid grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {services.map(({ id, number, name, type, description, icon: Icon, theme, optional, restricted }) => (
              <a
                key={id}
                href={serviceHref(id, rootNpub)}
                aria-disabled={!rootNpub && id !== 'admin'}
                className={`service-card service-${theme} group relative flex min-h-[225px] flex-col justify-between rounded-[20px] border border-[#18211d]/10 p-5 transition duration-300 hover:-translate-y-1 hover:shadow-[0_16px_40px_rgba(26,39,28,0.10)] aria-disabled:cursor-wait aria-disabled:opacity-60 aria-disabled:hover:translate-y-0 aria-disabled:hover:shadow-none sm:min-h-[244px] sm:p-6`}
                aria-label={`Open ${name} in NCC Browser${restricted ? ' (administrator access required)' : ''}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="service-icon grid size-11 place-items-center rounded-[14px] bg-white/65"><Icon size={20} strokeWidth={1.7} /></span>
                  <div className="flex items-center gap-2">
                    {optional && <span className="rounded-full border border-current/15 px-2 py-1 text-[9px] font-semibold tracking-[0.12em] opacity-70">OPTIONAL</span>}
                    {restricted && <span className="rounded-full border border-current/15 px-2 py-1 text-[9px] font-semibold tracking-[0.12em] opacity-70">ADMIN</span>}
                    <span className="font-mono text-[10px] opacity-50">{number}</span>
                  </div>
                </div>
                <div>
                  <p className="mb-2 font-mono text-[9px] font-semibold tracking-[0.16em] opacity-60 sm:text-[10px]">{type}</p>
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="font-serif text-2xl tracking-[-0.035em] sm:text-[1.7rem]">{name}</h3>
                    <span className="grid size-9 shrink-0 place-items-center rounded-full border border-current/15 transition group-hover:border-[#18211d]/40 group-hover:bg-[#18211d] group-hover:text-[#f7f7f0]"><ArrowUpRight size={17} /></span>
                  </div>
                  <p className="mt-2 max-w-[310px] text-xs leading-5 opacity-70 sm:text-sm sm:leading-6">{description}</p>
                </div>
              </a>
            ))}
          </div>

          <div className="mt-4 flex items-start gap-3 rounded-2xl border border-[#18211d]/10 bg-white/45 px-4 py-4 text-xs leading-5 text-[#69736d] sm:items-center sm:px-5 sm:text-sm">
            <LockKeyhole size={16} className="mt-0.5 shrink-0 text-[#75884e] sm:mt-0" />
            <p><span className="font-semibold text-[#364039]">Private by design.</span> Npanel and the Admin Panel are visible in the directory, but managing this node requires an operator identity.</p>
          </div>
          <p className="mt-4 text-[11px] leading-5 text-[#858c82]">NCC Search is an optional service and may not be enabled on every installation.</p>
        </section>

        <footer className="flex flex-col gap-4 border-t border-[#18211d]/15 py-6 text-xs text-[#737c73] sm:flex-row sm:items-center sm:justify-between sm:py-7">
          <div className="flex items-center gap-2"><span className="grid size-7 place-items-center rounded-full bg-[#d9f27e]"><Globe2 size={14} /></span><span>Independent services, connected by Nostr.</span></div>
          <a href="https://github.com/imattau/ncc-server" target="_blank" rel="noreferrer" className="group inline-flex w-fit items-center gap-1.5 font-medium text-[#49544b] hover:text-[#718c3d]">Explore the project <ArrowUpRight size={13} className="transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" /></a>
        </footer>
      </div>
    </main>
  );
};

export default Index;
