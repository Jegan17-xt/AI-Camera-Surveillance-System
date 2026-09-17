import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import axios from "axios";
import {
  ArrowRight,
  BarChart3,
  Bell,
  Bird,
  Camera,
  Check,
  ChevronDown,
  Cloud,
  Cpu,
  Eye,
  Flame,
  LayoutGrid,
  LifeBuoy,
  Loader2,
  Mail,
  MapPin,
  Menu,
  MessageSquare,
  Moon,
  Phone,
  Radar,
  Scan,
  Server,
  ShieldCheck,
  Truck,
  Users,
  Video,
  X,
  Zap,
} from "lucide-react";
import { API_BASE_URL } from "../lib/apiBase";
import { getBrowserLocation } from "../lib/geolocation";

/* ============================================================
   Zynez — public marketing / landing page.

   Zynez is the brand/product name. "AI Camera Surveillance" is only
   ever used here as a description of what Zynez provides, never as the
   brand. Nothing on this page touches the Admin / Company Admin / User /
   Super Admin apps — it is a standalone public route ("/") that links
   into the existing login flow. Pricing is fetched live from the backend
   (GET /public/pricing → the same catalog the Super Admin configures);
   no price is ever hardcoded here.
   ============================================================ */

const BRAND = "Zynez";
const LOGO_SRC = "/70809498-2132-47b6-8216-785890a4f833.png";
const LOGIN_PATH = "/user/login";

const NAV_LINKS = [
  { label: "AI Detection", href: "#detection" },
  { label: "How It Works", href: "#how-it-works" },
  { label: "Pricing", href: "#pricing" },
  { label: "Contact", href: "#contact" },
];

const TECH_STRIP = [
  "REAL-TIME AI",
  "COMPUTER VISION",
  "FACE RECOGNITION",
  "SMART DETECTION",
  "LIVE MONITORING",
  "AUTOMATED ALERTS",
  "EDGE-TO-CLOUD",
];

const STEPS = [
  { n: "01", title: "CONNECT", icon: Camera, text: "Connect your existing IP cameras and site gateways." },
  { n: "02", title: "DETECT", icon: Radar, text: "Zynez analyses every live stream frame by frame." },
  { n: "03", title: "UNDERSTAND", icon: Cpu, text: "People, vehicles, animals, birds, fire and smoke are identified." },
  { n: "04", title: "RESPOND", icon: Bell, text: "Events, snapshots and alerts are created automatically." },
  { n: "05", title: "ANALYZE", icon: BarChart3, text: "Review reports and security analytics on the dashboard." },
];

const PACKAGE_ICON = {
  cameras: Video,
  people: Users,
  security: ShieldCheck,
  reports: BarChart3,
};

const ADDON_ICON = {
  "Camera / Hardware": Camera,
  Storage: Cloud,
  "Hosting / Infrastructure": Server,
  "Notifications / Communication": MessageSquare,
};

const inr = (value) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));

const unitSuffix = (unitType) =>
  unitType === "per_camera" ? " / camera" : unitType === "per_gb" ? " / GB" : "";

/* --- scroll-reveal: progressive enhancement, always fails safe ---
   Content renders visible. Only when IntersectionObserver exists do we
   arm the hidden start state (data-anim="on") and animate elements in as
   they enter the viewport. A failsafe timer force-reveals everything
   after 3.5s, and any hash navigation reveals everything immediately —
   so a section is never left invisible after an anchor jump or a
   restored scroll position.

   A MutationObserver also watches for .zx-reveal elements that mount
   AFTER this effect's initial sweep — PricingSection's real content
   (the package cards, the add-ons grid) only renders once its
   GET /public/pricing fetch resolves, strictly after this effect has
   already run once on mount, so without this those elements were never
   handed to the IntersectionObserver above: the CSS still hid them
   ([data-anim="on"] applies to any .zx-reveal, however late it
   arrives), but nothing was watching them, so scrolling to Pricing
   normally could never reveal it — only a hash navigation (e.g.
   clicking the navbar's "Pricing" link) or the one-shot failsafe
   catching it in time ever did. Any content that mounts late now gets
   observed the moment it appears, so it reveals on normal scroll just
   like every statically-present section. */
function useReveal() {
  const ref = useRef(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;

    const showAll = () =>
      root.querySelectorAll(".zx-reveal:not([data-shown='true'])").forEach((el) =>
        el.setAttribute("data-shown", "true"),
      );

    if (!("IntersectionObserver" in window)) return; // everything stays visible

    root.setAttribute("data-anim", "on");

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.setAttribute("data-shown", "true");
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.05, rootMargin: "0px 0px 240px 0px" },
    );
    root.querySelectorAll(".zx-reveal").forEach((el) => io.observe(el));

    const observeNew = (node) => {
      if (node.nodeType !== 1) return;
      if (node.matches?.(".zx-reveal")) io.observe(node);
      node.querySelectorAll?.(".zx-reveal").forEach((el) => io.observe(el));
    };

    const mo = new MutationObserver((mutations) => {
      mutations.forEach((m) => m.addedNodes.forEach(observeNew));
    });
    mo.observe(root, { childList: true, subtree: true });

    const failsafe = window.setTimeout(showAll, 3500);
    window.addEventListener("hashchange", showAll);

    return () => {
      io.disconnect();
      mo.disconnect();
      window.clearTimeout(failsafe);
      window.removeEventListener("hashchange", showAll);
    };
  }, []);
  return ref;
}

function useScrolled(offset = 12) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > offset);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [offset]);
  return scrolled;
}

/* animated integer counter, runs once when scrolled into view */
function Counter({ to, suffix = "", duration = 1400 }) {
  const [val, setVal] = useState(0);
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    let started = false;
    const run = (ts) => {
      if (!started) started = ts;
      const p = Math.min((ts - started) / duration, 1);
      setVal(Math.round((1 - Math.pow(1 - p, 3)) * to));
      if (p < 1) raf = requestAnimationFrame(run);
    };
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          raf = requestAnimationFrame(run);
          io.disconnect();
        }
      },
      { threshold: 0.5 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [to, duration]);
  return (
    <span ref={ref}>
      {val}
      {suffix}
    </span>
  );
}

/* ---------- brand logo ----------
   The supplied Zynez image is used verbatim (never a text substitute,
   never re-generated, source file untouched). The asset ships on a near-
   black ground; `zx-logo` applies `mix-blend-mode: screen` so that dark
   ground drops out against the dark page — the logo reads as if it were
   transparent, with no box drawn behind it. Only a height is set so the
   original square proportions are always preserved; `w-auto` + a bigger
   height keeps it crisp when the source is downscaled. */
function Logo({ className = "h-12 w-auto sm:h-14", src, alt }) {
  // A Super-Admin-uploaded logo (Website Settings > General > Logo) is an
  // arbitrary image with no guaranteed near-black ground, so `zx-logo`'s
  // mix-blend-mode:screen trick — built specifically for the bundled
  // asset above — is skipped for it; only the bundled default gets it.
  const isCustom = Boolean(src);
  return (
    <img
      src={src || LOGO_SRC}
      alt={alt || `${BRAND} — AI Camera Surveillance`}
      className={`${isCustom ? "" : "zx-logo"} ${className} block shrink-0 select-none object-contain`}
      draggable={false}
    />
  );
}

/* ---------- primitives ---------- */
function PrimaryCta({ to = LOGIN_PATH, children, className = "" }) {
  return (
    <Link
      to={to}
      className={`zx-cta zx-cta-primary inline-flex items-center justify-center gap-2 rounded-full bg-gradient-to-r from-accent-cyan to-accent-blue px-6 py-3 text-sm font-semibold text-base-950 ${className}`}
    >
      {children}
      <ArrowRight size={16} />
    </Link>
  );
}

function GhostCta({ to = LOGIN_PATH, children, className = "", onClick }) {
  return (
    <Link
      to={to}
      onClick={onClick}
      className={`zx-cta inline-flex items-center justify-center gap-2 rounded-full border border-white/15 bg-white/[0.02] px-6 py-3 text-sm font-semibold text-ink-100 hover:border-accent-cyan/50 hover:text-white ${className}`}
    >
      {children}
    </Link>
  );
}

/* Smooth-scrolls to an in-page section by id — same "reveal anything
   still pending first, then scrollIntoView, respecting reduced-motion"
   approach ContactCta below already uses for #contact, factored out so
   the navbar's "Pricing" link can reuse it: a plain href="#pricing"
   anchor jumps instantly (no scroll-behavior:smooth is set anywhere on
   this page) and, worse, could still land on a section whose height is
   mid-transition from the scroll-reveal fade-in — revealing first
   avoids that. */
function scrollToSection(id, e) {
  const el = document.getElementById(id);
  if (!el) return;
  e.preventDefault();
  document
    .querySelectorAll(".zx-reveal:not([data-shown='true'])")
    .forEach((n) => n.setAttribute("data-shown", "true"));
  const reduce =
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  requestAnimationFrame(() => el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" }));
}

/* Header CTA — smooth-scrolls to the Contact section (the add-ons block
   carries id="contact"). Plain in-page anchor, no route change. */
function ContactCta({ className = "", onClick }) {
  const go = (e) => {
    const el = document.getElementById("contact");
    if (el) {
      e.preventDefault();
      // reveal everything first so no scroll-reveal transition shifts the
      // page height mid-scroll and lands us short of the section
      document
        .querySelectorAll(".zx-reveal:not([data-shown='true'])")
        .forEach((n) => n.setAttribute("data-shown", "true"));
      const reduce =
        typeof window !== "undefined" &&
        window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      requestAnimationFrame(() =>
        el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" }),
      );
    }
    onClick?.();
  };
  return (
    <a
      href="#contact"
      onClick={go}
      className={`zx-cta zx-cta-primary inline-flex items-center justify-center gap-2 rounded-full bg-gradient-to-r from-accent-cyan to-accent-blue px-6 py-3 text-sm font-semibold text-base-950 ${className}`}
    >
      Contact Us
      <ArrowRight size={16} />
    </a>
  );
}

/* Renders a Website Settings text field that may contain literal "\n"
   line breaks (typed by the Super Admin, via Website Settings' Heading
   textarea) as real <br/> breaks — used for every CMS-sourced heading
   below. With `highlightAfterFirst`, every line after the first gets the
   same cyan-to-blue gradient treatment the original hardcoded 2-line
   headings ("Now Think.", "Miss nothing") used — so a heading with no
   manual break stays a single plain-white line, and adding one line
   break restores that same accent look on whatever now follows it. */
function MultilineText({ text, highlightAfterFirst = false }) {
  const lines = String(text ?? "").split("\n");
  return lines.map((line, i) => (
    <Fragment key={i}>
      {highlightAfterFirst && i > 0 ? (
        <span className="bg-gradient-to-r from-accent-cyan via-accent-blue to-accent-cyan bg-clip-text text-transparent">
          {line}
        </span>
      ) : (
        line
      )}
      {i < lines.length - 1 && <br />}
    </Fragment>
  ));
}

function SectionKicker({ children }) {
  return (
    <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 font-mono text-[11px] uppercase tracking-[0.22em] text-accent-cyan">
      <span className="h-1.5 w-1.5 rounded-full bg-accent-cyan zx-dot-pulse" />
      {children}
    </div>
  );
}

/* ---------- header ---------- */
function Header({ content }) {
  const scrolled = useScrolled();
  const [open, setOpen] = useState(false);
  const websiteName = content?.general?.website_name || BRAND;
  const logoUrl = content?.general?.logo_url;

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <header className="zx-glass-nav fixed inset-x-0 top-0 z-50" data-scrolled={scrolled}>
      <div className="relative z-[60] mx-auto flex max-w-7xl items-center justify-between px-5 py-3 sm:px-8">
        <a href="#top" className="flex items-center" aria-label={`${websiteName} home`} onClick={() => setOpen(false)}>
          <Logo src={logoUrl} alt={`${websiteName} — AI Camera Surveillance`} />
        </a>

        <nav className="hidden items-center gap-8 lg:flex">
          {NAV_LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              onClick={l.href === "#pricing" ? (e) => scrollToSection("pricing", e) : undefined}
              className="text-sm font-medium text-ink-300 transition-colors hover:text-white"
            >
              {l.label}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-3 lg:flex">
          <Link
            to={LOGIN_PATH}
            className="text-sm font-semibold text-ink-200 transition-colors hover:text-white"
          >
            Login
          </Link>
          <ContactCta className="!px-5 !py-2.5" />
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="rounded-lg border border-white/10 bg-white/[0.03] p-2 text-ink-100 lg:hidden"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
        >
          {open ? <X size={20} /> : <Menu size={20} />}
        </button>
      </div>

      {/* full-screen mobile navigation — sits BELOW the nav row (z-[60])
          so the hamburger/close button stays clickable */}
      <div
        className={`fixed inset-0 top-0 z-40 flex flex-col overflow-y-auto bg-[#05070d] px-6 pb-10 pt-24 transition-opacity duration-300 lg:hidden ${
          open ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        <nav className="flex flex-col divide-y divide-white/8 border-y border-white/8">
          {NAV_LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              onClick={(e) => {
                setOpen(false);
                if (l.href === "#pricing") scrollToSection("pricing", e);
              }}
              className="flex items-center justify-between py-4 text-lg font-medium text-ink-100"
            >
              {l.label}
              <ArrowRight size={16} className="text-ink-500" />
            </a>
          ))}
        </nav>
        <div className="mt-8 flex flex-col gap-3">
          <GhostCta className="w-full !py-3.5" onClick={() => setOpen(false)}>
            Login
          </GhostCta>
          <ContactCta className="w-full !py-3.5" onClick={() => setOpen(false)} />
        </div>
        <p className="mt-auto pt-8 text-center font-mono text-[11px] uppercase tracking-[0.2em] text-ink-600">
          {websiteName} · AI Camera Surveillance
        </p>
      </div>
    </header>
  );
}

function Hero({ content }) {
  const hero = content?.hero;
  return (
    <section id="top" className="relative px-5 pb-16 pt-32 sm:px-8 sm:pt-40">
      <div className="pointer-events-none absolute inset-0 zx-grid" aria-hidden />
      {/* minmax(0,...) — not a bare 1.05fr/1fr — so this column can shrink
          below its content's natural width and let a long Website
          Settings heading wrap instead of overflowing (Tailwind's own
          grid-cols-N utilities get this minmax(0,...) floor for free;
          this arbitrary two-value track needs it spelled out). */}
      <div className="relative mx-auto grid max-w-7xl items-center gap-12 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
        <div>
          <SectionKicker>AI-Powered Security</SectionKicker>
          <h1 className="break-words font-display text-5xl font-semibold leading-[0.98] tracking-tight text-white zx-glow-text sm:text-6xl md:text-7xl">
            {hero ? (
              <MultilineText text={hero.heading} highlightAfterFirst />
            ) : (
              <>
                Your Cameras.
                <br />
                <span className="bg-gradient-to-r from-accent-cyan via-accent-blue to-accent-cyan bg-clip-text text-transparent">
                  Now Think.
                </span>
              </>
            )}
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-300">
            {hero?.description ||
              `${BRAND} is an AI-powered camera surveillance platform that detects, understands and responds to events in real time.`}
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <PrimaryCta>{hero?.cta_text || `Start with ${BRAND}`}</PrimaryCta>
            <GhostCta to="#detection">Explore AI Detection</GhostCta>
          </div>
          <p className="mt-6 font-mono text-[12px] uppercase tracking-[0.2em] text-ink-500">
            AI-powered · Real-time · Cloud ready
          </p>
        </div>

        <div className="relative">
          <div className="absolute -inset-6 -z-10 rounded-[2rem] bg-accent-cyan/10 blur-3xl" aria-hidden />
          {/* Right-side hero visual — Website Settings' Hero Image when the
              Super Admin has uploaded one, otherwise the supplied still of
              the Zynez AI camera feed (person / vehicle / animal / fire
              detection + HUD are baked into the image), at its native
              1672×941 ratio: full width, height auto, never crops/
              stretches/overflows. */}
          <img
            src={hero?.image_url || "/5ab36bf3-0510-4a78-b2b2-4ca21402643e.png"}
            alt={`${BRAND} AI camera — live surveillance feed detecting a person, vehicle, animal and fire`}
            width={1672}
            height={941}
            loading="eager"
            decoding="async"
            className="zx-hero-img block h-auto w-full select-none"
          />
          <div className="mt-4 grid grid-cols-3 gap-3">
            {[
              { k: "Detections / day", v: 40000, s: "+" },
              { k: "Event types", v: 6, s: "" },
              { k: "Cameras / tenant", v: 100, s: "+" },
            ].map((m) => (
              <div key={m.k} className="zx-card rounded-xl px-3 py-3 text-center">
                <p className="font-display text-xl font-semibold text-white">
                  <Counter to={m.v} suffix={m.s} />
                </p>
                <p className="mt-0.5 text-[11px] leading-tight text-ink-400">{m.k}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------- tech strip ---------- */
function TechStrip() {
  const row = [...TECH_STRIP, ...TECH_STRIP];
  return (
    <section className="border-y border-white/8 bg-white/[0.015] py-5">
      <div className="relative overflow-hidden [mask-image:linear-gradient(90deg,transparent,#000_12%,#000_88%,transparent)]">
        <div className="zx-marquee">
          {row.map((t, i) => (
            <span
              key={`${t}-${i}`}
              className="zx-marquee-text mx-7 flex items-center gap-3 font-mono text-[12px] font-semibold uppercase tracking-[0.22em]"
            >
              <span className="zx-marquee-dot h-1 w-1 shrink-0 rounded-full" />
              {t}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------- AI Detection — single-screen AI Command Center ---------- */

/* Live event feed shown on the left. The list is doubled in the JSX and
   the track scrolls -50% on a loop, so it reads as a continuous real-time
   stream with no JS timers. `steps` render as an arrowed action chain. */
const CC_EVENTS = [
  { id: "person", icon: Users, c: "#22d3ee", t: "19:55:58", label: "Person Detected" },
  {
    id: "unknown",
    icon: Eye,
    c: "#fb4d5e",
    t: "19:56:04",
    label: "Unknown Person",
    steps: ["Snapshot Saved", "WhatsApp Alert Sent"],
  },
  { id: "vehicle", icon: Truck, c: "#3b82f6", t: "19:56:12", label: "Vehicle Detected" },
  { id: "animal", icon: Bird, c: "#34e89e", t: "19:56:25", label: "Animal / Bird Detected" },
  {
    id: "fire",
    icon: Flame,
    c: "#fbbf24",
    t: "19:56:38",
    label: "Fire / Smoke Detected",
    steps: ["Alert Triggered"],
  },
  { id: "count", icon: BarChart3, c: "#a855f7", t: "19:56:50", label: "People Counting", steps: ["12 in frame"] },
  { id: "night", icon: Moon, c: "#7dd3fc", t: "19:57:03", label: "Night Monitoring" },
];

const CC_FEATURES = [
  "Face Recognition",
  "Unknown Person Detection",
  "Vehicle Detection",
  "Animal & Bird Detection",
  "Fire & Smoke Detection",
  "WhatsApp Alerts",
  "Instant Notifications",
  "Automatic Snapshots",
  "Event Recording",
  "People Counting",
  "Night Monitoring",
  "Zone-Based Detection",
  "Smart Device Automation",
];

const CC_FLOW = [
  { k: "Camera", icon: Camera },
  { k: "AI Analysis", icon: Cpu },
  { k: "Detection", icon: Scan },
  { k: "Action", icon: Zap },
];

function CCEventRow({ e }) {
  return (
    <li className="flex items-start gap-3 border-b border-white/5 px-1 py-3">
      <span className="zx-erow-ic mt-px shrink-0" style={{ "--_c": e.c }} aria-hidden>
        <e.icon size={13} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[9px] tabular-nums text-ink-600">{e.t}</span>
          <span className="truncate text-[13px] font-semibold text-white">{e.label}</span>
        </div>
        {e.steps && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1">
            {e.steps.map((s, i) => (
              <span key={s} className="flex items-center gap-1.5">
                {i > 0 && <ArrowRight size={9} className="shrink-0 text-ink-600" />}
                <span className="zx-epill" style={{ "--_c": e.c }}>
                  {s}
                </span>
              </span>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

function DetectionSection({ content }) {
  const ai = content?.ai_detection;
  return (
    <section
      id="detection"
      className="zx-detsec relative overflow-hidden border-y border-white/8 px-5 py-16 sm:px-8 lg:flex lg:min-h-screen lg:flex-col lg:justify-center lg:py-12"
    >
      <div className="pointer-events-none absolute inset-0 zx-mesh opacity-50" aria-hidden />
      <div className="zx-detsec-seam pointer-events-none absolute inset-x-0 top-0 h-44" aria-hidden />
      <div className="relative mx-auto grid w-full max-w-7xl items-center gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-12">
        {/* LEFT — animated live event stream, with an optional Website
            Settings section image as a subtle low-opacity backdrop (only
            shown once the Super Admin uploads one — the section works
            exactly as before when they haven't). */}
        <div className="zx-stream zx-reveal relative overflow-hidden rounded-2xl border border-white/10 bg-[#070b12] p-4 sm:p-5">
          {ai?.image_url && (
            <img
              src={ai.image_url}
              alt=""
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-20"
            />
          )}
          <div className="relative flex items-center justify-between border-b border-white/8 pb-3">
            <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] text-accent-cyan">
              <span className="zx-stream-dot" aria-hidden />
              AI Event Stream
            </span>
            <span className="font-mono text-[10px] uppercase tracking-wider text-ink-500">Live · 30 FPS</span>
          </div>
          <div className="zx-stream-mask mt-2 h-[340px] sm:h-[404px]">
            <div className="zx-stream-scan" aria-hidden />
            <ul className="zx-stream-track">
              {[...CC_EVENTS, ...CC_EVENTS].map((e, i) => (
                <CCEventRow key={`${e.id}-${i}`} e={e} />
              ))}
            </ul>
          </div>
        </div>

        {/* RIGHT — awareness statement, feature grid, pipeline flow */}
        <div className="zx-reveal">
          <SectionKicker>AI Detection</SectionKicker>
          <h2 className="break-words font-display text-3xl font-semibold uppercase leading-[1.04] tracking-tight text-white zx-glow-text sm:text-4xl lg:text-[2.9rem]">
            {ai ? (
              <MultilineText text={ai.heading} highlightAfterFirst />
            ) : (
              <>
                See everything
                <br />
                <span className="bg-gradient-to-r from-accent-cyan via-accent-blue to-accent-cyan bg-clip-text text-transparent">
                  Miss nothing
                </span>
              </>
            )}
          </h2>
          <p className="mt-4 max-w-md text-[15px] leading-relaxed text-ink-300">
            {ai?.description || `${BRAND} detects events, analyzes them and instantly takes action.`}
          </p>
          {ai?.feature_text && (
            <p className="mt-1.5 max-w-md font-mono text-[12px] uppercase tracking-[0.14em] text-accent-cyan">
              {ai.feature_text}
            </p>
          )}

          <ul className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {CC_FEATURES.map((f) => (
              <li
                key={f}
                className="zx-fchip flex items-center gap-2 rounded-lg border border-white/8 bg-white/[0.02] px-2.5 py-2 text-[11px] font-medium leading-tight text-ink-200"
              >
                <span className="h-1 w-1 shrink-0 rounded-full bg-accent-cyan" aria-hidden />
                {f}
              </li>
            ))}
          </ul>

          <div className="mt-7">
            <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.22em] text-ink-500">
              Detection pipeline
            </p>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              {CC_FLOW.map((n, i) => (
                <Fragment key={n.k}>
                  <div className="zx-flow-node sm:flex-none" style={{ "--_i": i }}>
                    <n.icon size={13} />
                    <span>{n.k}</span>
                  </div>
                  {i < CC_FLOW.length - 1 && (
                    <div className="zx-flow-link hidden sm:block" style={{ "--_i": i }} aria-hidden>
                      <span />
                    </div>
                  )}
                </Fragment>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------- unknown-person security ---------- */
function UnknownSection({ content }) {
  const unknown = content?.unknown_person;
  return (
    <section className="px-5 py-24 sm:px-8">
      <div className="mx-auto grid max-w-7xl items-center gap-12 lg:grid-cols-2">
        <div className="zx-reveal">
          <SectionKicker>Unknown Person Security</SectionKicker>
          {unknown?.alert_text && (
            <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-signal-red/30 bg-signal-red/10 px-3 py-1.5 text-xs font-semibold text-signal-red">
              <Eye size={13} />
              {unknown.alert_text}
            </div>
          )}
          <h2 className="break-words font-display text-4xl font-semibold leading-tight text-white sm:text-5xl">
            <MultilineText text={unknown?.heading || "When someone unknown enters, you know instantly."} highlightAfterFirst />
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-ink-300">
            {unknown?.description ||
              `${BRAND} runs face detection on every stream. A face that doesn't match your registered people is captured, stored and turned into an event — with real-time notifications.`}
          </p>
          <ul className="mt-6 grid gap-3 sm:grid-cols-2">
            {[
              "Face detection",
              "Unknown person capture",
              "Snapshot image storage",
              "Full event history",
              "WhatsApp alerts",
              "Real-time in-app notification",
            ].map((f) => (
              <li key={f} className="flex items-center gap-2 text-sm text-ink-200">
                <Check size={15} className="text-signal-green" />
                {f}
              </li>
            ))}
          </ul>
        </div>

        <div className="zx-reveal">
          {/* supplied CCTV still: an AI-detected unknown person (the red
              "UNKNOWN PERSON 99% / ALERT" box + REC/CAM HUD are baked into
              the image). Shown at its native 445×627 ratio inside a rounded
              security-monitoring card — no crop, stretch or overlay. */}
          <img
            src={unknown?.image_url || "/Screenshot%202026-09-01%20111534.png"}
            alt={`${BRAND} AI camera flagging an unknown person at the main entrance`}
            width={445}
            height={627}
            loading="lazy"
            decoding="async"
            className="zx-unk-img mx-auto block h-auto w-full max-w-[440px] select-none"
          />
        </div>
      </div>
    </section>
  );
}

/* ---------- fire & smoke ---------- */
function FireSection({ content }) {
  const fire = content?.fire_detection;
  const flow = ["Detection", "Verification", "Snapshot", "Event", "Alert"];
  return (
    <section className="relative border-y border-white/8 px-5 py-24 sm:px-8">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(40rem_30rem_at_28%_25%,rgba(251,191,36,0.10),transparent_60%)]" aria-hidden />
      <div className="relative mx-auto max-w-7xl">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          {/* LEFT — supplied still: warehouse fire caught by an AI camera;
              the FIRE DETECTED panel + WhatsApp alert are baked into the
              image. Native 3:2 ratio, no crop/stretch/overlay. */}
          <div className="zx-reveal">
            <img
              src={fire?.image_url || "/FireImage.png"}
              alt={`${BRAND} AI camera detecting a warehouse fire and sending a fire alert`}
              width={1536}
              height={1024}
              loading="lazy"
              decoding="async"
              className="zx-fire-img mx-auto block h-auto w-full max-w-[640px] select-none"
            />
          </div>

          {/* RIGHT — content */}
          <div className="zx-reveal">
            <SectionKicker>Fire &amp; Smoke</SectionKicker>
            {fire?.alert_text && (
              <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-signal-amber/30 bg-signal-amber/10 px-3 py-1.5 text-xs font-semibold text-signal-amber">
                <Flame size={13} />
                {fire.alert_text}
              </div>
            )}
            <h2 className="break-words font-display text-4xl font-semibold leading-tight text-white sm:text-5xl">
              <MultilineText text={fire?.heading || "Smart fire & smoke detection."} highlightAfterFirst />
            </h2>
            <p className="mt-5 text-lg leading-relaxed text-ink-300">
              {fire?.description ||
                "Detect potential fire and smoke events early. A dedicated model watches your streams, verifies the signature, saves a snapshot and raises an alert for review."}
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-2">
              {flow.map((s, i) => (
                <span key={s} className="flex items-center gap-2">
                  <span className="rounded-lg border border-signal-amber/30 bg-signal-amber/[0.06] px-3 py-1.5 font-mono text-[11px] uppercase tracking-wide text-signal-amber">
                    {s}
                  </span>
                  {i < flow.length - 1 && <ArrowRight size={13} className="text-ink-600" />}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------- how it works ---------- */
function HowItWorks() {
  return (
    <section id="how-it-works" className="border-y border-white/8 bg-white/[0.015] px-5 py-24 sm:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="max-w-2xl zx-reveal">
          <SectionKicker>How It Works</SectionKicker>
          <h2 className="font-display text-4xl font-semibold leading-tight text-white sm:text-5xl">
            Five steps to intelligent monitoring.
          </h2>
        </div>
        <div className="mt-14 grid gap-4 md:grid-cols-5">
          {STEPS.map((s, i) => (
            <div key={s.n} className="zx-reveal relative">
              <div className="zx-card h-full rounded-2xl p-5">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-sm text-accent-cyan">{s.n}</span>
                  <s.icon size={18} className="text-ink-400" />
                </div>
                <p className="mt-6 font-display text-base font-semibold tracking-wide text-white">
                  {s.title}
                </p>
                <p className="mt-1.5 text-[13px] leading-relaxed text-ink-400">{s.text}</p>
              </div>
              {i < STEPS.length - 1 && (
                <ChevronDown
                  size={16}
                  className="mx-auto my-2 text-ink-600 md:absolute md:-right-3 md:top-1/2 md:my-0 md:-translate-y-1/2 md:-rotate-90"
                />
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------- plans & pricing (module packages + live pricing, combined) ---------- */
function PricingSection({ data, loading, error, onRetry, content }) {
  const [yearly, setYearly] = useState(false);
  const packages = data?.packages || [];
  const addons = data?.addons || [];

  return (
    <section id="pricing" className="border-y border-white/8 bg-white/[0.015] px-5 py-24 sm:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-end">
          <div className="max-w-2xl zx-reveal">
            <SectionKicker>Plans &amp; Pricing</SectionKicker>
            <h2 className="font-display text-4xl font-semibold leading-tight text-white sm:text-5xl">
              Only pay for what you need.
            </h2>
            <p className="mt-4 text-ink-400">
              Cameras, People, Security &amp; Detection and Reports — each with its included modules,
              priced live from the {BRAND} configuration, never hardcoded.
            </p>
          </div>

          <div className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.03] p-1 text-sm">
            <button
              type="button"
              onClick={() => setYearly(false)}
              className={`zx-cta rounded-full px-4 py-1.5 font-semibold ${!yearly ? "bg-accent-cyan text-base-950" : "text-ink-300"}`}
            >
              Monthly
            </button>
            <button
              type="button"
              onClick={() => setYearly(true)}
              className={`zx-cta rounded-full px-4 py-1.5 font-semibold ${yearly ? "bg-accent-cyan text-base-950" : "text-ink-300"}`}
            >
              Yearly
            </button>
          </div>
        </div>

        {loading && (
          <div className="mt-14 flex items-center justify-center gap-3 py-12 text-ink-400">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-accent-cyan" />
            Loading live pricing…
          </div>
        )}

        {error && !loading && (
          <div className="mt-14 rounded-2xl border border-signal-red/30 bg-signal-red/[0.06] p-8 text-center">
            <p className="text-ink-200">Couldn&apos;t load pricing right now.</p>
            <button
              type="button"
              onClick={onRetry}
              className="zx-cta mt-4 inline-flex items-center gap-2 rounded-full border border-white/15 px-5 py-2 text-sm font-semibold text-ink-100"
            >
              Retry
            </button>
          </div>
        )}

        {!loading && !error && (
          <>
            <div className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-4">
              {packages.map((p) => {
                const Icon = PACKAGE_ICON[p.package_key] || LayoutGrid;
                const available = p.enabled !== false;
                const monthly = Number(p.monthly_price || 0);
                const year = Number(p.yearly_price || 0);
                const price = yearly ? year : monthly;
                const saving = monthly * 12 - year;
                return (
                  <div
                    key={p.package_key}
                    className={`zx-card zx-reveal flex flex-col rounded-2xl p-6 ${
                      p.package_key === "security" ? "!border-accent-cyan/40" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <Icon size={20} className="text-accent-cyan" />
                      {p.package_key === "security" && (
                        <span className="rounded-full bg-accent-cyan/15 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-accent-cyan">
                          Popular
                        </span>
                      )}
                    </div>
                    <p className="mt-4 font-display text-lg font-semibold text-white">{p.name}</p>

                    {available ? (
                      <div className="mt-3">
                        <p className="font-display text-3xl font-semibold text-white">
                          {inr(price)}
                          <span className="text-sm font-normal text-ink-400"> / {yearly ? "year" : "month"}</span>
                        </p>
                        <p className="mt-1 text-[12px] text-ink-500">
                          {yearly
                            ? `${inr(monthly)} / mo billed monthly`
                            : `${inr(year)} / yr billed yearly`}
                        </p>
                        {yearly && saving > 0 && (
                          <p className="mt-1 font-mono text-[11px] text-signal-green">Save {inr(saving)} / yr</p>
                        )}
                      </div>
                    ) : (
                      <p className="mt-3 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-[12px] text-ink-400">
                        Currently unavailable
                      </p>
                    )}

                    <ul className="mt-5 space-y-2 border-t border-white/8 pt-4">
                      {(p.submodules || []).map((s) => (
                        <li key={s.submodule_key} className="flex items-center gap-2 text-[13px] text-ink-300">
                          <Check size={13} className="shrink-0 text-signal-green" />
                          {s.label}
                        </li>
                      ))}
                    </ul>

                    <div className="mt-6 pt-2">
                      {available ? (
                        <PrimaryCta className="w-full !py-2.5 !text-[13px]">Get Started</PrimaryCta>
                      ) : (
                        <span className="inline-flex w-full cursor-not-allowed items-center justify-center rounded-full border border-white/10 px-6 py-2.5 text-[13px] font-semibold text-ink-500">
                          Unavailable
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <AddonsBlock addons={addons} yearly={yearly} extendPlatform={content?.extend_platform} />
          </>
        )}
      </div>
    </section>
  );
}

// `extendPlatform` is api/website_content.py's "extend_platform" section
// (monthly_price/yearly_price) — a single Super-Admin-set headline figure,
// completely separate from `addons` (the per-item BillableItem catalog
// below it, unchanged). Follows the same `yearly` toggle as the rest of
// this section, so it flips in lockstep with the Monthly/Yearly switch
// above instead of needing its own.
function AddonsBlock({ addons, yearly, extendPlatform }) {
  if (!addons?.length) return null;
  const monthly = Number(extendPlatform?.monthly_price || 0);
  const year = Number(extendPlatform?.yearly_price || 0);
  const startingPrice = yearly ? year : monthly;
  return (
    <div className="mt-16 zx-reveal">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h3 className="font-display text-2xl font-semibold text-white">Extend your platform</h3>
          <p className="mt-2 text-ink-400">Add-on modules, priced from the same {BRAND} configuration.</p>
        </div>
        {startingPrice > 0 && (
          <p className="font-display text-lg font-semibold text-white">
            Starting from {inr(startingPrice)}
            <span className="text-sm font-normal text-ink-400"> / {yearly ? "year" : "month"}</span>
          </p>
        )}
      </div>
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {addons.map((a) => {
          const Icon = ADDON_ICON[a.category] || Zap;
          const price = yearly ? Number(a.yearly_price || 0) : Number(a.monthly_price || 0);
          return (
            <div key={a.item_key} className="zx-card rounded-xl p-5">
              <div className="flex items-center gap-2">
                <Icon size={16} className="text-accent-cyan" />
                <p className="text-sm font-semibold text-white">{a.name}</p>
              </div>
              <p className="mt-1 text-[12px] text-ink-500">{a.category}</p>
              <p className="mt-3 font-display text-xl font-semibold text-white">
                {inr(price)}
                <span className="text-[12px] font-normal text-ink-400">
                  {unitSuffix(a.unit_type)} / {yearly ? "yr" : "mo"}
                </span>
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- contact ---------- */
// Icons are fixed per row (Website Settings only edits the text); values
// fall back to the same copy api/website_content.py's DEFAULTS ships, so
// this list is correct even before content has loaded.
function contactDetails(contact) {
  return [
    { icon: Mail, label: "Email", value: contact?.email || "support@zynez.ai" },
    { icon: Phone, label: "Phone", value: contact?.phone || "+91 98765 43210" },
    { icon: MapPin, label: "Location", value: contact?.location || "Bengaluru, India" },
    { icon: LifeBuoy, label: "Support", value: contact?.info_text || "24/7 available" },
  ];
}

function FormField({ label, name, type = "text", as = "input", ...rest }) {
  const Comp = as;
  return (
    <label className="block">
      <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.18em] text-ink-500">
        {label}
      </span>
      <Comp
        name={name}
        type={as === "input" ? type : undefined}
        className="w-full rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm text-ink-100 outline-none transition-colors placeholder:text-ink-600 focus:border-accent-cyan/50 focus:bg-white/[0.05]"
        {...rest}
      />
    </label>
  );
}

function ContactSection({ content }) {
  const contact = content?.contact;
  const [form, setForm] = useState({ name: "", phone: "", address: "", email: "" });
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
  };

  // Same lead-capture backend as the Interest & Lead popup (POST
  // /public/leads, api/leads.py) — tagged source: "Contact Page" so
  // Super Admin > Leads can tell the two forms apart. A duplicate phone
  // number (e.g. this same visitor already used the popup) updates
  // that existing lead in place rather than erroring out or creating a
  // second row — see create_lead()'s docstring.
  const handleSubmit = (e) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);

    // Real GPS location (browser Geolocation API) — entirely optional;
    // getBrowserLocation() never rejects, so a denied/unavailable/timed-
    // out/errored request still resolves to null coordinates and this
    // submission proceeds exactly as before. See src/lib/geolocation.js.
    getBrowserLocation()
      .then((coords) => axios.post(`${API_BASE_URL}/public/leads`, { ...form, source: "Contact Page", ...coords }))
      .then(() => setSent(true))
      .catch((err) => setError(err.response?.data?.message || "Something went wrong. Please try again."))
      .finally(() => setSubmitting(false));
  };

  return (
    <section
      id="contact"
      className="relative overflow-hidden border-t border-white/8 px-5 py-24 sm:px-8"
    >
      <div className="pointer-events-none absolute inset-0 zx-grid opacity-40" aria-hidden />
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(45rem_28rem_at_20%_10%,rgba(34,211,238,0.10),transparent_60%),radial-gradient(40rem_26rem_at_85%_90%,rgba(59,130,246,0.10),transparent_60%)]"
        aria-hidden
      />
      <div className="relative mx-auto max-w-7xl">
        <div className="max-w-2xl zx-reveal">
          <SectionKicker>Contact</SectionKicker>
          <h2 className="break-words font-display text-4xl font-semibold leading-tight text-white sm:text-5xl">
            <MultilineText text={contact?.heading || "Let's Make Your Cameras Smarter."} highlightAfterFirst />
          </h2>
          <p className="mt-4 text-lg text-ink-300">
            {contact?.description || `Have questions about ${BRAND}? Our team is ready to help.`}
          </p>
        </div>

        {/* Same minmax(0,...) fix as Hero's grid above — lets a long
            Website Settings heading/description wrap within its column
            instead of overflowing. */}
        <div className="mt-14 grid gap-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:gap-10">
          {/* LEFT — contact details */}
          <div className="zx-reveal flex flex-col gap-4">
            {contactDetails(contact).map((d) => (
              <div key={d.label} className="zx-card flex items-center gap-4 rounded-2xl p-5">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-accent-cyan/25 bg-accent-cyan/10 text-accent-cyan">
                  <d.icon size={18} />
                </span>
                <div className="min-w-0">
                  <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-500">
                    {d.label}
                  </p>
                  <p className="mt-0.5 truncate text-sm font-semibold text-white">{d.value}</p>
                </div>
              </div>
            ))}
          </div>

          {/* RIGHT — contact form */}
          <div className="zx-card zx-reveal relative overflow-hidden rounded-2xl p-6 sm:p-8">
            <div
              className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-accent-cyan/10 blur-3xl"
              aria-hidden
            />
            {sent ? (
              <div className="flex min-h-[280px] flex-col items-center justify-center text-center">
                <span className="grid h-12 w-12 place-items-center rounded-full bg-signal-green/15 text-signal-green">
                  <Check size={22} />
                </span>
                <p className="mt-4 font-display text-lg font-semibold text-white">
                  Thanks, {form.name.split(" ")[0] || "there"}!
                </p>
                <p className="mt-1 text-sm text-ink-400">
                  We&rsquo;ve got your details — our team will be in touch shortly.
                </p>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="relative grid gap-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField
                    label="Name"
                    name="name"
                    value={form.name}
                    onChange={handleChange}
                    placeholder="Your name"
                    required
                  />
                  <FormField
                    label="Phone Number"
                    name="phone"
                    type="tel"
                    value={form.phone}
                    onChange={handleChange}
                    placeholder="10-digit phone number"
                    required
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField
                    label="Address (optional)"
                    name="address"
                    value={form.address}
                    onChange={handleChange}
                    placeholder="City, state"
                  />
                  <FormField
                    label="Email (optional)"
                    name="email"
                    type="email"
                    value={form.email}
                    onChange={handleChange}
                    placeholder="you@company.com"
                  />
                </div>

                {error && (
                  <div className="flex items-start gap-2 rounded-xl border border-signal-red/30 bg-signal-red/10 px-3.5 py-2.5 text-xs text-signal-red">
                    <AlertCircleIcon />
                    <span>{error}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={submitting}
                  className="zx-cta zx-cta-primary mt-1 inline-flex items-center justify-center gap-2 rounded-full bg-gradient-to-r from-accent-cyan to-accent-blue px-6 py-3 text-sm font-semibold text-base-950 disabled:opacity-60"
                >
                  {submitting ? (
                    <>
                      <Loader2 size={16} className="animate-spin" />
                      Submitting…
                    </>
                  ) : (
                    <>
                      Send Details
                      <ArrowRight size={16} />
                    </>
                  )}
                </button>
              </form>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------- footer ---------- */
function Footer({ content }) {
  const general = content?.general;
  const websiteName = general?.website_name || BRAND;
  const cols = [
    {
      title: "Product",
      links: [
        ["AI Detection", "#detection"],
        ["How It Works", "#how-it-works"],
        ["Pricing", "#pricing"],
      ],
    },
    {
      title: "Company",
      links: [
        ["About", "#detection"],
        ["Contact", "#contact"],
      ],
    },
    {
      title: "Resources",
      links: [
        ["Login", LOGIN_PATH],
        ["Get Started", LOGIN_PATH],
      ],
    },
    {
      title: "Legal",
      links: [
        ["Privacy Policy", "#contact"],
        ["Terms", "#contact"],
      ],
    },
  ];
  const isRoute = (href) => href.startsWith("/");
  return (
    <footer className="border-t border-white/8 bg-base-950 px-5 py-14 sm:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,2fr)]">
          <div>
            <Logo className="h-14 w-auto" src={general?.logo_url} alt={`${websiteName} — AI Camera Surveillance`} />
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-ink-400">
              {general?.footer_text ||
                `${BRAND} — AI-powered camera surveillance that detects, understands and responds to events in real time.`}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-8 sm:grid-cols-4">
            {cols.map((c) => (
              <div key={c.title}>
                <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-500">{c.title}</p>
                <ul className="mt-3 space-y-2">
                  {c.links.map(([label, href]) => (
                    <li key={label}>
                      {isRoute(href) ? (
                        <Link to={href} className="text-sm text-ink-300 hover:text-white">
                          {label}
                        </Link>
                      ) : (
                        <a href={href} className="text-sm text-ink-300 hover:text-white">
                          {label}
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-12 flex flex-col items-center justify-between gap-3 border-t border-white/8 pt-6 sm:flex-row">
          <p className="text-[13px] text-ink-500">© {new Date().getFullYear()} {websiteName}. All rights reserved.</p>
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-600">
            AI · Security · Surveillance
          </p>
        </div>
      </div>
    </footer>
  );
}

/* ---------- Interest & Lead popup ----------
   Anonymous visitor capture: shown automatically a few seconds after
   landing OR as soon as the visitor scrolls/interacts, whichever comes
   first — "Interested & Lead" reveals a short form (Name + Phone
   required, Address + Email optional) that POSTs to the existing
   backend (POST /public/leads, api/leads.py), surfaced to the Super
   Admin at /super-admin/leads. "Skip" just closes it and the visitor
   continues browsing normally. Shown at most once per browser tab
   session (sessionStorage) — dismissing or submitting it never
   interrupts the same visit again, but a fresh visit later still gets
   the chance to convert.

   Rendered as a floating panel, not a full-screen modal: a right-side
   card on larger screens, a bottom sheet on mobile. There is no
   backdrop and body scroll is never locked, so the rest of the landing
   page stays visible and interactive while it's open — only the panel
   itself (`pointer-events-auto`) captures clicks, its fixed wrapper is
   `pointer-events-none` so the empty space around it never blocks the
   page underneath. */
const LEAD_POPUP_SESSION_KEY = "zx_lead_popup_seen_at";
const LEAD_POPUP_DELAY_MS = 4000;
const LEAD_POPUP_SCROLL_PX = 260;
// A dismissed/submitted popup is suppressed for this long, not for the
// rest of the tab's life — a plain boolean flag would otherwise stay
// "seen" for as long as the tab stays open (hours, even days), which
// reads as the popup being permanently broken on every reload after
// the first time it showed. Storing *when* it last showed and re-
// arming once this window elapses keeps the "don't nag on every
// reload" behavior for a real visit while guaranteeing it can never
// get stuck — reloading later in the same tab, or opening a new tab,
// both show it again.
const LEAD_POPUP_RESHOW_AFTER_MS = 30 * 60 * 1000;

function LeadPopup() {
  const [stage, setStage] = useState("hidden"); // hidden | prompt | form | success
  const [form, setForm] = useState({ name: "", phone: "", address: "", email: "" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alreadySeen = false;
    try {
      const seenAt = Number(sessionStorage.getItem(LEAD_POPUP_SESSION_KEY));
      alreadySeen = Number.isFinite(seenAt) && seenAt > 0 && Date.now() - seenAt < LEAD_POPUP_RESHOW_AFTER_MS;
    } catch {
      // Private-browsing / storage-disabled — fail open, popup still shows.
    }
    if (alreadySeen) return;

    let shown = false;
    const reveal = () => {
      if (shown) return;
      shown = true;
      setStage("prompt");
    };

    const timer = window.setTimeout(reveal, LEAD_POPUP_DELAY_MS);
    const onScroll = () => {
      if (window.scrollY > LEAD_POPUP_SCROLL_PX) reveal();
    };
    const onInteract = () => reveal();

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pointerdown", onInteract, { passive: true, once: true });

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pointerdown", onInteract);
    };
  }, []);

  useEffect(() => {
    if (stage === "hidden") return;
    try {
      sessionStorage.setItem(LEAD_POPUP_SESSION_KEY, String(Date.now()));
    } catch {
      // Nothing to do if storage is unavailable — it just shows again
      // next reload, which is harmless.
    }
    // No body-scroll lock — this is a floating panel, not a full-screen
    // modal, so the landing page stays scrollable and usable behind it.
  }, [stage]);

  const close = () => setStage("hidden");

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);

    // Real GPS location (browser Geolocation API) — entirely optional;
    // getBrowserLocation() never rejects, so a denied/unavailable/timed-
    // out/errored request still resolves to null coordinates and this
    // submission proceeds exactly as before. See src/lib/geolocation.js.
    getBrowserLocation()
      .then((coords) => axios.post(`${API_BASE_URL}/public/leads`, { ...form, source: "Landing Page", ...coords }))
      .then(() => setStage("success"))
      .catch((err) => setError(err.response?.data?.message || "Something went wrong. Please try again."))
      .finally(() => setSubmitting(false));
  };

  if (stage === "hidden") return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex justify-center sm:inset-x-auto sm:inset-y-0 sm:right-0 sm:items-center sm:justify-end sm:p-6">
      <div
        role="dialog"
        aria-label={`Interested in ${BRAND}?`}
        className="zx-lead-panel zx-lead-card pointer-events-auto relative w-full max-h-[82vh] overflow-y-auto overscroll-contain rounded-t-2xl p-6 shadow-2xl sm:max-h-[calc(100vh-3rem)] sm:w-[380px] sm:rounded-2xl sm:p-7"
      >
        <button
          type="button"
          onClick={close}
          aria-label="Close"
          className="absolute right-4 top-4 rounded-full p-1.5 text-ink-500 transition-colors hover:bg-white/5 hover:text-white"
        >
          <X size={18} />
        </button>

        {stage === "prompt" && (
          <>
            <SectionKicker>Stay In The Loop</SectionKicker>
            <h3 className="pr-6 font-display text-2xl font-semibold leading-tight text-white">
              Interested in {BRAND}?
            </h3>
            <p className="mt-3 text-sm leading-relaxed text-ink-300">
              Leave your details and our team will reach out with pricing, a demo, or answers to any
              questions — no commitment required.
            </p>
            <div className="mt-7 flex flex-col gap-3">
              <button
                type="button"
                onClick={() => setStage("form")}
                className="zx-cta zx-cta-primary inline-flex items-center justify-center gap-2 rounded-full bg-gradient-to-r from-accent-cyan to-accent-blue px-6 py-3 text-sm font-semibold text-base-950"
              >
                Interested &amp; Lead
                <ArrowRight size={16} />
              </button>
              <button
                type="button"
                onClick={close}
                className="zx-cta inline-flex items-center justify-center gap-2 rounded-full border border-white/15 bg-white/[0.02] px-6 py-3 text-sm font-semibold text-ink-100 hover:border-white/30 hover:text-white"
              >
                Skip
              </button>
            </div>
          </>
        )}

        {stage === "form" && (
          <>
            <SectionKicker>Interested &amp; Lead</SectionKicker>
            <h3 className="pr-6 font-display text-2xl font-semibold leading-tight text-white">
              Tell us how to reach you.
            </h3>
            <form onSubmit={handleSubmit} className="mt-6 grid gap-4">
              <FormField
                label="Name"
                name="name"
                value={form.name}
                onChange={handleChange}
                placeholder="Your name"
                required
              />
              <FormField
                label="Phone Number"
                name="phone"
                type="tel"
                value={form.phone}
                onChange={handleChange}
                placeholder="10-digit phone number"
                required
              />
              <FormField
                label="Address (optional)"
                name="address"
                value={form.address}
                onChange={handleChange}
                placeholder="City, state"
              />
              <FormField
                label="Email (optional)"
                name="email"
                type="email"
                value={form.email}
                onChange={handleChange}
                placeholder="you@company.com"
              />

              {error && (
                <div className="flex items-start gap-2 rounded-xl border border-signal-red/30 bg-signal-red/10 px-3.5 py-2.5 text-xs text-signal-red">
                  <AlertCircleIcon />
                  <span>{error}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="zx-cta zx-cta-primary mt-1 inline-flex items-center justify-center gap-2 rounded-full bg-gradient-to-r from-accent-cyan to-accent-blue px-6 py-3 text-sm font-semibold text-base-950 disabled:opacity-60"
              >
                {submitting ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    Submitting…
                  </>
                ) : (
                  <>
                    Submit
                    <ArrowRight size={16} />
                  </>
                )}
              </button>
            </form>
          </>
        )}

        {stage === "success" && (
          <div className="flex flex-col items-center py-6 text-center">
            <span className="grid h-12 w-12 place-items-center rounded-full bg-signal-green/15 text-signal-green">
              <Check size={22} />
            </span>
            <p className="mt-4 font-display text-lg font-semibold text-white">Thanks, {form.name.split(" ")[0] || "there"}!</p>
            <p className="mt-1 text-sm text-ink-400">We&rsquo;ve got your details — our team will be in touch shortly.</p>
            <button
              type="button"
              onClick={close}
              className="zx-cta mt-6 inline-flex items-center justify-center gap-2 rounded-full border border-white/15 bg-white/[0.02] px-6 py-2.5 text-sm font-semibold text-ink-100 hover:border-white/30 hover:text-white"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Tiny inline substitute for lucide's AlertTriangle so this file's import
// list doesn't need touching just for one error banner's icon.
function AlertCircleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="mt-0.5 shrink-0">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

/* ============================================================ */
export default function Landing() {
  const revealRef = useReveal();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // Website Settings content (Super Admin > System Settings > Website
  // Settings, api/website_content.py) — every heading/description/image/
  // contact detail below. `content` stays null while loading or on
  // error; every section component falls back to its original hardcoded
  // copy in that case, so the page never renders blank or broken (see
  // each section's `content?.section?.field || "..."` fallback).
  const [content, setContent] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(false);
    axios
      .get(`${API_BASE_URL}/public/pricing`)
      .then((res) => setData(res.data))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    axios
      .get(`${API_BASE_URL}/public/website-content`)
      .then((res) => setContent(res.data))
      .catch(() => {
        // Silent — every section already falls back to its bundled
        // default copy, so a failed fetch here never breaks the page.
      });
  }, []);

  useEffect(() => {
    const prev = document.title;
    const websiteName = content?.general?.website_name || BRAND;
    document.title = `${websiteName} — AI Camera Surveillance`;
    return () => {
      document.title = prev;
    };
  }, [content]);

  return (
    <div ref={revealRef} className="zynez-landing zx-ambient min-h-screen">
      <Header content={content} />
      <main>
        <Hero content={content} />
        <TechStrip />
        <DetectionSection content={content} />
        <UnknownSection content={content} />
        <FireSection content={content} />
        <HowItWorks />
        <PricingSection data={data} loading={loading} error={error} onRetry={load} content={content} />
        <ContactSection content={content} />
      </main>
      <Footer content={content} />
      <LeadPopup />
    </div>
  );
}
