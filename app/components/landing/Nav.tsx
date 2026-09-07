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
      </div>
    </nav>
  );
}
