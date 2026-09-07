/** Sticky top nav: wordmark, section anchors, and the way into the app. */
const LINKS = [
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
        <a href="#top" className="flex items-center gap-2" aria-label="Vaticr, back to top">
          <span aria-hidden className="text-base">🔮</span>
          <span className="font-mono text-[15px] font-bold tracking-tight text-gray-100">vaticr</span>
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
        <div className="ml-auto flex items-center gap-2 lg:ml-3">
          <a
            href="https://github.com/mrnetwork0001/Vaticr"
            target="_blank"
            rel="noreferrer"
            className="hidden rounded border border-ink-700 px-3 py-1.5 font-mono text-xs text-gray-300 transition hover:border-gray-600 hover:text-gray-100 sm:block"
          >
            source
          </a>
          <a
            href="/dashboard"
            className="rounded bg-model px-3 py-1.5 font-mono text-xs font-bold text-ink-950 transition hover:bg-model/90"
          >
            Launch app →
          </a>
        </div>
      </div>
    </nav>
  );
}
