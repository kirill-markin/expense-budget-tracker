"use client";

import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";

type Props = Readonly<{
  authEnabled: boolean;
}>;

export const AccountMenu = (props: Props): ReactElement | null => {
  const { authEnabled } = props;
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const toggle = useCallback((): void => {
    setIsOpen((prev) => !prev);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handleMouseDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (
        menuRef.current !== null && !menuRef.current.contains(target) &&
        buttonRef.current !== null && !buttonRef.current.contains(target)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  const handleLogout = useCallback((): void => {
    window.location.href = "/api/auth/logout";
  }, []);

  if (!authEnabled) return null;

  return (
    <div className="account-menu-wrap">
      <button
        ref={buttonRef}
        className="account-menu-btn"
        type="button"
        onClick={toggle}
        aria-expanded={isOpen}
        aria-haspopup="true"
      >
        &#x2630;
      </button>
      {isOpen && (
        <div ref={menuRef} className="account-menu-dropdown">
          <button
            className="account-menu-item"
            type="button"
            onClick={handleLogout}
          >
            Logout
          </button>
        </div>
      )}
    </div>
  );
};
