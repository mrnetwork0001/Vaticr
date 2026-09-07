"use client";
/**
 * The section menu on small screens.
 *
 * The desktop nav is `lg:flex`, so below that breakpoint the landing page had
 * no navigation at all - every anchor link simply vanished. This is the same
 * list behind a disclosure button.
 *
 * It closes on selection, on Escape and on an outside click, because a menu
 * that stays open over the content it was meant to reach is worse than none.
 */

import { useEffect, useRef, useState } from "react";
import { Menu, X } from "lucide-react";

export default function MobileMenu({
  links,
}: {
  links: { id: string; label: string }[];
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative lg:hidden">
      <button
        type="button"
        aria-label={open ? "Close the menu" : "Open the menu"}
        aria-expanded={open}
        aria-controls="mobile-menu"
        onClick={() => setOpen((o) => !o)}
        className="rounded p-2 text-gray-400 transition hover:bg-ink-800 hover:text-gray-100"
      >
        {open ? <X size={18} aria-hidden /> : <Menu size={18} aria-hidden />}
      </button>

      {open && (
        <ul
          id="mobile-menu"
          className="card absolute right-0 z-50 mt-2 w-56 overflow-hidden p-1"
        >
          {links.map((l) => (
            <li key={l.id}>
              <a
                href={`#${l.id}`}
                onClick={() => setOpen(false)}
                className="block rounded px-3 py-2 text-[14px] text-gray-300 transition hover:bg-ink-800 hover:text-gray-100"
              >
                {l.label}
              </a>
            </li>
          ))}
          <li className="mt-1 border-t border-ink-700 pt-1">
            <a
              href="/dashboard"
              className="block rounded px-3 py-2 text-[14px] font-semibold text-model transition hover:bg-ink-800"
            >
              Launch app →
            </a>
          </li>
        </ul>
      )}
    </div>
  );
}
