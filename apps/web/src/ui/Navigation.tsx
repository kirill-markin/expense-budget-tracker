"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { NAV_LINKS } from "@/lib/navigation";

export const Navigation = (): ReactElement => {
  const pathname = usePathname();
  const { t } = useTranslation();
  const navRef = useRef<HTMLElement>(null);
  const [overflow, setOverflow] = useState({ start: false, end: true });

  useEffect(() => {
    const nav = navRef.current;
    if (nav === null) return;
    const updateOverflow = (): void => {
      const bounds = nav.getBoundingClientRect();
      const first = nav.firstElementChild?.getBoundingClientRect();
      const last = nav.lastElementChild?.getBoundingClientRect();
      if (first === undefined || last === undefined) return;
      const rtl = getComputedStyle(nav).direction === "rtl";
      // Bounds work for either direction without depending on RTL scrollLeft modes.
      const start = rtl ? first.right > bounds.right + 1 : first.left < bounds.left - 1;
      const end = rtl ? last.left < bounds.left - 1 : last.right > bounds.right + 1;
      setOverflow((previous) => previous.start === start && previous.end === end
        ? previous
        : { start, end });
    };
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(nav);
    Array.from(nav.children).forEach((link) => observer.observe(link));
    nav.addEventListener("scroll", updateOverflow, { passive: true });
    updateOverflow();
    return () => {
      observer.disconnect();
      nav.removeEventListener("scroll", updateOverflow);
    };
  }, [t]);

  useEffect(() => {
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (nav === null || active === undefined || active === null) return;
    // Scroll only the tab strip; scrollIntoView can also move the app's viewport.
    const tabBounds = active.getBoundingClientRect();
    const navBounds = nav.getBoundingClientRect();
    const navStyle = getComputedStyle(nav);
    const rtl = navStyle.direction === "rtl";
    const startPadding = parseFloat(navStyle.scrollPaddingInlineStart) || 0;
    const endPadding = parseFloat(navStyle.scrollPaddingInlineEnd) || 0;
    const leftPadding = rtl ? endPadding : startPadding;
    const rightPadding = rtl ? startPadding : endPadding;
    if (tabBounds.left < navBounds.left + leftPadding || tabBounds.right > navBounds.right - rightPadding) {
      nav.scrollBy({ left: tabBounds.left - navBounds.left - (navBounds.width - tabBounds.width) / 2 });
    }
  }, [pathname, t]);

  return (
    <div className="nav-scroll" data-scroll-start={overflow.start} data-scroll-end={overflow.end}>
      <nav className="nav" ref={navRef}>
        {NAV_LINKS.map((link) => {
          const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
          return (
            <Link key={link.href} href={link.href} aria-current={active ? "page" : undefined}>
              {t(link.labelKey)}
            </Link>
          );
        })}
      </nav>
    </div>
  );
};
