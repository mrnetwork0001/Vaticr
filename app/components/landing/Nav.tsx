/** Sticky top nav: wordmark, section anchors, and the way into the app. */
import MobileMenu from "./MobileMenu";

export const LINKS = [
  { id: "how", label: "How it works" },
  { id: "evidence", label: "Evidence" },
  { id: "mint", label: "Mint-a-pair" },
  { id: "findings", label: "Findings" },
  { id: "build", label: "Run it" },
];

export default function Nav() {
  return (
    <nav className="sticky top-0 z-40 border-b border-ink-700/80 bg-ink-950/90 backdrop-blur" aria-label="Sections">
      <div className="mx-auto flex h-14 max-w-nav items-center gap-3 px-4 sm:px-6">
        <a href="#top" className="flex items-center" aria-label="Vaticr, back to top">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/vaticr-header.png"
            alt="Vaticr - price the window, trade the gap"
            width={720}
            height={148}
            className="h-7 w-auto"
          />
        </a>
        <ul className="ml-auto hidden items-center gap-1 lg:flex">
          {LINKS.map((l) => (
            <li key={l.id}>
              <a
                href={`#${l.id}`}
                className="rounded px-2 py-1 text-sm text-gray-400 transition hover:bg-ink-800 hover:text-gray-100"
              >
                {l.label}
              </a>
            </li>
          ))}
        </ul>
        <div className="ml-auto lg:hidden">
          <MobileMenu links={LINKS} />
        </div>
      </div>
    </nav>
  );
}
