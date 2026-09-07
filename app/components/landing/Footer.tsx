/**
 * Footer: brand block on the left, three mono link columns on the right.
 *
 * The columns are ordered by who is reading. PRODUCT is for someone who wants
 * to use it, RESOURCES for someone who wants to check whether the claims hold,
 * ECOSYSTEM for the protocol this is built on and does not own.
 */
import { Github } from "lucide-react";

const GITHUB = "https://github.com/mrnetwork0001/Vaticr";
const BLOB = `${GITHUB}/blob/main`;
const EXPLORER = "https://shannon-explorer.somnia.network";
const REGISTRY = "0x3D04ff026A4Dc553a2ae9071dbc238a40D24b27A";

const COLUMNS: { heading: string; links: { label: string; href: string }[] }[] = [
  {
    heading: "Product",
    links: [
      { label: "Launch app", href: "/dashboard" },
      { label: "How it works", href: "#how" },
      { label: "Does the model work?", href: "#evidence" },
      { label: "Mint-a-pair", href: "#mint" },
      { label: "Run it yourself", href: "#build" },
    ],
  },
  {
    heading: "Resources",
    links: [
      { label: "README", href: `${BLOB}/README.md` },
      { label: "Architecture note", href: `${BLOB}/docs/ARCHITECTURE.md` },
      { label: "SDK feedback report", href: `${BLOB}/docs/SDK_FEEDBACK.md` },
      { label: "API reference", href: `${BLOB}/docs/API.md` },
      { label: "Backtest, 900 forecasts", href: `${BLOB}/docs/evidence/backtest-2026-09-04.json` },
      { label: "114 tests", href: `${GITHUB}/tree/main/tests` },
    ],
  },
  {
    heading: "Ecosystem",
    links: [
      { label: "DreamDEX Event Contracts", href: "https://docs.dreamdex.io/developers/event-contracts" },
      { label: "dreamDEX Bot Kit", href: "https://github.com/somnia-chain/dreamdex-bot-kit" },
      { label: "Somnia Network", href: "https://somnia.network" },
      { label: "markets-sdk", href: "https://www.npmjs.com/package/@somnia-chain/markets-sdk" },
      { label: "Forecast registry", href: `${EXPLORER}/address/${REGISTRY}` },
      { label: "Event Contracts Hackathon", href: "https://dorahacks.io/hackathon/event-contracts/detail" },
    ],
  },
];

function FooterLink({ label, href }: { label: string; href: string }) {
  const cls = "block py-0.5 text-[14.5px] leading-snug text-gray-300 transition hover:text-model";
  const external = !href.startsWith("/") && !href.startsWith("#");
  return (
    <a href={href} className={cls} {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>
      {label}
    </a>
  );
}

export default function Footer() {
  return (
    <footer className="border-t border-ink-700/70 bg-ink-950 pb-14 pt-14">
      <div className="mx-auto max-w-page px-4 sm:px-6">
        <div className="grid gap-y-9 md:grid-cols-[1.4fr_1fr_1fr_1fr] md:gap-8">
          {/* brand */}
          <div className="max-w-md">
            <a href="#top" className="inline-block" aria-label="Vaticr, back to top">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/brand/vaticr-header.png"
                alt="Vaticr - price the window, trade the gap"
                width={720}
                height={148}
                className="h-12 w-auto sm:h-14"
              />
            </a>

            <p className="mt-8 text-[15px] leading-relaxed text-gray-400">
              Derives the fair probability of every DreamDEX Up/Down window on
              Somnia from the price process and the news, trades the gap, and
              commits each forecast on-chain before it settles - so the record
              can be checked, not taken on trust.
            </p>

            <div className="mt-8 flex items-center gap-4">
              <a
                href={GITHUB}
                target="_blank"
                rel="noreferrer"
                aria-label="Vaticr on GitHub"
                className="text-gray-400 transition hover:text-model"
              >
                <Github size={20} aria-hidden />
              </a>
            </div>
          </div>

          {COLUMNS.map((col) => (
            <nav key={col.heading} aria-label={col.heading}>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-model">
                {col.heading}
              </p>
              <ul className="mt-3.5 space-y-1.5">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <FooterLink {...l} />
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
      </div>
    </footer>
  );
}
